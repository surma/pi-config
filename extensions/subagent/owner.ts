import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	withDirectoryLock,
	type DirectoryLockOptions,
	type LockFileSystem,
} from "./lock.js";

export interface OwnerIdentity {
	ownerSessionFile: string;
	ownerSessionId: string;
}

export interface LeaseRecord {
	ownerSessionFile: string;
	ownerSessionId: string;
	controllerInstanceId: string;
	acquiredAt: number;
	expiresAt: number;
	pid: number;
	renewedAt: number;
}

export const LEASE_TTL_MS = 30_000;
export const LEASE_RENEW_INTERVAL_MS = 10_000;
export const LEASE_STALE_GRACE_MS = 5_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 250;
const MAX_LEASE_BYTES = 16 * 1024;

export type LeaseResult =
	| { held: true; conflict: false; lease: LeaseRecord }
	| { held: false; conflict: true; existing: LeaseRecord };

export interface OwnerFileSystem extends LockFileSystem {
	realpath(path: string): Promise<string>;
}

export interface LeaseOperationOptions {
	/** Total deadline for the lease operation and its filesystem calls. */
	timeoutMs?: number;
	signal?: AbortSignal;
	io?: Partial<OwnerFileSystem>;
}

const defaultIo: OwnerFileSystem = {
	realpath: (path) => fs.realpath(path),
	chmod: (path, mode) => fs.chmod(path, mode),
	mkdir: async (path, options) => {
		await fs.mkdir(path, options);
	},
	stat: (path) => fs.stat(path),
	readFile: (path, encoding) => fs.readFile(path, encoding),
	rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
	rm: (path, options) => fs.rm(path, options),
	writeFile: (path, data, options) => fs.writeFile(path, data, options),
	unlink: (path) => fs.unlink(path),
};

function mergedIo(options: LeaseOperationOptions): OwnerFileSystem {
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
		return bounded(operation, Date.now() + CLEANUP_TIMEOUT_MS, undefined, "Lease cleanup").catch(() => {});
	} catch {
		return Promise.resolve();
	}
}

export async function canonicalOwnerSessionFile(
	sessionFile: string,
	options: LeaseOperationOptions = {},
): Promise<string> {
	const io = mergedIo(options);
	const absolute = resolve(sessionFile);
	const deadline = Date.now() + positiveLimit(options.timeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
	try {
		return await bounded(() => io.realpath(absolute), deadline, options.signal, "Owner session realpath");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
	}
	const suffix = [basename(absolute)];
	let ancestor = dirname(absolute);
	for (;;) {
		try {
			return join(
				await bounded(() => io.realpath(ancestor), deadline, options.signal, "Owner directory realpath"),
				...suffix,
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) return absolute;
			suffix.unshift(basename(ancestor));
			ancestor = parent;
		}
	}
}

export function ownerKey(ownerSessionFile: string): string {
	return createHash("sha1").update(ownerSessionFile).digest("hex").slice(0, 24);
}

export function controllerDir(agentDir: string, owner: OwnerIdentity): string {
	return join(
		agentDir,
		"sessions",
		"subagents",
		"controllers",
		ownerKey(owner.ownerSessionFile),
	);
}

export function leasePath(agentDir: string, owner: OwnerIdentity): string {
	return join(controllerDir(agentDir, owner), "lease.json");
}

export function ownerRegistryPath(
	agentDir: string,
	owner: OwnerIdentity,
): string {
	return join(controllerDir(agentDir, owner), "registry.json");
}

function isLeaseRecord(value: unknown): value is LeaseRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.ownerSessionFile === "string" &&
		typeof record.ownerSessionId === "string" &&
		typeof record.controllerInstanceId === "string" &&
		Number.isSafeInteger(record.acquiredAt) &&
		Number(record.acquiredAt) >= 0 &&
		Number.isSafeInteger(record.expiresAt) &&
		Number(record.expiresAt) >= 0 &&
		Number.isSafeInteger(record.pid) &&
		Number(record.pid) > 0 &&
		Number.isSafeInteger(record.renewedAt) &&
		Number(record.renewedAt) >= 0
	);
}

