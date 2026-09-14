import { promises as fs } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** The health of the child session snapshot. */
export type TranscriptStatus =
	| "available"
	| "missing"
	| "incomplete"
	| "unreadable";

/** The normalized records that a transcript page can expose. */
export type TranscriptMessageRole = "user" | "assistant" | "error";

export interface TranscriptMessage {
	role: TranscriptMessageRole;
	text: string;
	timestamp?: number;
}

export interface TranscriptFileHandle {
	read(
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesRead: number }>;
	stat(): Promise<{ size: number }>;
	close(): Promise<void>;
}

export interface TranscriptFileSystem {
	open(path: string, flags: string): Promise<TranscriptFileHandle>;
}

export interface TranscriptOptions {
	/** How many of the most recent messages to return. The default is one. */
	numMessages?: number;
	/** Total deadline for an inspector-facing transcript snapshot. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Optional dependency injection for deterministic bounded-read tests. */
	io?: TranscriptFileSystem;
	/** Maximum tail window size. Values above the safe default are capped. */
	maxSnapshotBytes?: number;
	/** Maximum one JSONL record size. Values above the safe default are capped. */
	maxRecordBytes?: number;
}

export interface TranscriptResult {
	status: TranscriptStatus;
	/** The most recent messages, oldest first. */
	messages: TranscriptMessage[];
	/**
	 * Messages found inside the read window. It is not the transcript total,
	 * because a large file is read from its end.
	 */
	messagesInWindow: number;
	/** True when the reader started at a byte offset instead of the file start. */
	windowed: boolean;
}

const DEFAULT_MESSAGE_COUNT = 1;
const MAX_MESSAGE_COUNT = 50;
/** Valid records can exceed the previous 256 KiB limit, but not this bound. */
export const MAX_TRANSCRIPT_RECORD_BYTES = 2 * 1024 * 1024;
/** A read scans at most this many trailing bytes, even while the file grows. */
export const MAX_TRANSCRIPT_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 5_000;
const READ_CHUNK_BYTES = 64 * 1024;
const STRING_SCAN_CHUNK_CHARS = 16 * 1024;
const ERROR_FALLBACK = "Assistant response failed";
const CLEANUP_TIMEOUT_MS = 250;

type SessionRecord = Record<string, unknown>;

const defaultIo: TranscriptFileSystem = {
	open: (path, flags) => fs.open(path, flags),
};

function isRecord(value: unknown): value is SessionRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeCount(value: unknown): number {
	if (value === undefined || (typeof value === "number" && Number.isNaN(value)))
		return DEFAULT_MESSAGE_COUNT;
	if (typeof value !== "number") return DEFAULT_MESSAGE_COUNT;
	if (value === Number.POSITIVE_INFINITY) return MAX_MESSAGE_COUNT;
	if (value === Number.NEGATIVE_INFINITY) return 0;
	return Math.min(MAX_MESSAGE_COUNT, Math.max(0, Math.floor(value)));
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function normalizeOptions(options: TranscriptOptions | undefined): {
	numMessages: number;
} {
	return { numMessages: normalizeCount(options?.numMessages) };
}

function timestampFor(
	entry: SessionRecord,
	message: SessionRecord,
): number | undefined {
	const messageTimestamp = finiteNumber(message.timestamp);
	if (messageTimestamp !== undefined) return messageTimestamp;
	const entryTimestamp = finiteNumber(entry.timestamp);
	if (entryTimestamp !== undefined) return entryTimestamp;
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is SessionRecord =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text as string)
		.join("\n");
}

function withTimestamp(
	role: TranscriptMessageRole,
	text: string,
	timestamp: number | undefined,
): TranscriptMessage {
	return timestamp === undefined ? { role, text } : { role, text, timestamp };
}

function errorFromEntry(entry: SessionRecord): TranscriptMessage | undefined {
	if (entry.type !== "error") return undefined;
	const rawError = entry.error;
	const text =
		typeof rawError === "string"
			? rawError
			: isRecord(rawError) && typeof rawError.message === "string"
				? rawError.message
				: typeof entry.message === "string"
					? entry.message
					: "";
	if (!text) return undefined;
	return withTimestamp("error", text, timestampFor(entry, {}));
}

