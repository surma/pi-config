import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { OwnerIdentity } from "./owner.js";
import { managedSessionPath } from "./owner.js";
import {
	createManagedSessionName,
	createManagedSessionRecord,
	loadManagedSession,
	managedSessionIdentityMatches,
	removeManagedSessionIfMatches,
	saveManagedSession,
	saveManagedSessionIfMatches,
	type ManagedSessionRecord,
} from "./managed-session.js";
import { createDedicatedSession, deleteDedicatedSession } from "./zellij.js";

const defaultGuardianPath = join(dirname(fileURLToPath(import.meta.url)), "zellij-guardian.mjs");
const managerKey = Symbol.for("pi.subagent.zellijLifecycleManager");
const READY_TIMEOUT_MS = 2_500;
const ACK_TIMEOUT_MS = 1_000;
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 1_000;

type GuardianClose = { code: number | null; signal: NodeJS.Signals | null };
type GuardianFrame = { type?: unknown; generation?: unknown; capability?: unknown };
type LifecyclePhase = "provisioning" | "active" | "retiring" | "retired";
export type DedicatedAuthorityVerifier = (owner: OwnerIdentity) => Promise<boolean>;

export interface DedicatedLifecycle {
	agentDir: string;
	owner: OwnerIdentity;
	controllerInstanceId: string;
	record: ManagedSessionRecord;
	guardianCapability?: string;
	guardian?: ChildProcess;
	guardianExited: boolean;
	retiring: boolean;
	expectedGuardianExit: boolean;
	phase: LifecyclePhase;
	settleChildren: () => Promise<void>;
	onUnexpectedExit: (error: Error) => void;
	verifyAuthority: DedicatedAuthorityVerifier;
	guardianFrames: GuardianFrame[];
	guardianFrameWaiters: Set<() => void>;
	guardianClose?: Promise<GuardianClose>;
	guardianCloseResult?: GuardianClose;
	guardianError?: Error;
	retirementPromise?: Promise<void>;
}
interface ManagerState {
	active?: DedicatedLifecycle;
	provisioning?: DedicatedLifecycle;
	retiring: DedicatedLifecycle[];
	operation: Promise<void>;
}
export interface DedicatedLifecycleManagerDependencies {
	guardianPath: string;
	guardianReadyTimeoutMs: number;
	guardianAckTimeoutMs: number;
	guardianTermGraceMs: number;
	guardianKillGraceMs: number;
	spawnGuardian(executable: string, args: string[], options: SpawnOptions): ChildProcess;
	zellijBinary(): string;
	loadRecord(path: string): Promise<ManagedSessionRecord | undefined>;
	saveRecord(path: string, record: ManagedSessionRecord): Promise<void>;
	saveRecordIfMatches(
		path: string,
		expected: ManagedSessionRecord,
		next: ManagedSessionRecord,
		requiredState?: ManagedSessionRecord["state"],
	): Promise<void>;
	removeRecordIfMatches(path: string, record: ManagedSessionRecord): Promise<void>;
	createSession(sessionName: string): Promise<void>;
	deleteSession(sessionName: string): Promise<void>;
}
export interface DedicatedLifecycleManager {
	activeSession(): string | undefined;
	assertActionsAllowed(): string;
	hasPendingRetirement(owner: OwnerIdentity, controllerInstanceId: string): boolean;
	establish(
		agentDir: string,
		owner: OwnerIdentity,
		controllerInstanceId: string,
		now: number,
		onUnexpectedExit: (error: Error) => void,
		settleChildren: () => Promise<void>,
		verifyAuthority: DedicatedAuthorityVerifier,
	): Promise<DedicatedLifecycle>;
	preserveForReload(owner: OwnerIdentity, controllerInstanceId: string): void;
	retire(agentDir: string, lifecycle: DedicatedLifecycle, settleChildren: () => Promise<void>): Promise<void>;
}