async function readLease(
	path: string,
	io: OwnerFileSystem,
	deadline: number,
	signal: AbortSignal | undefined,
): Promise<LeaseRecord | undefined> {
	try {
		const raw = await bounded(() => io.readFile(path, "utf8"), deadline, signal, "Lease read");
		if (Buffer.byteLength(raw, "utf8") > MAX_LEASE_BYTES) return undefined;
		if (!raw.trim()) return undefined;
		const parsed: unknown = JSON.parse(raw);
		return isLeaseRecord(parsed) ? parsed : undefined;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function buildRecord(
	owner: OwnerIdentity,
	controllerInstanceId: string,
	now: number,
): LeaseRecord {
	return {
		ownerSessionFile: owner.ownerSessionFile,
		ownerSessionId: owner.ownerSessionId,
		controllerInstanceId,
		acquiredAt: now,
		expiresAt: now + LEASE_TTL_MS,
		pid: process.pid,
		renewedAt: now,
	};
}

async function writeLeaseAtomic(
	path: string,
	record: LeaseRecord,
	io: OwnerFileSystem,
	deadline: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	await bounded(() => io.mkdir(dirname(path), { recursive: true, mode: 0o700 }), deadline, signal, "Lease directory creation");
	await bounded(() => io.chmod(dirname(path), 0o700), deadline, signal, "Lease directory permissions");
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
	try {
		await bounded(
			() => io.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 }),
			deadline,
			signal,
			"Lease write",
		);
		await bounded(() => io.chmod(temporary, 0o600), deadline, signal, "Lease temporary permissions");
		await bounded(() => io.rename(temporary, path), deadline, signal, "Lease publication");
		await bounded(() => io.chmod(path, 0o600), deadline, signal, "Lease permissions");
	} finally {
		await cleanupBounded(() => io.unlink(temporary));
	}
}

function withLeaseLock<T>(
	path: string,
	action: () => Promise<T>,
	options: LeaseOperationOptions,
	io: OwnerFileSystem,
): Promise<T> {
	const lockOptions: DirectoryLockOptions = {
		timeoutMs: options.timeoutMs,
		signal: options.signal,
		io,
	};
	return withDirectoryLock(path, action, "Controller lease", lockOptions);
}

