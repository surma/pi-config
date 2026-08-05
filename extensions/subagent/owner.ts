import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const LEASE_READ_RETRY_MS = 10;
const LEASE_READ_RETRIES = 200;

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

export type LeaseResult =
	| { held: true; conflict: false; lease: LeaseRecord }
	| { held: false; conflict: true; existing: LeaseRecord };

export async function canonicalOwnerSessionFile(
	sessionFile: string,
): Promise<string> {
	const absolute = resolve(sessionFile);
	try {
		return await fs.realpath(absolute);
	} catch {
		const suffix = [basename(absolute)];
		let ancestor = dirname(absolute);
		for (;;) {
			try {
				return join(await fs.realpath(ancestor), ...suffix);
			} catch {
				const parent = dirname(ancestor);
				if (parent === ancestor) return absolute;
				suffix.unshift(basename(ancestor));
				ancestor = parent;
			}
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

/** The durable owner-scoped record for the dedicated Zellij session. */
export function managedSessionPath(
	agentDir: string,
	owner: OwnerIdentity,
): string {
	return join(controllerDir(agentDir, owner), "managed-session.json");
}

export function incarnationSocketDir(
	agentDir: string,
	owner: OwnerIdentity,
	childId: string,
	incarnation: string,
): string {
	return join(
		controllerDir(agentDir, owner),
		"children",
		childId,
		incarnation,
		"bridge.sock",
	);
}

function isLeaseRecord(value: unknown): value is LeaseRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.ownerSessionFile === "string" &&
		typeof record.ownerSessionId === "string" &&
		typeof record.controllerInstanceId === "string" &&
		typeof record.acquiredAt === "number" &&
		typeof record.expiresAt === "number" &&
		typeof record.pid === "number" &&
		typeof record.renewedAt === "number"
	);
}

async function readLease(path: string): Promise<LeaseRecord | undefined> {
	try {
		const raw = await fs.readFile(path, "utf8");
		if (!raw.trim()) return undefined;
		const parsed: unknown = JSON.parse(raw);
		return isLeaseRecord(parsed) ? parsed : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return undefined;
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
): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await fs.chmod(dirname(path), 0o700).catch(() => {});
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.chmod(temporary, 0o600).catch(() => {});
		await fs.rename(temporary, path);
		await fs.chmod(path, 0o600).catch(() => {});
	} finally {
		await fs.unlink(temporary).catch(() => {});
	}
}

async function withLeaseLock<T>(
	path: string,
	action: () => Promise<T>,
): Promise<T> {
	const lockPath = `${path}.lock`;
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < LEASE_READ_RETRIES; attempt++) {
		try {
			await fs.mkdir(lockPath, { mode: 0o700 });
			try {
				return await action();
			} finally {
				await fs.rmdir(lockPath).catch(() => {});
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await new Promise((resolve) => setTimeout(resolve, LEASE_READ_RETRY_MS));
		}
	}
	throw new Error(`Controller lease operation timed out for ${path}.`);
}

export async function acquireLease(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
	now: number,
): Promise<LeaseResult> {
	const path = leasePath(agentDir, owner);
	return withLeaseLock(path, async () => {
		const existing = await readLease(path);
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
		await writeLeaseAtomic(path, record);
		return { held: true, conflict: false, lease: record };
	});
}

export async function renewLease(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
	now: number,
): Promise<boolean> {
	const path = leasePath(agentDir, owner);
	return withLeaseLock(path, async () => {
		const existing = await readLease(path);
		if (
			!existing ||
			existing.ownerSessionFile !== owner.ownerSessionFile ||
			existing.ownerSessionId !== owner.ownerSessionId ||
			existing.controllerInstanceId !== controllerInstanceId ||
			now > existing.expiresAt
		)
			return false;
		await writeLeaseAtomic(path, {
			...existing,
			expiresAt: now + LEASE_TTL_MS,
			renewedAt: now,
		});
		return true;
	});
}

/**
 * Extends retained same-process cleanup authority even after its ordinary
 * expiry, but never overwrites a lease elected for another controller.
 */
export async function maintainLeaseAuthority(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
	now: number,
): Promise<boolean> {
	const path = leasePath(agentDir, owner);
	return withLeaseLock(path, async () => {
		const existing = await readLease(path);
		if (
			!existing ||
			existing.ownerSessionFile !== owner.ownerSessionFile ||
			existing.ownerSessionId !== owner.ownerSessionId ||
			existing.controllerInstanceId !== controllerInstanceId
		)
			return false;
		await writeLeaseAtomic(path, {
			...existing,
			expiresAt: now + LEASE_TTL_MS,
			renewedAt: now,
		});
		return true;
	});
}

export async function releaseLease(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
): Promise<boolean> {
	const path = leasePath(agentDir, owner);
	return withLeaseLock(path, async () => {
		const existing = await readLease(path);
		if (
			!existing ||
			existing.ownerSessionFile !== owner.ownerSessionFile ||
			existing.ownerSessionId !== owner.ownerSessionId ||
			existing.controllerInstanceId !== controllerInstanceId
		)
			return false;
		await fs.unlink(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		return true;
	});
}

export async function hasLeaseAuthority(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
	now: number,
): Promise<boolean> {
	const existing = await readLease(leasePath(agentDir, owner));
	return (
		existing?.ownerSessionFile === owner.ownerSessionFile &&
		existing.ownerSessionId === owner.ownerSessionId &&
		existing.controllerInstanceId === controllerInstanceId &&
		now <= existing.expiresAt
	);
}

export function createControllerInstanceId(): string {
	return randomBytes(16).toString("hex");
}
