import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_RETRIES = 200;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 250;
const MAX_OWNER_BYTES = 4 * 1024;

interface LockOwner {
	pid: number;
	acquiredAt: number;
	/** Linux process start ticks, which distinguishes PID reuse when available. */
	pidStartToken?: string;
}

export interface LockFileSystem {
	mkdir(path: string, options: { recursive?: boolean; mode?: number }): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	stat(path: string): Promise<{ isDirectory(): boolean; mtimeMs: number }>;
	readFile(path: string, encoding: "utf8"): Promise<string>;
	rename(oldPath: string, newPath: string): Promise<void>;
	rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
	unlink(path: string): Promise<void>;
	writeFile(
		path: string,
		data: string,
		options: { encoding: "utf8"; flag?: "wx"; mode: number },
	): Promise<void>;
}

export interface DirectoryLockOptions {
	/** Total deadline for acquisition, action, and filesystem cleanup. */
	timeoutMs?: number;
	signal?: AbortSignal;
	retryMs?: number;
	retries?: number;
	now?: () => number;
	io?: Partial<LockFileSystem>;
}

const defaultIo: LockFileSystem = {
	chmod: (path, mode) => fs.chmod(path, mode),
	mkdir: async (path, options) => {
		await fs.mkdir(path, options);
	},
	stat: (path) => fs.stat(path),
	readFile: (path, encoding) => fs.readFile(path, encoding),
	rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
	rm: (path, options) => fs.rm(path, options),
	unlink: (path) => fs.unlink(path),
	writeFile: (path, data, options) => fs.writeFile(path, data, options),
};

function mergedIo(options: DirectoryLockOptions): LockFileSystem {
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
		return bounded(operation, Date.now() + CLEANUP_TIMEOUT_MS, undefined, "Lock cleanup").catch(() => {});
	} catch {
		return Promise.resolve();
	}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function parseLockOwner(raw: string): LockOwner | undefined {
	if (Buffer.byteLength(raw, "utf8") > MAX_OWNER_BYTES) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return undefined;
		const owner = parsed as Partial<LockOwner>;
		if (
			!Number.isSafeInteger(owner.pid) ||
			owner.pid! <= 0 ||
			!Number.isFinite(owner.acquiredAt) ||
			(owner.pidStartToken !== undefined && typeof owner.pidStartToken !== "string")
		)
			return undefined;
		return {
			pid: owner.pid!,
			acquiredAt: owner.acquiredAt!,
			...(owner.pidStartToken === undefined ? {} : { pidStartToken: owner.pidStartToken }),
		};
	} catch {
		return undefined;
	}
}

async function readLockOwner(
	path: string,
	isDirectory: boolean,
	io: LockFileSystem,
	deadline: number,
	signal: AbortSignal | undefined,
): Promise<{ owner?: LockOwner; readable: boolean }> {
	try {
		const ownerPath = isDirectory ? join(path, "owner.json") : path;
		return {
			owner: parseLockOwner(
				await bounded(() => io.readFile(ownerPath, "utf8"), deadline, signal, "Lock owner read"),
			),
			readable: true,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { readable: true };
		// An unreadable owner record must fail closed. Do not remove a live lock
		// merely because its metadata read timed out or returned an I/O error.
		return { readable: false };
	}
}

/** Return Linux process start ticks, or undefined when the platform does not expose them. */
async function processStartToken(
	pid: number,
	io: LockFileSystem,
	deadline: number,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	try {
		const raw = await bounded(
			() => io.readFile(`/proc/${pid}/stat`, "utf8"),
			deadline,
			signal,
			"Process identity read",
		);
		const endOfCommand = raw.lastIndexOf(")");
		if (endOfCommand < 0) return undefined;
		const fields = raw.slice(endOfCommand + 1).trim().split(/\s+/);
		return fields[19] || undefined;
	} catch {
		return undefined;
	}
}

async function removeStaleLock(
	path: string,
	io: LockFileSystem,
	deadline: number,
	signal: AbortSignal | undefined,
	now: () => number,
): Promise<void> {
	let lockStat: { isDirectory(): boolean; mtimeMs: number };
	try {
		lockStat = await bounded(() => io.stat(path), deadline, signal, "Lock stat");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
		return;
	}
	if (now() - lockStat.mtimeMs < LOCK_STALE_MS) return;
	const ownerResult = await readLockOwner(
		path,
		lockStat.isDirectory(),
		io,
		deadline,
		signal,
	);
	if (!ownerResult.readable) return;
	const owner = ownerResult.owner;
	if (owner && isProcessAlive(owner.pid)) {
		if (!owner.pidStartToken) return;
		const currentToken = await processStartToken(owner.pid, io, deadline, signal);
		// An unavailable identity must fail closed. A different token means PID reuse.
		if (!currentToken || currentToken === owner.pidStartToken) return;
	}
	const quarantine = `${path}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
	try {
		await bounded(() => io.rename(path, quarantine), deadline, signal, "Stale lock quarantine");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
		return;
	}
	await cleanupBounded(() => io.rm(quarantine, { recursive: true, force: true }));
}

async function writeLockOwner(
	path: string,
	io: LockFileSystem,
	deadline: number,
	signal: AbortSignal | undefined,
	now: () => number,
): Promise<void> {
	const owner: LockOwner = { pid: process.pid, acquiredAt: now() };
	const pidStartToken = await processStartToken(process.pid, io, deadline, signal);
	if (pidStartToken) owner.pidStartToken = pidStartToken;
	await bounded(
		() =>
			io.writeFile(join(path, "owner.json"), `${JSON.stringify(owner)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			}),
		deadline,
		signal,
		"Lock owner write",
	);
}

export async function withDirectoryLock<T>(
	path: string,
	action: () => Promise<T>,
	description: string,
	options: DirectoryLockOptions = {},
): Promise<T> {
	const io = mergedIo(options);
	const now = options.now || Date.now;
	const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
	const retryMs = positiveLimit(options.retryMs, LOCK_RETRY_MS);
	const retries = positiveLimit(options.retries, LOCK_RETRIES);
	const deadline = Date.now() + timeoutMs;
	const lockPath = `${path}.lock`;
	await bounded(
		() => io.mkdir(dirname(path), { recursive: true, mode: 0o700 }),
		deadline,
		options.signal,
		`${description} parent directory creation`,
	);
	for (let attempt = 0; attempt < retries && Date.now() < deadline; attempt++) {
		try {
			await bounded(
				() => io.mkdir(lockPath, { mode: 0o700 }),
				deadline,
				options.signal,
				`${description} acquisition`,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await removeStaleLock(lockPath, io, deadline, options.signal, now);
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await new Promise<void>((resolve, reject) => {
				let timer: NodeJS.Timeout | undefined;
				let settled = false;
				const cleanup = () => {
					if (timer) clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
				};
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					cleanup();
					if (error) reject(error);
					else resolve();
				};
				const onAbort = () => finish(abortError(options.signal?.reason));
				if (options.signal) {
					if (options.signal.aborted) return onAbort();
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
				timer = setTimeout(() => finish(), Math.min(retryMs, remaining));
				timer.unref?.();
			});
			continue;
		}
		try {
			await writeLockOwner(lockPath, io, deadline, options.signal, now);
			return await bounded(() => action(), deadline, options.signal, description);
		} finally {
			await cleanupBounded(() => io.rm(lockPath, { recursive: true, force: true }));
		}
	}
	throw new Error(`${description} operation timed out for ${path}.`);
}