export async function acquireLease(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
	now: number,
	options: LeaseOperationOptions = {},
): Promise<LeaseResult> {
	const io = mergedIo(options);
	const path = leasePath(agentDir, owner);
	return withLeaseLock(path, async () => {
		const deadline = Date.now() + positiveLimit(options.timeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
		const existing = await readLease(path, io, deadline, options.signal);
		if (existing) {
			const sameOwner =
				existing.ownerSessionFile === owner.ownerSessionFile &&
				existing.ownerSessionId === owner.ownerSessionId;
			if (
				!sameOwner ||
				(existing.controllerInstanceId !== controllerInstanceId &&
					now < existing.expiresAt + LEASE_STALE_GRACE_MS)
			) {
				return { held: false, conflict: true, existing };
			}
		}
		const record = buildRecord(owner, controllerInstanceId, now);
		await writeLeaseAtomic(path, record, io, deadline, options.signal);
		return { held: true, conflict: false, lease: record };
	}, options, io);
}

/**
 * Extends an existing record that still names this exact owner and controller,
 * even after its ordinary expiry, but never recreates an absent lease and never
 * overwrites a lease elected for another controller.
 */
async function extendOwnLease(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
	now: number,
	options: LeaseOperationOptions,
): Promise<boolean> {
	const io = mergedIo(options);
	const path = leasePath(agentDir, owner);
	return withLeaseLock(path, async () => {
		const deadline = Date.now() + positiveLimit(options.timeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
		const existing = await readLease(path, io, deadline, options.signal);
		if (
			!existing ||
			existing.ownerSessionFile !== owner.ownerSessionFile ||
			existing.ownerSessionId !== owner.ownerSessionId ||
			existing.controllerInstanceId !== controllerInstanceId
		)
			return false;
		// Calls can overlap and capture an older wall-clock value. Never regress either field.
		const renewedAt = Math.max(existing.renewedAt, now);
		await writeLeaseAtomic(
			path,
			{
				...existing,
				expiresAt: Math.max(existing.expiresAt, renewedAt + LEASE_TTL_MS),
				renewedAt,
			},
			io,
			deadline,
			options.signal,
		);
		return true;
	}, options, io);
}

const renewalChains = new Map<string, Promise<unknown>>();

function serializedRenewal(
	key: string,
	action: () => Promise<boolean>,
): Promise<boolean> {
	const previous = renewalChains.get(key) || Promise.resolve();
	const current = previous.catch(() => undefined).then(action);
	const marker = current.then(() => undefined, () => undefined);
	renewalChains.set(key, marker);
	void marker.finally(() => {
		if (renewalChains.get(key) === marker) renewalChains.delete(key);
	});
	return current;
}

/** Periodic and on-demand renewal for the current controller. */
export function renewLease(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
	now: number,
	options: LeaseOperationOptions = {},
): Promise<boolean> {
	const key = `${leasePath(agentDir, owner)}\0${controllerInstanceId}`;
	return serializedRenewal(key, () =>
		extendOwnLease(agentDir, owner, controllerInstanceId, now, options),
	);
}

/** Extends retained same-process cleanup authority without regressing timestamps. */
export function maintainLeaseAuthority(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
	now: number,
	options: LeaseOperationOptions = {},
): Promise<boolean> {
	const key = `${leasePath(agentDir, owner)}\0${controllerInstanceId}`;
	return serializedRenewal(key, () =>
		extendOwnLease(agentDir, owner, controllerInstanceId, now, options),
	);
}

export async function releaseLease(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
	options: LeaseOperationOptions = {},
): Promise<boolean> {
	const io = mergedIo(options);
	const path = leasePath(agentDir, owner);
	return withLeaseLock(path, async () => {
		const deadline = Date.now() + positiveLimit(options.timeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
		const existing = await readLease(path, io, deadline, options.signal);
		if (
			!existing ||
			existing.ownerSessionFile !== owner.ownerSessionFile ||
			existing.ownerSessionId !== owner.ownerSessionId ||
			existing.controllerInstanceId !== controllerInstanceId
		)
			return false;
		try {
			await bounded(() => io.unlink(path), deadline, options.signal, "Lease release");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return true;
	}, options, io);
}

export async function hasLeaseAuthority(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
	now: number,
	options: LeaseOperationOptions = {},
): Promise<boolean> {
	const io = mergedIo(options);
	const deadline = Date.now() + positiveLimit(options.timeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
	const existing = await readLease(leasePath(agentDir, owner), io, deadline, options.signal);
	return (
		existing?.ownerSessionFile === owner.ownerSessionFile &&
		existing.ownerSessionId === owner.ownerSessionId &&
		existing.controllerInstanceId === controllerInstanceId &&
		now <= existing.expiresAt
	);
}

/** Diagnostics-only read of the current record. Never a takeover authority. */
export function readLeaseRecord(
	agentDir: string,
	owner: OwnerIdentity,
	options: LeaseOperationOptions = {},
): Promise<LeaseRecord | undefined> {
	const io = mergedIo(options);
	const deadline = Date.now() + positiveLimit(options.timeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
	return readLease(leasePath(agentDir, owner), io, deadline, options.signal);
}

export function createControllerInstanceId(): string {
	return randomBytes(16).toString("hex");
}