function messageFromEntry(
	entry: SessionRecord,
): { message?: TranscriptMessage; malformed: boolean } {
	const error = errorFromEntry(entry);
	if (error) return { message: error, malformed: false };
	if (entry.type !== "message") return { malformed: false };
	const rawMessage = entry.message;
	if (!isRecord(rawMessage) || typeof rawMessage.role !== "string")
		return { malformed: true };

	const timestamp = timestampFor(entry, rawMessage);
	if (rawMessage.role === "user") {
		const text = textFromContent(rawMessage.content);
		return text
			? { message: withTimestamp("user", text, timestamp), malformed: false }
			: { malformed: false };
	}

	if (rawMessage.role !== "assistant") return { malformed: false };
	const text = textFromContent(rawMessage.content);
	const errorMessage =
		typeof rawMessage.errorMessage === "string"
			? rawMessage.errorMessage
			: undefined;
	if (rawMessage.stopReason === "error" || errorMessage !== undefined) {
		return {
			message: withTimestamp(
				"error",
				(errorMessage || text || ERROR_FALLBACK),
				timestamp,
			),
			malformed: false,
		};
	}
	return text
		? { message: withTimestamp("assistant", text, timestamp), malformed: false }
		: { malformed: false };
}

/** Keeps only the most recent messages, so one pass over a snapshot suffices. */
interface TailCollector {
	readonly numMessages: number;
	messages: TranscriptMessage[];
	messagesInWindow: number;
	windowed: boolean;
}

function createTailCollector(options: { numMessages: number }): TailCollector {
	return {
		numMessages: options.numMessages,
		messages: [],
		messagesInWindow: 0,
		windowed: false,
	};
}

function collectMessage(collector: TailCollector, candidate: TranscriptMessage): void {
	collector.messagesInWindow++;
	if (collector.numMessages <= 0) return;
	collector.messages.push(candidate);
	if (collector.messages.length > collector.numMessages) collector.messages.shift();
}

function resultFor(
	collector: TailCollector,
	status: TranscriptStatus,
): TranscriptResult {
	return {
		status,
		messages: collector.messages,
		messagesInWindow: collector.messagesInWindow,
		windowed: collector.windowed,
	};
}

function projectLine(
	line: string,
	collector: TailCollector,
	onMalformed: () => void,
): void {
	if (!line.trim()) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		onMalformed();
		return;
	}
	if (!isRecord(parsed) || typeof parsed.type !== "string") {
		onMalformed();
		return;
	}
	const projected = messageFromEntry(parsed);
	if (projected.malformed) {
		onMalformed();
		return;
	}
	if (projected.message) collectMessage(collector, projected.message);
}

/** Consume complete LF-framed records while retaining at most one bounded record. */
class TranscriptScanner {
	private lineParts: string[] = [];
	private lineBytes = 0;
	private lineHasContent = false;
	private oversizedLine = false;
	private malformed = false;

	constructor(
		private readonly onLine: (line: string, onMalformed: () => void) => void,
		private readonly maxRecordBytes: number,
	) {}

	push(decoded: string): void {
		let start = 0;
		for (;;) {
			const newline = decoded.indexOf("\n", start);
			if (newline < 0) {
				this.append(decoded.slice(start));
				return;
			}
			this.append(decoded.slice(start, newline));
			this.finishLine();
			start = newline + 1;
		}
	}

	finish(): TranscriptStatus {
		const incomplete =
			this.lineHasContent || this.lineParts.length > 0 || this.oversizedLine;
		if (this.malformed || this.oversizedLine) return "unreadable";
		return incomplete ? "incomplete" : "available";
	}

	private append(segment: string): void {
		if (!segment) return;
		this.lineHasContent = true;
		if (this.oversizedLine) return;
		const bytes = Buffer.byteLength(segment, "utf8");
		if (this.lineBytes + bytes > this.maxRecordBytes) {
			this.oversizedLine = true;
			this.lineParts = [];
			this.lineBytes = 0;
			return;
		}
		this.lineParts.push(segment);
		this.lineBytes += bytes;
	}

	private finishLine(): void {
		if (this.oversizedLine) this.malformed = true;
		else if (this.lineHasContent)
			this.onLine(this.lineParts.join(""), () => {
				this.malformed = true;
			});
		this.lineParts = [];
		this.lineBytes = 0;
		this.lineHasContent = false;
		this.oversizedLine = false;
	}
}

function recordLimit(options: TranscriptOptions): number {
	return Math.min(
		MAX_TRANSCRIPT_RECORD_BYTES,
		positiveLimit(options.maxRecordBytes, MAX_TRANSCRIPT_RECORD_BYTES),
	);
}

/**
 * Parse one LF-framed child session snapshot without accepting its final fragment.
 * The result holds the most recent user, assistant, and error messages.
 */