function sameOwner(a: OwnerIdentity, b: OwnerIdentity): boolean {
	return a.ownerSessionFile === b.ownerSessionFile && a.ownerSessionId === b.ownerSessionId;
}
function guardFailure(lifecycle: DedicatedLifecycle): Error {
	return new Error(`Dedicated Zellij session ${lifecycle.record.sessionName} is unavailable because its guardian exited. Cleanup must finish before Zellij actions continue.`);
}
function cleanupBlockedError(): Error {
	return new Error("Dedicated Zellij cleanup is pending. New Zellij actions are blocked.");
}
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

/** Creates an isolated manager. Production uses one immutable process-global instance. */
export function createDedicatedLifecycleManager(
	dependencies: DedicatedLifecycleManagerDependencies,
): DedicatedLifecycleManager {
	const deps = Object.freeze({ ...dependencies });
	const state: ManagerState = { retiring: [], operation: Promise.resolve() };

	function addRetiring(lifecycle: DedicatedLifecycle): void {
		if (!state.retiring.includes(lifecycle)) state.retiring.push(lifecycle);
	}
	function removeRetiring(lifecycle: DedicatedLifecycle): void {
		const index = state.retiring.indexOf(lifecycle);
		if (index >= 0) state.retiring.splice(index, 1);
	}
	function transitionToRetiring(lifecycle: DedicatedLifecycle, error?: unknown): void {
		if (lifecycle.phase === "retired") return;
		lifecycle.phase = "retiring";
		lifecycle.retiring = true;
		if (state.active === lifecycle) state.active = undefined;
		if (state.provisioning === lifecycle) state.provisioning = undefined;
		addRetiring(lifecycle);
		lifecycle.record = {
			...lifecycle.record,
			state: "cleanup_pending",
			...(error === undefined ? {} : { cleanupError: error instanceof Error ? error.message : String(error) }),
		};
	}
	function serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = state.operation.then(operation, operation);
		state.operation = result.then(() => undefined, () => undefined);
		return result;
	}
	function recordPath(lifecycle: DedicatedLifecycle): string {
		return managedSessionPath(lifecycle.agentDir, lifecycle.owner);
	}
	function requireIdentity(
		actual: ManagedSessionRecord | undefined,
		lifecycle: DedicatedLifecycle,
		requiredState?: ManagedSessionRecord["state"],
	): ManagedSessionRecord {
		if (!actual || !managedSessionIdentityMatches(actual, lifecycle.record, requiredState))
			throw new Error(`Managed Zellij record changed for ${lifecycle.record.sessionName}; refusing destructive cleanup.`);
		return actual;
	}
	async function persistCleanupPending(lifecycle: DedicatedLifecycle): Promise<void> {
		const path = recordPath(lifecycle);
		const expected = lifecycle.record;
		const next = { ...expected, state: "cleanup_pending" as const, cleanupError: undefined };
		await deps.saveRecordIfMatches(path, expected, next);
		lifecycle.record = next;
	}
	async function persistCleanupError(lifecycle: DedicatedLifecycle, error: unknown): Promise<void> {
		const path = recordPath(lifecycle);
		const expected = lifecycle.record;
		const next = {
			...expected,
			state: "cleanup_pending" as const,
			cleanupError: error instanceof Error ? error.message : String(error),
		};
		await deps.saveRecordIfMatches(path, expected, next, "cleanup_pending");
		lifecycle.record = next;
	}
	function parseGuardianFrames(lifecycle: DedicatedLifecycle): void {
		let output = "";
		lifecycle.guardian?.stdout?.setEncoding("utf8");
		lifecycle.guardian?.stdout?.on("data", (chunk: string) => {
			output += chunk;
			for (;;) {
				const newline = output.indexOf("\n");
				if (newline < 0) break;
				const line = output.slice(0, newline);
				output = output.slice(newline + 1);
				try {
					const frame: unknown = JSON.parse(line);
					if (frame && typeof frame === "object") lifecycle.guardianFrames.push(frame as GuardianFrame);
				} catch {}
				for (const waiter of [...lifecycle.guardianFrameWaiters]) waiter();
			}
		});
	}
	function waitForGuardianFrame(
		lifecycle: DedicatedLifecycle,
		matches: (frame: GuardianFrame) => boolean,
		timeoutMs: number,
		message: string,
	): Promise<GuardianFrame> {
		return new Promise((resolve, reject) => {
			let consumed = 0;
			const finish = (error?: Error, frame?: GuardianFrame) => {
				clearTimeout(timer);
				lifecycle.guardianFrameWaiters.delete(check);
				if (error) reject(error); else resolve(frame!);
			};
			const check = () => {
				for (; consumed < lifecycle.guardianFrames.length; consumed++) {
					const frame = lifecycle.guardianFrames[consumed]!;
					if (matches(frame)) return finish(undefined, frame);
				}
				if (lifecycle.guardianError) return finish(lifecycle.guardianError);
				if (lifecycle.guardianExited)
					return finish(new Error(`Dedicated Zellij guardian exited prematurely (${lifecycle.guardianCloseResult?.code ?? lifecycle.guardianCloseResult?.signal ?? "unknown"}).`));
			};
			const timer = setTimeout(() => finish(new Error(message)), timeoutMs);
			lifecycle.guardianFrameWaiters.add(check);
			check();
		});
	}
	function notifyUnexpectedGuardianExit(lifecycle: DedicatedLifecycle): void {
		if (lifecycle.expectedGuardianExit || lifecycle.phase === "retired") return;
		const error = guardFailure(lifecycle);
		transitionToRetiring(lifecycle, error);
		try { lifecycle.onUnexpectedExit(error); } catch {}
		void enqueueRetirement(lifecycle).catch(() => {});
	}
	async function armGuardian(lifecycle: DedicatedLifecycle): Promise<void> {
		const capability = lifecycle.guardianCapability;
		if (!capability) throw new Error("Dedicated Zellij guardian capability is unavailable.");
		const guardian = deps.spawnGuardian(
			process.execPath,
			[deps.guardianPath, lifecycle.record.sessionName, lifecycle.record.generation, capability, deps.zellijBinary()],
			{ detached: true, stdio: ["pipe", "pipe", "ignore"], shell: false },
		);
		lifecycle.guardian = guardian;
		lifecycle.guardianClose = new Promise((resolve) => {
			guardian.once("close", (code, signal) => {
				const result = { code, signal };
				lifecycle.guardianCloseResult = result;
				lifecycle.guardianExited = true;
				for (const waiter of [...lifecycle.guardianFrameWaiters]) waiter();
				resolve(result);
				notifyUnexpectedGuardianExit(lifecycle);
			});
		});
		guardian.once("error", (error) => {
			lifecycle.guardianError = error;
			for (const waiter of [...lifecycle.guardianFrameWaiters]) waiter();
		});
		parseGuardianFrames(lifecycle);
		await waitForGuardianFrame(
			lifecycle,
			(frame) =>
				frame.type === "ready" &&
				frame.generation === lifecycle.record.generation &&
				frame.capability === capability,
			deps.guardianReadyTimeoutMs,
			"Dedicated Zellij guardian did not become ready.",
		);
		if (lifecycle.guardianExited) throw guardFailure(lifecycle);
		guardian.unref();
		guardian.stdin?.unref();
		guardian.stdout?.unref();
	}
	async function awaitCloseFor(lifecycle: DedicatedLifecycle, timeoutMs: number): Promise<GuardianClose | undefined> {
		if (!lifecycle.guardianClose) return undefined;
		return Promise.race([lifecycle.guardianClose, delay(timeoutMs).then(() => undefined)]);
	}
	function signalGuardianTree(guardian: ChildProcess, signal: NodeJS.Signals): void {
		if (process.platform !== "win32" && guardian.pid !== undefined) {
			try {
				process.kill(-guardian.pid, signal);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		guardian.kill(signal);
	}
	async function terminateAndReapGuardian(lifecycle: DedicatedLifecycle, reason: unknown): Promise<void> {
		const guardian = lifecycle.guardian;
		if (!guardian) return;
		lifecycle.expectedGuardianExit = true;
		if (lifecycle.guardianExited) { await lifecycle.guardianClose; return; }
		guardian.stdin?.destroy();
		if (process.platform !== "win32" && guardian.pid !== undefined) {
			signalGuardianTree(guardian, "SIGTERM");
			// Guardian exit alone does not prove its cleanup client exited. Keep the
			// process-group fence alive through escalation, then reap the leader.
			await delay(deps.guardianTermGraceMs);
			signalGuardianTree(guardian, "SIGKILL");
			if (await awaitCloseFor(lifecycle, deps.guardianKillGraceMs)) return;
		} else {
			signalGuardianTree(guardian, "SIGTERM");
			if (await awaitCloseFor(lifecycle, deps.guardianTermGraceMs)) return;
			signalGuardianTree(guardian, "SIGKILL");
			if (await awaitCloseFor(lifecycle, deps.guardianKillGraceMs)) return;
		}
		throw new Error(`Dedicated Zellij guardian could not be reaped after TERM/KILL: ${String(reason)}`);
	}
	async function disarmAndReapGuardian(lifecycle: DedicatedLifecycle): Promise<void> {
		const guardian = lifecycle.guardian;
		if (!guardian) return;
		if (lifecycle.guardianExited) { await lifecycle.guardianClose; return; }
		lifecycle.expectedGuardianExit = true;
		try {
			const ack = waitForGuardianFrame(
				lifecycle,
				(frame) => frame.type === "ack" && frame.generation === lifecycle.record.generation && frame.capability === lifecycle.guardianCapability,
				deps.guardianAckTimeoutMs,
				"Dedicated Zellij guardian did not acknowledge disarm.",
			);
			// The control write can fail before this promise is awaited. Observe its
			// rejection immediately so fallback cannot create an unhandled rejection.
			void ack.catch(() => {});
			await new Promise<void>((resolve, reject) => {
				const input = guardian.stdin;
				if (!input || input.destroyed) return reject(new Error("Dedicated Zellij guardian control pipe is unavailable."));
				const onError = (error: Error) => reject(error);
				input.once("error", onError);
				input.write(`${JSON.stringify({ type: "disarm", generation: lifecycle.record.generation, capability: lifecycle.guardianCapability })}\n`, (error) => {
					input.off("error", onError);
					if (error) reject(error); else resolve();
				});
			});
			await ack;
			guardian.stdin?.end();
			const closed = await withDeadline(lifecycle.guardianClose!, deps.guardianTermGraceMs, "Dedicated Zellij guardian did not exit after acknowledged control EOF.");
			if (closed.code !== 0 || closed.signal !== null)
				throw new Error(`Dedicated Zellij guardian closed unsuccessfully (${closed.code ?? closed.signal ?? "unknown"}).`);
		} catch (error) {
			await terminateAndReapGuardian(lifecycle, error);
		}
	}
	async function cleanupLifecycle(lifecycle: DedicatedLifecycle): Promise<void> {
		if (lifecycle.phase === "retired") return;
		transitionToRetiring(lifecycle);
		try {
			// Persistence is mandatory. It also compares identity before replacing
			// active/arming state so a successor generation cannot be overwritten.
			await persistCleanupPending(lifecycle);
			if (!(await lifecycle.verifyAuthority(lifecycle.owner)))
				throw new Error(`Current lease authority is unavailable for retiring Zellij session ${lifecycle.record.sessionName}.`);
			// Authority is checked immediately before this fresh durable comparison
			// and destructive call. Never trust only the in-memory operation queue.
			requireIdentity(await deps.loadRecord(recordPath(lifecycle)), lifecycle, "cleanup_pending");
			await deps.deleteSession(lifecycle.record.sessionName);
			await lifecycle.settleChildren();
			await disarmAndReapGuardian(lifecycle);
			if (!(await lifecycle.verifyAuthority(lifecycle.owner)))
				throw new Error(`Lease authority was lost before removing the managed record for ${lifecycle.record.sessionName}.`);
			await deps.removeRecordIfMatches(recordPath(lifecycle), lifecycle.record);
			lifecycle.phase = "retired";
			lifecycle.retiring = false;
			removeRetiring(lifecycle);
		} catch (error) {
			try { await persistCleanupError(lifecycle, error); } catch {}
			throw error;
		}
	}
	function enqueueRetirement(lifecycle: DedicatedLifecycle): Promise<void> {
		transitionToRetiring(lifecycle);
		if (lifecycle.retirementPromise) return lifecycle.retirementPromise;
		const attempt = serialize(() => cleanupLifecycle(lifecycle));
		lifecycle.retirementPromise = attempt.finally(() => {
			if (lifecycle.phase !== "retired") lifecycle.retirementPromise = undefined;
		});
		return lifecycle.retirementPromise;
	}
	async function drivePendingRetirements(): Promise<void> {
		for (const lifecycle of [...state.retiring]) {
			try { await cleanupLifecycle(lifecycle); }
			catch (error) {
				throw new Error(`${cleanupBlockedError().message} Retirement retry failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
		}
	}
	function lifecycleForRecord(
		agentDir: string,
		owner: OwnerIdentity,
		controllerInstanceId: string,
		record: ManagedSessionRecord,
		settleChildren: () => Promise<void>,
		verifyAuthority: DedicatedAuthorityVerifier,
	): DedicatedLifecycle {
		return {
			agentDir, owner, controllerInstanceId, record,
			guardianExited: true, retiring: true, expectedGuardianExit: false, phase: "retiring",
			settleChildren, onUnexpectedExit: () => {}, verifyAuthority,
			guardianFrames: [], guardianFrameWaiters: new Set(),
		};
	}

	return Object.freeze({
		activeSession(): string | undefined {
			if (!state.active || state.provisioning || state.retiring.length || state.active.guardianExited) return undefined;
			return state.active.record.sessionName;
		},
		assertActionsAllowed(): string {
			if (state.provisioning || state.retiring.length) throw cleanupBlockedError();
			if (!state.active) throw new Error("Dedicated Zellij lifecycle is not active.");
			if (state.active.guardianExited) throw guardFailure(state.active);
			return state.active.record.sessionName;
		},
		hasPendingRetirement(owner, controllerInstanceId): boolean {
			return state.retiring.some(
				(lifecycle) =>
					sameOwner(lifecycle.owner, owner) &&
					lifecycle.controllerInstanceId === controllerInstanceId,
			);
		},
		establish(agentDir, owner, controllerInstanceId, now, onUnexpectedExit, settleChildren, verifyAuthority): Promise<DedicatedLifecycle> {
			return serialize(async () => {
				await drivePendingRetirements();
				if (state.active && sameOwner(state.active.owner, owner) && state.active.controllerInstanceId === controllerInstanceId && !state.active.guardianExited) {
					state.active.onUnexpectedExit = onUnexpectedExit;
					state.active.settleChildren = settleChildren;
					state.active.verifyAuthority = verifyAuthority;
					return state.active;
				}
				if (state.active) throw new Error("A different dedicated Zellij lifecycle remains active.");
				if (state.provisioning) throw cleanupBlockedError();
				const path = managedSessionPath(agentDir, owner);
				const stale = await deps.loadRecord(path);
				if (stale) {
					if (!sameOwner(stale, owner)) throw new Error("Managed Zellij record owner does not match this Pi session.");
					const retired = lifecycleForRecord(agentDir, owner, controllerInstanceId, stale, settleChildren, verifyAuthority);
					addRetiring(retired);
					await cleanupLifecycle(retired);
				}
				const generation = randomBytes(16).toString("hex");
				const record = createManagedSessionRecord(owner, generation, createManagedSessionName(owner.ownerSessionId), now);
				const lifecycle: DedicatedLifecycle = {
					agentDir, owner, controllerInstanceId, record,
					guardianCapability: randomBytes(32).toString("hex"),
					guardianExited: false, retiring: false, expectedGuardianExit: false, phase: "provisioning",
					settleChildren, onUnexpectedExit, verifyAuthority,
					guardianFrames: [], guardianFrameWaiters: new Set(),
				};
				state.provisioning = lifecycle;
				let armed = false;
				try {
					await deps.saveRecord(path, lifecycle.record);
					armed = true;
					await armGuardian(lifecycle);
					if (lifecycle.phase !== "provisioning" || lifecycle.guardianExited) throw guardFailure(lifecycle);
					await deps.createSession(record.sessionName);
					if (lifecycle.phase !== "provisioning" || lifecycle.guardianExited) throw guardFailure(lifecycle);
					const activeRecord = { ...record, state: "active" as const };
					await deps.saveRecordIfMatches(path, lifecycle.record, activeRecord, "arming");
					lifecycle.record = activeRecord;
					if (lifecycle.phase !== "provisioning" || lifecycle.guardianExited) throw guardFailure(lifecycle);
					state.provisioning = undefined;
					lifecycle.phase = "active";
					state.active = lifecycle;
					return lifecycle;
				} catch (error) {
					if (state.provisioning === lifecycle) state.provisioning = undefined;
					if (!armed) { lifecycle.phase = "retired"; throw error; }
					transitionToRetiring(lifecycle, error);
					try { await cleanupLifecycle(lifecycle); }
					catch (cleanupError) {
						throw new AggregateError([error, cleanupError], "Dedicated Zellij startup failed and cleanup remains pending.");
					}
					throw error;
				}
			});
		},
		preserveForReload(owner, controllerInstanceId): void {
			if (state.active && sameOwner(state.active.owner, owner) && state.active.controllerInstanceId === controllerInstanceId) return;
		},
		retire(_agentDir, lifecycle, settleChildren): Promise<void> {
			lifecycle.settleChildren = settleChildren;
			return enqueueRetirement(lifecycle);
		},
	});
}

const productionDependencies: DedicatedLifecycleManagerDependencies = Object.freeze({
	guardianPath: defaultGuardianPath,
	guardianReadyTimeoutMs: READY_TIMEOUT_MS,
	guardianAckTimeoutMs: ACK_TIMEOUT_MS,
	guardianTermGraceMs: TERM_GRACE_MS,
	guardianKillGraceMs: KILL_GRACE_MS,
	spawnGuardian: spawn,
	zellijBinary: () => process.env.PI_SUBAGENT_ZELLIJ_BIN || "zellij",
	loadRecord: loadManagedSession,
	saveRecord: saveManagedSession,
	saveRecordIfMatches: saveManagedSessionIfMatches,
	removeRecordIfMatches: removeManagedSessionIfMatches,
	createSession: createDedicatedSession,
	deleteSession: deleteDedicatedSession,
});
const root = globalThis as typeof globalThis & { [managerKey]?: DedicatedLifecycleManager };
const productionManager = root[managerKey] ?? createDedicatedLifecycleManager(productionDependencies);
root[managerKey] = productionManager;

export function activeDedicatedSession(): string | undefined {
	return productionManager.activeSession();
}
export function assertDedicatedActionsAllowed(): string {
	return productionManager.assertActionsAllowed();
}
export function hasPendingDedicatedRetirement(
	owner: OwnerIdentity,
	controllerInstanceId: string,
): boolean {
	return productionManager.hasPendingRetirement(owner, controllerInstanceId);
}
export function establishDedicatedLifecycle(
	agentDir: string,
	owner: OwnerIdentity,
	controllerInstanceId: string,
	now: number,
	onUnexpectedExit: (error: Error) => void,
	settleChildren: () => Promise<void>,
	verifyAuthority: DedicatedAuthorityVerifier,
): Promise<DedicatedLifecycle> {
	return productionManager.establish(agentDir, owner, controllerInstanceId, now, onUnexpectedExit, settleChildren, verifyAuthority);
}
export function preserveDedicatedLifecycleForReload(owner: OwnerIdentity, controllerInstanceId: string): void {
	productionManager.preserveForReload(owner, controllerInstanceId);
}
export function retireDedicatedLifecycle(agentDir: string, lifecycle: DedicatedLifecycle, settleChildren: () => Promise<void>): Promise<void> {
	return productionManager.retire(agentDir, lifecycle, settleChildren);
}
