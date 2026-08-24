import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CallerOutputRequest {
	/** The exact file path selected by the caller. Omit it to skip output. */
	path?: string;
	/** The exact text to write. An empty string creates an empty output file. */
	content: string;
}

export type OutputStatus =
	| "not_requested"
	| "pending"
	| "written"
	| "collision"
	| "failed";

export type OutputWriteStatus = Exclude<OutputStatus, "pending">;

export const MAX_OUTPUT_ERROR_BYTES = 2 * 1024;
/** Caller output is rejected before filesystem work when it exceeds this bound. */
export const MAX_OUTPUT_CONTENT_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_PATH_BYTES = 16 * 1024;
const OUTPUT_ERROR_TRUNCATION_MARKER = "… [caller output error truncated] …";
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 250;

export type OutputWriteResult =
	| { status: "not_requested" }
	| { status: "written"; path: string }
	| { status: "collision"; path: string }
	| { status: "failed"; path: string; error: string };

export interface OutputFileHandle {
	writeFile(data: string, encoding: "utf8"): Promise<void>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

export interface OutputFileSystem {
	mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
	lstat(path: string): Promise<unknown>;
	open(path: string, flags: string, mode: number): Promise<OutputFileHandle>;
	link(oldPath: string, newPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

export interface OutputWriteOptions {
	/** Total deadline for output preparation, publication, and cleanup. */
	timeoutMs?: number;
	signal?: AbortSignal;
	maxContentBytes?: number;
	io?: Partial<OutputFileSystem>;
}

const defaultIo: OutputFileSystem = {
	mkdir: async (path, options) => {
		await fs.mkdir(path, options);
	},
	lstat: (path) => fs.lstat(path),
	open: async (path, flags, mode) => fs.open(path, flags, mode) as unknown as FileHandle,
	link: (oldPath, newPath) => fs.link(oldPath, newPath),
	unlink: (path) => fs.unlink(path),
};

function mergedIo(options: OutputWriteOptions): OutputFileSystem {
	return { ...defaultIo, ...options.io };
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function timeoutError(description: string): Error {
	const error = new Error(`${description} timed out.`);
	error.name = "TimeoutError";
	return error;
}

function abortError(reason: unknown): Error {
	const error = reason instanceof Error ? reason : new Error(reason === undefined ? "The operation was aborted." : String(reason));
	error.name = "AbortError";
	return error;
}

function bounded<T>(
	operation: Promise<T> | (() => Promise<T>),
	deadline: number,
	signal: AbortSignal | undefined,
	description: string,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = () => finish(() => reject(abortError(signal?.reason)));
		if (signal) {
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (deadline <= Date.now()) return finish(() => reject(timeoutError(description)));
		timer = setTimeout(
			() => finish(() => reject(timeoutError(description))),
			Math.max(1, Math.ceil(deadline - Date.now())),
		);
		timer.unref?.();
		let promise: Promise<T>;
		try {
			promise = typeof operation === "function" ? operation() : operation;
		} catch (error) {
			return finish(() => reject(error instanceof Error ? error : new Error(String(error))));
		}
		void promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
		);
	});
}

function cleanupBounded(operation: () => Promise<void>): Promise<void> {
	try {
		return bounded(operation, Date.now() + CLEANUP_TIMEOUT_MS, undefined, "Caller output cleanup").catch(() => {});
	} catch {
		return Promise.resolve();
	}
}

function temporaryName(): string {
	return `.pi-output.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
}

function utf8Width(codePoint: number): number {
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

function boundedUtf8Prefix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const characters: string[] = [];
	let bytes = 0;
	for (const character of value) {
		const width = utf8Width(character.codePointAt(0) ?? 0xfffd);
		if (bytes + width > maxBytes) break;
		characters.push(character);
		bytes += width;
	}
	return characters.join("");
}

/** Bound caller-visible errors without splitting a UTF-8 code point. */
export function boundOutputError(value: unknown): string {
	const text = value instanceof Error ? value.message : String(value);
	if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_ERROR_BYTES) return text;
	const markerBytes = Buffer.byteLength(
		OUTPUT_ERROR_TRUNCATION_MARKER,
		"utf8",
	);
	if (MAX_OUTPUT_ERROR_BYTES <= markerBytes)
		return boundedUtf8Prefix(text, MAX_OUTPUT_ERROR_BYTES);
	return `${boundedUtf8Prefix(
		text,
		MAX_OUTPUT_ERROR_BYTES - markerBytes,
	)}${OUTPUT_ERROR_TRUNCATION_MARKER}`;
}

function errorMessage(error: unknown): string {
	return boundOutputError(error);
}

/**
 * Writes caller-selected output without replacing an earlier deliverable.
 *
 * An omitted path returns `not_requested` and touches no filesystem path. A
 * supplied path creates missing parent directories, then publishes the exact
 * content as a mode-0600 file. An existing path returns `collision`, including
 * a path that appears during a concurrent write. Other filesystem errors return
 * `failed`. The writer writes a same-directory temporary file, syncs it, and
 * publishes it with an exclusive hard link, so a published file is complete.
 */
export async function writeCallerOutput(
	request: CallerOutputRequest,
	options: OutputWriteOptions = {},
): Promise<OutputWriteResult> {
	if (request.path === undefined) return { status: "not_requested" };
	const path = typeof request.path === "string" ? request.path : "";
	if (!path) {
		return {
			status: "failed",
			path,
			error: "The caller output path must be a non-empty string.",
		};
	}
	if (Buffer.byteLength(path, "utf8") > MAX_OUTPUT_PATH_BYTES) {
		return {
			status: "failed",
			path,
			error: `The caller output path exceeds ${MAX_OUTPUT_PATH_BYTES} bytes.`,
		};
	}
	if (typeof request.content !== "string") {
		return {
			status: "failed",
			path,
			error: "The caller output content must be a string.",
		};
	}
	const maxContentBytes = Math.min(
		MAX_OUTPUT_CONTENT_BYTES,
		positiveLimit(options.maxContentBytes, MAX_OUTPUT_CONTENT_BYTES),
	);
	if (Buffer.byteLength(request.content, "utf8") > maxContentBytes) {
		return {
			status: "failed",
			path,
			error: `The caller output content exceeds ${maxContentBytes} bytes.`,
		};
	}

	const parent = dirname(path);
	const io = mergedIo(options);
	const deadline = Date.now() + positiveLimit(options.timeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
	try {
		await bounded(
			() => io.mkdir(parent, { recursive: true, mode: 0o700 }),
			deadline,
			options.signal,
			"Caller output directory creation",
		);
	} catch (error) {
		return { status: "failed", path, error: errorMessage(error) };
	}

	try {
		await bounded(() => io.lstat(path), deadline, options.signal, "Caller output collision check");
		return { status: "collision", path };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			return { status: "failed", path, error: errorMessage(error) };
	}

	const temporaryPath = join(parent, temporaryName());
	let handle: OutputFileHandle | undefined;
	try {
		handle = await bounded(
			() => io.open(temporaryPath, "wx", 0o600),
			deadline,
			options.signal,
			"Caller output temporary file creation",
		);
		await bounded(
			() => handle!.writeFile(request.content, "utf8"),
			deadline,
			options.signal,
			"Caller output write",
		);
		await bounded(() => handle!.sync(), deadline, options.signal, "Caller output sync");
		await bounded(() => handle!.close(), deadline, options.signal, "Caller output close");
		handle = undefined;
	} catch (error) {
		if (handle) await cleanupBounded(() => handle!.close());
		await cleanupBounded(() => io.unlink(temporaryPath));
		return { status: "failed", path, error: errorMessage(error) };
	}

	try {
		await bounded(() => io.link(temporaryPath, path), deadline, options.signal, "Caller output publication");
	} catch (error) {
		await cleanupBounded(() => io.unlink(temporaryPath));
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			return { status: "collision", path };
		return { status: "failed", path, error: errorMessage(error) };
	}

	// The hard link already published a complete target. Cleanup cannot change that result.
	await cleanupBounded(() => io.unlink(temporaryPath));
	return { status: "written", path };
}