export function parseTranscript(
	content: string,
	options?: TranscriptOptions,
): TranscriptResult {
	const collector = createTailCollector(normalizeOptions(options));
	const scanner = new TranscriptScanner(
		(line, onMalformed) => projectLine(line, collector, onMalformed),
		recordLimit(options || {}),
	);
	for (let offset = 0; offset < content.length; ) {
		let end = Math.min(content.length, offset + STRING_SCAN_CHUNK_CHARS);
		if (
			end < content.length &&
			content.charCodeAt(end - 1) >= 0xd800 &&
			content.charCodeAt(end - 1) <= 0xdbff &&
			content.charCodeAt(end) >= 0xdc00 &&
			content.charCodeAt(end) <= 0xdfff
		)
			end--;
		scanner.push(content.slice(offset, end));
		offset = end;
	}
	return resultFor(collector, scanner.finish());
}

function timeoutError(description: string): Error {
	const error = new Error(`${description} timed out.`);
	error.name = "TimeoutError";
	return error;
}

function abortError(reason: unknown): Error {
	const error = new Error(
		reason instanceof Error
			? reason.message
			: reason === undefined
				? "The operation was aborted."
				: String(reason),
	);
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): error is Error {
	return error instanceof Error && error.name === "AbortError";
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
		return bounded(operation, Date.now() + CLEANUP_TIMEOUT_MS, undefined, "Transcript cleanup").catch(() => {});
	} catch {
		return Promise.resolve();
	}
}

/** Read and parse one finite child session snapshot with bounded chunk and record memory. */
export async function readTranscript(
	sessionPath: string | undefined,
	options?: TranscriptOptions,
): Promise<TranscriptResult> {
	const page = normalizeOptions(options);
	if (typeof sessionPath !== "string" || sessionPath.length === 0)
		return resultFor(createTailCollector(page), "missing");
	const readOptions = options || {};
	const maxSnapshotBytes = Math.min(
		MAX_TRANSCRIPT_SNAPSHOT_BYTES,
		positiveLimit(readOptions.maxSnapshotBytes, MAX_TRANSCRIPT_SNAPSHOT_BYTES),
	);
	const deadline = Date.now() + positiveLimit(readOptions.timeoutMs, DEFAULT_TRANSCRIPT_TIMEOUT_MS);
	const io = readOptions.io || defaultIo;
	let file: TranscriptFileHandle | undefined;
	try {
		file = await bounded(() => io.open(sessionPath, "r"), deadline, readOptions.signal, "Transcript open");
		const fileStat = await bounded(() => file!.stat(), deadline, readOptions.signal, "Transcript stat");
		if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0)
			return resultFor(createTailCollector(page), "unreadable");
		const collector = createTailCollector(page);
		// A tail read needs only the end of the file, so file size never rejects a read.
		const windowStart = Math.max(0, fileStat.size - maxSnapshotBytes);
		collector.windowed = windowStart > 0;
		const scanner = new TranscriptScanner(
			(line, onMalformed) => projectLine(line, collector, onMalformed),
			recordLimit(readOptions),
		);
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, fileStat.size)));
		let position = windowStart;
		// The window boundary lands mid-record, so drop bytes up to the first LF.
		let pendingPrefix = collector.windowed;
		while (position < fileStat.size) {
			const length = Math.min(buffer.length, fileStat.size - position);
			const result = await bounded(
				() => file!.read(buffer, 0, length, position),
				deadline,
				readOptions.signal,
				"Transcript read",
			);
			if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > length)
				return resultFor(collector, "unreadable");
			position += result.bytesRead;
			let chunk = decoder.write(buffer.subarray(0, result.bytesRead));
			if (pendingPrefix) {
				const firstBreak = chunk.indexOf("\n");
				if (firstBreak < 0) continue;
				chunk = chunk.slice(firstBreak + 1);
				pendingPrefix = false;
			}
			scanner.push(chunk);
		}
		scanner.push(decoder.end());
		// A window that never found a record boundary exposed no complete record.
		if (pendingPrefix) return resultFor(collector, "incomplete");
		return resultFor(collector, scanner.finish());
	} catch (error) {
		if (isAbortError(error)) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return resultFor(createTailCollector(page), "missing");
		return resultFor(createTailCollector(page), "unreadable");
	} finally {
		if (file) await cleanupBounded(() => file!.close());
	}
}

/** Child-specific aliases keep callers explicit while sharing the same API. */
export const parseChildTranscript = parseTranscript;
export const readChildTranscript = readTranscript;
