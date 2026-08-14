import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_RETRIES = 200;

interface LockOwner {
	pid: number;
	acquiredAt: number;
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(join(path, "owner.json"), "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const owner = parsed as Partial<LockOwner>;
		if (!Number.isInteger(owner.pid) || owner.pid! <= 0 || !Number.isFinite(owner.acquiredAt)) return undefined;
		return { pid: owner.pid!, acquiredAt: owner.acquiredAt! };
	} catch {
		return undefined;
	}
}

async function removeStaleLock(path: string): Promise<void> {
	let lockStat;
	try {
		lockStat = await fs.stat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
		return;
	}
	if (!lockStat.isDirectory() || Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) return;
	const owner = await readLockOwner(path);
	if (owner && isProcessAlive(owner.pid)) return;
	const quarantine = `${path}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
	try {
		await fs.rename(path, quarantine);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
		return;
	}
	await fs.rm(quarantine, { recursive: true, force: true }).catch(() => {});
}

async function writeLockOwner(path: string): Promise<void> {
	const owner: LockOwner = { pid: process.pid, acquiredAt: Date.now() };
	await fs.writeFile(join(path, "owner.json"), `${JSON.stringify(owner)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
}

export async function withDirectoryLock<T>(
	path: string,
	action: () => Promise<T>,
	description: string,
): Promise<T> {
	const lockPath = `${path}.lock`;
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
		try {
			await fs.mkdir(lockPath, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await removeStaleLock(lockPath);
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
			continue;
		}
		try {
			await writeLockOwner(lockPath);
			return await action();
		} finally {
			await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
		}
	}
	throw new Error(`${description} operation timed out for ${path}.`);
}
