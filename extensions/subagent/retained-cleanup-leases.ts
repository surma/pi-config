import {
	LEASE_RENEW_INTERVAL_MS,
	maintainLeaseAuthority,
	releaseLease,
	type OwnerIdentity,
} from "./owner.js";

const retainedManagerKey = Symbol.for("pi.subagent.retainedCleanupLeaseManager");

export interface RetainedCleanupLease {
	agentDir: string;
	owner: OwnerIdentity;
	controllerInstanceId: string;
}

export interface RetainedCleanupLeaseManagerDependencies {
	intervalMs: number;
	now(): number;
	maintainAuthority(
		agentDir: string,
		owner: OwnerIdentity,
		controllerInstanceId: string,
		now: number,
	): Promise<boolean>;
	release(
		agentDir: string,
		owner: OwnerIdentity,
		controllerInstanceId: string,
	): Promise<boolean>;
	setInterval(callback: () => void, delay: number): NodeJS.Timeout;
	clearInterval(timer: NodeJS.Timeout): void;
}

export interface RetainedCleanupLeaseManager {
	retain(entry: RetainedCleanupLease): Promise<boolean>;
	contains(entry: RetainedCleanupLease): boolean;
	ensureAuthority(): Promise<boolean>;
	resolveAfterRetirements(activeLease?: RetainedCleanupLease): Promise<void>;
	finalQuit(): Promise<void>;
	retainedCount(): number;
}

function entryKey(entry: RetainedCleanupLease): string {
	return JSON.stringify([
		entry.agentDir,
		entry.owner.ownerSessionFile,
		entry.owner.ownerSessionId,
		entry.controllerInstanceId,
	]);
}

function sameEntry(
	a: RetainedCleanupLease,
	b: RetainedCleanupLease,
): boolean {
	return entryKey(a) === entryKey(b);
}

/** Creates an isolated retained-authority manager for deterministic tests. */
export function createRetainedCleanupLeaseManager(
	dependencies: RetainedCleanupLeaseManagerDependencies,
): RetainedCleanupLeaseManager {
	const deps = Object.freeze({ ...dependencies });
	const retained = new Map<string, RetainedCleanupLease>();
	let timer: NodeJS.Timeout | undefined;
	let operation = Promise.resolve();

	function serialize<T>(action: () => Promise<T>): Promise<T> {
		const result = operation.then(action, action);
		operation = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async function maintainAll(): Promise<boolean> {
		let authoritative = true;
		for (const entry of [...retained.values()]) {
			try {
				if (
					!(await deps.maintainAuthority(
						entry.agentDir,
						entry.owner,
						entry.controllerInstanceId,
						deps.now(),
					))
				)
					authoritative = false;
			} catch {
				authoritative = false;
			}
		}
		return authoritative;
	}

	function stopTimer(): void {
		if (!timer) return;
		deps.clearInterval(timer);
		timer = undefined;
	}

	function startTimer(): void {
		if (timer || retained.size === 0) return;
		timer = deps.setInterval(() => {
			void serialize(maintainAll);
		}, deps.intervalMs);
		timer.unref();
	}

	async function removeAndRelease(
		activeLease?: RetainedCleanupLease,
	): Promise<void> {
		const resolved = [...retained.values()];
		retained.clear();
		stopTimer();
		for (const entry of resolved) {
			if (activeLease && sameEntry(entry, activeLease)) continue;
			await deps
				.release(entry.agentDir, entry.owner, entry.controllerInstanceId)
				.catch(() => false);
		}
	}

	return Object.freeze({
		retain(entry): Promise<boolean> {
			const saved: RetainedCleanupLease = {
				agentDir: entry.agentDir,
				owner: { ...entry.owner },
				controllerInstanceId: entry.controllerInstanceId,
			};
			return serialize(async () => {
				retained.set(entryKey(saved), saved);
				startTimer();
				return maintainAll();
			});
		},
		contains(entry): boolean {
			return retained.has(entryKey(entry));
		},
		ensureAuthority(): Promise<boolean> {
			return serialize(maintainAll);
		},
		resolveAfterRetirements(activeLease): Promise<void> {
			return serialize(() => removeAndRelease(activeLease));
		},
		finalQuit(): Promise<void> {
			return serialize(() => removeAndRelease());
		},
		retainedCount(): number {
			return retained.size;
		},
	});
}

const productionDependencies: RetainedCleanupLeaseManagerDependencies =
	Object.freeze({
		intervalMs: LEASE_RENEW_INTERVAL_MS,
		now: () => Date.now(),
		maintainAuthority: maintainLeaseAuthority,
		release: releaseLease,
		setInterval: (callback, delay) => setInterval(callback, delay),
		clearInterval: (timer) => clearInterval(timer),
	});
const root = globalThis as typeof globalThis & {
	[retainedManagerKey]?: RetainedCleanupLeaseManager;
};
const productionManager =
	root[retainedManagerKey] ??
	createRetainedCleanupLeaseManager(productionDependencies);
root[retainedManagerKey] = productionManager;

export function retainCleanupLease(
	entry: RetainedCleanupLease,
): Promise<boolean> {
	return productionManager.retain(entry);
}

export function retainedCleanupLeaseExists(
	entry: RetainedCleanupLease,
): boolean {
	return productionManager.contains(entry);
}

export function ensureRetainedCleanupLeaseAuthority(): Promise<boolean> {
	return productionManager.ensureAuthority();
}

export function resolveRetainedCleanupLeases(
	activeLease?: RetainedCleanupLease,
): Promise<void> {
	return productionManager.resolveAfterRetirements(activeLease);
}

export function releaseRetainedCleanupLeasesForQuit(): Promise<void> {
	return productionManager.finalQuit();
}
