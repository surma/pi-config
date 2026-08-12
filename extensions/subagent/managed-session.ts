import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { OwnerIdentity } from "./owner.js";
import { withDirectoryLock } from "./lock.js";

export type ManagedSessionState = "arming" | "active" | "cleanup_pending";

/**
 * This record is intentionally small. Every field identifies the session that
 * destructive recovery may delete. Do not infer a session name from the host.
 */
export interface ManagedSessionRecord extends OwnerIdentity {
	version: 1;
	generation: string;
	sessionName: string;
	state: ManagedSessionState;
	createdAt: number;
	cleanupError?: string;
}

const RECORD_KEYS = new Set([
	"version",
	"ownerSessionFile",
	"ownerSessionId",
	"generation",
	"sessionName",
	"state",
	"createdAt",
	"cleanupError",
]);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isManagedSessionRecord(value: unknown): value is ManagedSessionRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !RECORD_KEYS.has(key))) return false;
	if (
		record.version !== 1 ||
		!isNonEmptyString(record.ownerSessionFile) ||
		!isNonEmptyString(record.ownerSessionId) ||
		typeof record.generation !== "string" ||
		!/^[0-9a-f]{32}$/.test(record.generation) ||
		typeof record.sessionName !== "string"
	) return false;
	if (!/^pi[A-Za-z0-9_-]{22}$/.test(record.sessionName)) return false;
	return (
		(record.state === "arming" || record.state === "active" || record.state === "cleanup_pending") &&
		typeof record.createdAt === "number" &&
		Number.isFinite(record.createdAt) &&
		Number.isInteger(record.createdAt) &&
		record.createdAt >= 0 &&
		(record.cleanupError === undefined || typeof record.cleanupError === "string")
	);
}

export function createManagedSessionName(_sessionId: string): string {
	return `pi${randomBytes(16).toString("base64url")}`;
}

export function createManagedSessionRecord(
	owner: OwnerIdentity,
	generation: string,
	sessionName: string,
	createdAt: number,
	state: ManagedSessionState = "arming",
): ManagedSessionRecord {
	const record: ManagedSessionRecord = {
		version: 1,
		ownerSessionFile: owner.ownerSessionFile,
		ownerSessionId: owner.ownerSessionId,
		generation,
		sessionName,
		state,
		createdAt,
	};
	if (!isManagedSessionRecord(record)) throw new Error("Invalid managed Zellij session record.");
	return record;
}

async function writeAtomic(path: string, record: ManagedSessionRecord): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await fs.chmod(dirname(path), 0o700).catch(() => {});
	const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
		await fs.chmod(temporary, 0o600).catch(() => {});
		await fs.rename(temporary, path);
		await fs.chmod(path, 0o600).catch(() => {});
	} finally {
		await fs.unlink(temporary).catch(() => {});
	}
}

export async function saveManagedSession(path: string, record: ManagedSessionRecord): Promise<void> {
	if (!isManagedSessionRecord(record)) throw new Error("Refusing to persist an invalid managed Zellij session record.");
	await withDirectoryLock(path, () => writeAtomic(path, record), "Managed Zellij record");
}

export async function saveManagedSessionIfMatches(
	path: string,
	expected: ManagedSessionRecord,
	next: ManagedSessionRecord,
	requiredState?: ManagedSessionState,
): Promise<void> {
	if (!isManagedSessionRecord(next))
		throw new Error("Refusing to persist an invalid managed Zellij session record.");
	await withDirectoryLock(path, async () => {
		const current = await loadManagedSession(path);
		if (!current || !managedSessionIdentityMatches(current, expected, requiredState))
			throw new Error("Managed Zellij session record changed before update; refusing to overwrite it.");
		await writeAtomic(path, next);
	}, "Managed Zellij record");
}

/** Invalid or empty durable data is not safe to use for destructive cleanup. */
export async function loadManagedSession(path: string): Promise<ManagedSessionRecord | undefined> {
	try {
		const raw = await fs.readFile(path, "utf8");
		if (!raw.trim()) throw new Error(`Managed Zellij session record at ${path} is empty.`);
		const parsed: unknown = JSON.parse(raw);
		if (!isManagedSessionRecord(parsed))
			throw new Error(`Managed Zellij session record at ${path} is invalid.`);
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function managedSessionIdentityMatches(
	actual: ManagedSessionRecord,
	expected: ManagedSessionRecord,
	requiredState?: ManagedSessionState,
): boolean {
	return actual.version === expected.version &&
		actual.ownerSessionFile === expected.ownerSessionFile &&
		actual.ownerSessionId === expected.ownerSessionId &&
		actual.generation === expected.generation &&
		actual.sessionName === expected.sessionName &&
		actual.createdAt === expected.createdAt &&
		(requiredState === undefined || actual.state === requiredState);
}

export async function removeManagedSession(path: string): Promise<void> {
	await withDirectoryLock(path, async () => {
		await fs.unlink(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}, "Managed Zellij record");
}

/** Reload, compare exact cleanup ownership, then unlink. */
export async function removeManagedSessionIfMatches(
	path: string,
	expected: ManagedSessionRecord,
): Promise<void> {
	await withDirectoryLock(path, async () => {
		const current = await loadManagedSession(path);
		if (!current || !managedSessionIdentityMatches(current, expected, "cleanup_pending"))
			throw new Error("Managed Zellij session record changed before removal; refusing to unlink it.");
		await fs.unlink(path);
	}, "Managed Zellij record");
}
