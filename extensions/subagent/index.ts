import { randomBytes } from "node:crypto";
import { accessSync, constants, promises as fs } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	dispatchSubagentEvent,
	type SubagentDispatchHandle,
} from "./dispatch-event.js";
import {
	type AckFrame,
	acknowledgementMatchesConnectionEpoch,
	type EventFrame,
	frameMatchesConnectionEpoch,
	type HelloFrame,
	type IpcConnection,
	type IpcServer,
	prepareIpcSocketPath,
	type SnapshotFrame,
	type PongFrame,
	startIpcServer,
} from "./ipc.js";
import {
	createLifecycleState,
	lifecycleActivity,
	markStopped,
	requestKill,
	resetRunViewForSession,
	reviveForResume,
	type SessionLifecycle,
	type SubagentRun,
} from "./lifecycle.js";
import {
	acquireLease,
	canonicalOwnerSessionFile,
	createControllerInstanceId,
	hasLeaseAuthority,
	incarnationSocketDir,
	LEASE_RENEW_INTERVAL_MS,
	type OwnerIdentity,
	ownerRegistryPath,
	releaseLease,
	renewLease,
} from "./owner.js";
import {
	helloMatchesRegistryChild,
	loadRegistry,
	type RegistryEntry,
	registryEntriesForOwner,
	saveRegistry,
} from "./registry.js";
import {
	ensureRetainedCleanupLeaseAuthority,
	releaseRetainedCleanupLeasesForQuit,
	resolveRetainedCleanupLeases,
	retainCleanupLease,
	retainedCleanupLeaseExists,
	type RetainedCleanupLease,
} from "./retained-cleanup-leases.js";
import {
	persistRunResult,
	readRunResult,
	type SettledRunOutcome,
	writeLatestResult,
} from "./result-store.js";
import {
	SettlementNotificationQueue,
	type SettlementNotificationRecord,
} from "./settlement-notifications.js";
import {
	type InspectorHandle,
	SubagentInspector,
	sanitizeTerminalText,
} from "./ui.js";
import {
	closePaneInSession,
	discoverPaneIdInSession,
	newTabInSession,
	sendKeysInSession,
	type SubagentPaneIdentity,
} from "./zellij.js";
import {
	assertDedicatedActionsAllowed,
	establishDedicatedLifecycle,
	hasPendingDedicatedRetirement,
	preserveDedicatedLifecycleForReload,
	retireDedicatedLifecycle,
	type DedicatedLifecycle,
} from "./zellij-manager.js";
import {
	CLEANUP_RETRY_DELAYS_MS,
	heartbeatExpired,
	HEARTBEAT_RESPONSE_MS,
	HEARTBEAT_SWEEP_MS,
	parentStalled,
	pingDue,
	reconnectExpired,
	RECONNECT_GRACE_MS,
	type PendingHeartbeat,
	type TerminalCleanupState,
} from "./liveness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const childExtensionPath = join(__dirname, "child.ts");
const STARTUP_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 10_000;
const ABORT_ACK_TIMEOUT_MS = 1_000;
const TERM_DEADLINE_MS = 1_500;
const KILL_DEADLINE_MS = 4_000;
const ASSISTANT_DISPLAY_MAX = 64 * 1024;
const TOOL_OUTPUT_TAIL_MAX = 16 * 1024;
const MAX_RECENT_TOOLS = 8;
const MAX_RETAINED_HANDLES = 24;
const MAX_DIAGNOSTICS = 20;
const SUBAGENT_RESULT_PREVIEW_LINES = 5;
const controllerInstanceKey = Symbol.for("pi.subagent.controllerInstanceId");
const controllerGlobal = globalThis as typeof globalThis & {
	[controllerInstanceKey]?: string;
};
const processControllerInstanceId =
	controllerGlobal[controllerInstanceKey] ?? createControllerInstanceId();
controllerGlobal[controllerInstanceKey] = processControllerInstanceId;

type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";
type ResultKind = "none" | "final" | "partial";
interface ActualModel {
	provider: string;
	id: string;
	name?: string;
}
interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}
interface PendingAck {
	childConnectionId: string;
	parentConnectionId: string;
	resolve(frame: AckFrame): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}
interface TaskSpec {
	name?: string;
	task: string;
	cwd?: string;
	model: string;
	thinking: ThinkingLevel;
	systemPrompt?: string;
}

export async function withTerminalCleanupLock(
	state: { terminalCleanupActive?: boolean },
	action: () => Promise<void>,
): Promise<boolean> {
	if (state.terminalCleanupActive) return false;
	state.terminalCleanupActive = true;
	try {
		await action();
		return true;
	} finally {
		state.terminalCleanupActive = false;
	}
}

export async function closeAndDrainIpcMutations(
	state: { ipcMutationsClosed: boolean; ipcMutationChain: Promise<void> },
	closeTransport: () => Promise<void>,
): Promise<void> {
	state.ipcMutationsClosed = true;
	await closeTransport();
	await state.ipcMutationChain;
}

interface SubagentHandle extends SubagentDispatchHandle {
	id: string;
	name?: string;
	task: string;
	cwd: string;
	requestedModel: string;
	requestedThinking: ThinkingLevel;
	sessionDir: string;
	socketPath: string;
	promptPath: string;
	actualModel?: ActualModel;
	actualThinking?: ThinkingLevel;
	sessionPath?: string;
	sessionId?: string;
	connectionId?: string;
	pid?: number;
	tabId?: number;
	paneId?: number;
	zellijSessionName?: string;
	exitCode?: number;
	reconnecting?: boolean;
	lastIpcFrameAt: number;
	pendingHeartbeat?: PendingHeartbeat;
	disconnectedAt?: number;
	disconnectDeadlineAt?: number;
	deathReason?: "heartbeat_timeout" | "reconnect_timeout" | "quit" | "kill";
	terminalCleanup: TerminalCleanupState;
	cleanupRequired: boolean;
	terminalStateDurable: boolean;
	terminalCleanupActive?: boolean;
	ipcServer?: IpcServer;
	ipcConn?: IpcConnection;
	seenHelloConnections: Set<string>;
	pendingAcks: Map<string, PendingAck>;
	requestSequence: number;
	createdAt: number;
	ipcReadyAt?: number;
	lastActivityAt: number;
	completedAt?: number;
	promptCaptured?: boolean;
	transcriptPersisted?: boolean;
	resultPath?: string;
	settlementPersistenceChain: Promise<void>;
	stderr: string;
	diagnostics: string[];
	waiters: Set<() => void>;
	terminationPromise?: Promise<SubagentHandle>;
	ipcMutationChain: Promise<void>;
	ipcMutationsClosed: boolean;
	ownerSessionFile: string;
	ownerSessionId: string;
	controllerInstanceId: string;
	incarnation: string;
	resumedFrom?: string;
}

const ThinkingSchema = StringEnum([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const);
const TaskSpecSchema = Type.Object(
	{
		name: Type.Optional(Type.String()),
		task: Type.String({ minLength: 1 }),
		cwd: Type.Optional(Type.String()),
		model: Type.String({ minLength: 1 }),
		thinking: ThinkingSchema,
		systemPrompt: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
const ListSchema = Type.Object({
	includeFinished: Type.Optional(Type.Boolean({ default: true })),
});
const StatusSchema = Type.Object({ id: Type.String() });
const ResultSchema = Type.Object(
	{
		id: Type.String({ description: "Logical child id." }),
		runId: Type.Integer({ minimum: 1, description: "Exact settled run id." }),
	},
	{ additionalProperties: false },
);
const MessageSchema = Type.Object({
	id: Type.String(),
	message: Type.String({ minLength: 1 }),
});
const IdSchema = Type.Object({ id: Type.String() });
const ResumeSchema = Type.Object({
	id: Type.String({ description: "Logical child id to resume." }),
	task: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Initial message after the resumed session loads. If omitted, the child starts idle.",
		}),
	),
});

function now() {
	return Date.now();
}
function monotonicNow() {
	return performance.now();
}
function createId() {
	return randomBytes(8).toString("hex");
}
function createUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
}
function formatModel(model: ActualModel) {
	return `${model.provider}/${model.id}`;
}
function isThinking(value: unknown): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
		String(value),
	);
}
function truncate(value: string | undefined, max = 240) {
	const text = (value || "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function executableOnPath(name: string): string | undefined {
	for (const directory of (process.env.PATH || "").split(delimiter)) {
		const candidate = join(directory || ".", name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep searching PATH.
		}
	}
	return undefined;
}

export function getPiInvocation(args: string[]): string[] {
	const offlineArgs = ["--offline", "--approve", ...args];
	if (process.env.PI_SUBAGENT_PI_BIN)
		return [process.env.PI_SUBAGENT_PI_BIN, ...offlineArgs];
	const devx = process.env.PI_SUBAGENT_DEVX_BIN || executableOnPath("devx");
	if (devx) return [devx, "pi", ...offlineArgs];
	const script = process.argv[1];
	if (
		script &&
		!script.startsWith("-") &&
		(script.includes("/") || /\.m?js$/.test(script))
	)
		return [process.execPath, script, ...offlineArgs];
	const execName = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(execName)
		? ["pi", ...offlineArgs]
		: [process.execPath, ...offlineArgs];
}

export default function subagentExtension(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	const handles = new Map<string, SubagentHandle>();
	let latestCtx: ExtensionContext | null = null;
	let activeInspector: SubagentInspector | undefined;
	let widgetVisible = true;
	let persistenceChain = Promise.resolve();
	let owner: OwnerIdentity | null = null;
	const controllerInstanceId = processControllerInstanceId;
	let leaseHeld = false;
	let leaseRenewTimer: NodeJS.Timeout | undefined;
	let watchdogTimer: NodeJS.Timeout | undefined;
	let watchdogSweepActive = false;
	let lastWatchdogSweepAt = monotonicNow();
	let sessionShuttingDown = false;
	let dedicatedLifecycle: DedicatedLifecycle | undefined;
	let settlementNotificationEpoch = 0;
	const settlementNotifications = new SettlementNotificationQueue(
		(message, options) => pi.sendMessage(message, options),
		(record) => {
			const handle = handles.get(record.childId);
			return (
				!sessionShuttingDown &&
				leaseHeld &&
				owner?.ownerSessionFile === record.ownerSessionFile &&
				owner.ownerSessionId === record.ownerSessionId &&
				handle?.incarnation === record.incarnation &&
				!handle.killRequestedAt
			);
		},
	);
	const suppressAllSettlementNotifications = () => {
		settlementNotificationEpoch++;
		settlementNotifications.suppressAll();
	};

	const sorted = () =>
		[...handles.values()].sort(
			(a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
		);
	const active = (handle: SubagentHandle) => handle.processState === "alive";
	const paneIdentity = (handle: SubagentHandle): SubagentPaneIdentity => ({
		childId: handle.id,
		socketPath: handle.socketPath,
		ownerSessionFile: handle.ownerSessionFile,
		ownerSessionId: handle.ownerSessionId,
		controllerInstanceId: handle.controllerInstanceId,
		incarnation: handle.incarnation,
	});
	const requireLease = (): boolean => leaseHeld && owner !== null;
	const requiredDedicatedSession = (): string => assertDedicatedActionsAllowed();
	async function ensureDedicatedSession(ctx?: ExtensionContext): Promise<string> {
		try {
			return requiredDedicatedSession();
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("cleanup is pending")) throw error;
			const retryContext = ctx ?? latestCtx;
			if (!retryContext) throw error;
			await establishController(retryContext);
			return requiredDedicatedSession();
		}
	}
	const requireHandleDedicatedSession = (handle: SubagentHandle): string => {
		const activeSession = requiredDedicatedSession();
		if (handle.zellijSessionName !== activeSession)
			throw new Error(
				`Subagent #${handle.id} does not belong to the active dedicated Zellij session.`,
			);
		return activeSession;
	};
	const setDedicatedSessionStatus = (
		ctx: ExtensionContext | null,
		sessionName: string | undefined,
	): void => {
		ctx?.ui?.setStatus("subagent-zellij", sessionName);
	};
	async function requireCurrentAuthority(): Promise<boolean> {
		if (!leaseHeld || !owner || !controllerInstanceId) return false;
		const authoritative = await hasLeaseAuthority(
			getAgentDir(),
			owner,
			controllerInstanceId,
			now(),
		);
		if (!authoritative) {
			leaseHeld = false;
			suppressAllSettlementNotifications();
			stopTimers();
			setDedicatedSessionStatus(latestCtx, undefined);
			refreshUi();
		}
		return authoritative;
	}
	const addDiagnostic = (handle: SubagentHandle, message: string) => {
		handle.diagnostics.push(message.slice(0, 2048));
		if (handle.diagnostics.length > MAX_DIAGNOSTICS)
			handle.diagnostics.splice(0, handle.diagnostics.length - MAX_DIAGNOSTICS);
	};
	const notifyWaiters = (handle: SubagentHandle) => {
		for (const waiter of [...handle.waiters]) waiter();
	};
	const registryEntry = (handle: SubagentHandle): RegistryEntry => ({
			childId: handle.id,
			name: handle.name,
			task: handle.task,
			cwd: handle.cwd,
			tabId: handle.tabId,
			paneId: handle.paneId,
			zellijSessionName: handle.zellijSessionName,
			terminalCleanupPending: handle.cleanupRequired,
			terminalCleanupError: handle.terminalCleanup.lastError,
			sessionDir: handle.sessionDir,
			socketPath: handle.socketPath,
			sessionFile: handle.sessionPath,
			promptPath: handle.promptPath,
			requestedModel: handle.requestedModel,
			requestedThinking: handle.requestedThinking,
			processState: handle.processState,
			runState: handle.runState,
			runId: handle.runSequence || undefined,
			lastSettledRunId: handle.lastSettledRunId || undefined,
			createdAt: handle.createdAt,
			lastActivityAt: handle.lastActivityAt,
			detached: handle.reconnecting && !handle.ipcConn,
			ownerSessionFile: handle.ownerSessionFile,
			ownerSessionId: handle.ownerSessionId,
			controllerInstanceId: handle.controllerInstanceId,
			incarnation: handle.incarnation,
			resumedFrom: handle.resumedFrom,
		});
	const registryEntries = (): RegistryEntry[] => sorted().map(registryEntry);
	const persist = (): Promise<boolean> => {
		const persistenceOwner = owner;
		if (!persistenceOwner || !leaseHeld) return Promise.resolve(false);
		const path = ownerRegistryPath(getAgentDir(), persistenceOwner);
		const entries = registryEntries();
		const write = persistenceChain.then(async () => {
			if (
				!owner ||
				owner.ownerSessionFile !== persistenceOwner.ownerSessionFile ||
				owner.ownerSessionId !== persistenceOwner.ownerSessionId ||
				!(await requireCurrentAuthority())
			)
				return false;
			await saveRegistry(entries, path);
			return true;
		});
		persistenceChain = write.then(
			() => undefined,
			(error) => {
				for (const handle of handles.values())
					addDiagnostic(
						handle,
						`Registry persistence failed: ${error instanceof Error ? error.message : String(error)}`,
					);
			},
		);
		return write.catch(() => false);
	};
	const trimRetained = () => {
		if (handles.size <= MAX_RETAINED_HANDLES) return;
		const stopped = [...handles.values()]
			.filter((candidate) => candidate.processState === "stopped")
			.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
		while (handles.size > MAX_RETAINED_HANDLES && stopped.length) {
			const candidate = stopped.shift();
			if (candidate && !candidate.cleanupRequired) handles.delete(candidate.id);
		}
	};
	const update = (handle: SubagentHandle, shouldPersist = true) => {
		handle.lastActivityAt = now();
		trimRetained();
		refreshUi();
		reconcileWatchdog();
		if (shouldPersist) void persist();
	};

	function acceptSettlement(
		handle: SubagentHandle,
		runId: number,
		outcome: SettledRunOutcome,
		result: string,
		settledAt: number,
		source: "event" | "snapshot",
	): void {
		const incarnation = handle.incarnation;
		const fallbackResult = result;
		const notificationEpoch = settlementNotificationEpoch;
		const notification: SettlementNotificationRecord = {
			ownerSessionFile: handle.ownerSessionFile,
			ownerSessionId: handle.ownerSessionId,
			childId: handle.id,
			name: handle.name,
			incarnation,
			runId,
			eventKind: "run_settled",
			outcome,
			childAlive: handle.processState === "alive",
			preview: truncate(fallbackResult),
		};
		handle.settlementPersistenceChain = handle.settlementPersistenceChain.then(
			async () => {
				let exact = await readRunResult(handle.sessionDir, runId);
				try {
					if (exact.status !== "available" && source === "event") {
						await persistRunResult(handle.sessionDir, {
							runId,
							outcome,
							incarnation,
							settledAt,
							result: fallbackResult,
						});
						exact = await readRunResult(handle.sessionDir, runId);
					}
				} catch (error) {
					addDiagnostic(
						handle,
						`Run ${runId} result persistence failed: ${String(error)}`,
					);
				}
				if (exact.status === "available") {
					notification.preview = truncate(exact.record.result);
					if (
						handle.incarnation === incarnation &&
						handle.runSequence === runId &&
						handle.lastSettledRunId === runId &&
						handle.runState === "idle"
					) {
						handle.resultText = exact.record.result;
					}
					try {
						handle.resultPath = await writeLatestResult(
							handle.sessionDir,
							exact.record.result,
						);
					} catch (error) {
						addDiagnostic(
							handle,
							`Latest result persistence failed for run ${runId}: ${String(error)}`,
						);
					}
				}
				if (
					notificationEpoch !== settlementNotificationEpoch ||
					sessionShuttingDown ||
					!leaseHeld ||
					handle.killRequestedAt
				) {
					return;
				}
				settlementNotifications.queue(notification);
			},
		).catch((error) => {
			addDiagnostic(
				handle,
				`Run ${runId} settlement processing failed: ${String(error)}`,
			);
		});
	}
	async function transcriptStatus(handle: SubagentHandle) {
		if (!handle.sessionPath)
			return { persisted: false, note: "no persisted transcript yet" };
		const persisted = await fs
			.stat(handle.sessionPath)
			.then((stat) => stat.isFile())
			.catch(() => false);
		handle.transcriptPersisted = persisted;
		return {
			persisted,
			note: persisted
				? "persisted transcript available"
				: "no persisted transcript yet",
		};
	}
	function resultKind(handle: SubagentHandle): ResultKind {
		if (!handle.resultText) return "none";
		return handle.runOutcome === "succeeded" ? "final" : "partial";
	}
	async function serialize(handle: SubagentHandle) {
		await handle.settlementPersistenceChain;
		const transcript = await transcriptStatus(handle);
		const actualModel =
			handle.actualModel ||
			(() => {
				const [provider = "unknown", id = handle.requestedModel] =
					handle.requestedModel.split("/", 2);
				return { provider, id };
			})();
		return {
			id: handle.id,
			name: handle.name,
			state: handle.state,
			lifecycle: handle.lifecycle,
			processState: handle.processState,
			runState: handle.runState,
			runId: handle.runSequence || undefined,
			lastSettledRunId: handle.lastSettledRunId || undefined,
			runOutcome: handle.runOutcome,
			task: handle.task,
			cwd: handle.cwd,
			tabId: handle.tabId,
			paneId: handle.paneId,
			zellijSessionName: handle.zellijSessionName,
			pid: handle.pid,
			exitCode: handle.exitCode,
			reconnecting: handle.reconnecting,
			ipcLiveness: {
				state:
					handle.processState === "stopped"
						? "dead"
						: handle.reconnecting
							? "reconnecting"
							: handle.pendingHeartbeat
								? "awaiting_pong"
								: "healthy",
				heartbeatPending: !!handle.pendingHeartbeat,
				deathReason: handle.deathReason,
			},
			terminalCleanup: {
				status: handle.terminalCleanup.status,
				attempts: handle.terminalCleanup.attempts,
				lastError: handle.terminalCleanup.lastError,
			},
			requestedModel: handle.requestedModel,
			requestedThinking: handle.requestedThinking,
			actualModel,
			actualThinking: handle.actualThinking || handle.requestedThinking,
			sessionPath: handle.sessionPath || "",
			promptPath: handle.promptPath,
			resultPath: handle.resultPath,
			resultKind: resultKind(handle),
			transcriptPersisted: transcript.persisted,
			transcriptNote: transcript.note,
			createdAt: handle.createdAt,
			ipcReadyAt: handle.ipcReadyAt,
			agentStartedAt: handle.agentStartedAt,
			lastActivityAt: handle.lastActivityAt,
			completedAt: handle.completedAt,
			currentTool: handle.currentTool,
			currentToolStartedAt: handle.currentToolStartedAt,
			lastTool: handle.lastTool,
			isStreaming: handle.isStreaming,
			usage: { ...handle.usage },
			stopReason: handle.stopReason,
			error:
				handle.terminalCleanup.status === "failed"
					? handle.terminalCleanup.lastError
					: handle.error || handle.finalError,
			resultPreview: handle.resultText
				? truncate(handle.resultText)
				: undefined,
			currentAssistantText: handle.currentAssistantText || undefined,
			latestAssistantText: handle.latestAssistantText || undefined,
			activeTools: [...handle.activeTools.values()].map((tool) => ({
				...tool,
			})),
			recentTools: handle.recentTools.map((tool) => ({ ...tool })),
			tentativeError: handle.tentativeError,
			finalError: handle.finalError,
			settledAt: handle.settledAt,
			diagnostics: handle.diagnostics.length
				? [...handle.diagnostics]
				: undefined,
		};
	}
	async function summary(handle: SubagentHandle) {
		const serial = await serialize(handle);
		return sanitizeTerminalText(
			`#${handle.id}${handle.name ? ` ${handle.name}` : ""} ${handle.processState}/${handle.runState} · run:${handle.runSequence || 0}\n  actual ${formatModel(serial.actualModel)} · thinking:${serial.actualThinking}\n  tab ${handle.tabId ?? "?"} pane ${handle.paneId ?? "?"}${handle.reconnecting ? " · reconnecting" : ""}\n  session ${serial.sessionPath} (${serial.transcriptNote})${serial.error ? `\n  error ${truncate(serial.error, 180)}` : ""}`,
		);
	}

	function createHandle(
		entry: Partial<RegistryEntry> & {
			childId: string;
			task: string;
			cwd: string;
			sessionDir: string;
			socketPath: string;
			requestedModel: string;
			requestedThinking: string;
			createdAt: number;
			lastActivityAt: number;
			ownerSessionFile: string;
			ownerSessionId: string;
			controllerInstanceId: string;
			incarnation: string;
		},
	): SubagentHandle {
		return {
			...createLifecycleState(),
			id: entry.childId,
			name: entry.name,
			task: entry.task,
			cwd: entry.cwd,
			requestedModel: entry.requestedModel,
			requestedThinking: isThinking(entry.requestedThinking)
				? entry.requestedThinking
				: "off",
			sessionDir: entry.sessionDir,
			socketPath: entry.socketPath,
			promptPath:
				entry.promptPath ||
				join(entry.sessionDir, "pi-effective-system-prompt.txt"),
			sessionPath: entry.sessionFile,
			tabId: entry.tabId,
			paneId: entry.paneId,
			zellijSessionName: entry.zellijSessionName,
			processState: entry.processState || "alive",
			runState: entry.runState || "idle",
			runSequence: entry.runId || 0,
			lastSettledRunId: entry.lastSettledRunId || 0,
			state: entry.processState === "stopped" ? "done" : "starting",
			lifecycle:
				entry.processState === "stopped"
					? "done"
					: ((entry.runState || "idle") as SessionLifecycle),
			resultText: "",
			currentAssistantText: "",
			latestAssistantText: "",
			assistantMessageGeneration: 0,
			finalizedAssistantIdentities: [],
			assistantTextTruncated: false,
			activeTools: new Map(),
			recentTools: [],
			knownToolCallIds: [],
			isStreaming: false,
			usage: createUsage(),
			completionSettled: false,
			seenHelloConnections: new Set(),
			pendingAcks: new Map(),
			requestSequence: 0,
			createdAt: entry.createdAt,
			lastActivityAt: entry.lastActivityAt,
			stderr: "",
			diagnostics: [],
			waiters: new Set(),
			ipcMutationChain: Promise.resolve(),
			ipcMutationsClosed: false,
			settlementPersistenceChain: Promise.resolve(),
			reconnecting: entry.detached,
			lastIpcFrameAt: monotonicNow(),
			terminalCleanup: {
				status: entry.terminalCleanupPending
					? entry.terminalCleanupError
						? "failed"
						: "pending"
					: "none",
				attempts: 0,
				lastError: entry.terminalCleanupError,
			},
			cleanupRequired: entry.terminalCleanupPending === true,
			terminalStateDurable: entry.terminalCleanupPending === true,
			ownerSessionFile: entry.ownerSessionFile,
			ownerSessionId: entry.ownerSessionId,
			controllerInstanceId: entry.controllerInstanceId,
			incarnation: entry.incarnation,
			resumedFrom: entry.resumedFrom,
		};
	}

	function dispatchOptions(handle: SubagentHandle) {
		return {
			now,
			assistantDisplayMax: ASSISTANT_DISPLAY_MAX,
			toolOutputTailMax: TOOL_OUTPUT_TAIL_MAX,
			maxRecentTools: MAX_RECENT_TOOLS,
			update: () => update(handle),
			diagnostic: (message: string) => addDiagnostic(handle, message),
			onAssistantFinalized: () => {},
			onSettled: (run: SubagentRun) => {
				handle.completedAt = handle.settledAt;
				handle.error = handle.finalError;
				if (run.outcome !== "pending") {
					acceptSettlement(
						handle,
						run.id,
						run.outcome,
						handle.resultText,
						handle.settledAt || run.endedAt || now(),
						"event",
					);
				}
				notifyWaiters(handle);
				update(handle);
			},
		};
	}
	function isCurrentEpoch(
		handle: SubagentHandle,
		frame: { connectionId: string },
		conn: IpcConnection,
	): boolean {
		return frameMatchesConnectionEpoch(
			{
				parentConnectionId: handle.ipcConn?.id,
				childConnectionId: handle.connectionId,
			},
			frame,
			conn,
		);
	}
	function isCurrentEpochWithOwner(
		handle: SubagentHandle,
		frame: {
			ownerSessionFile?: string;
			ownerSessionId?: string;
			launchControllerInstanceId?: string;
			incarnation?: string;
			connectionId: string;
		},
		conn: IpcConnection,
	): boolean {
		return (
			frame.ownerSessionFile === handle.ownerSessionFile &&
			frame.ownerSessionId === handle.ownerSessionId &&
			frame.launchControllerInstanceId === handle.controllerInstanceId &&
			frame.incarnation === handle.incarnation &&
			isCurrentEpoch(handle, frame, conn)
		);
	}
	function rejectPendingAcks(
		handle: SubagentHandle,
		parentConnectionId: string,
		message: string,
	): void {
		for (const [id, pending] of handle.pendingAcks) {
			if (pending.parentConnectionId !== parentConnectionId) continue;
			clearTimeout(pending.timer);
			handle.pendingAcks.delete(id);
			pending.reject(new Error(message));
		}
	}
	function applySnapshot(handle: SubagentHandle, frame: SnapshotFrame) {
		const previousSettledRunId = handle.lastSettledRunId;
		handle.sessionId = frame.sessionId;
		handle.sessionPath = frame.sessionFile;
		handle.runState = frame.runState;
		handle.runSequence = Math.max(handle.runSequence, frame.runId);
		handle.runOutcome = frame.runOutcome;
		handle.stopReason = frame.stopReason;
		handle.error = frame.errorMessage;
		handle.currentTool = frame.currentTool;
		handle.isStreaming = frame.isStreaming;
		handle.currentAssistantText = frame.assistantTail;
		Object.assign(handle.usage, frame.usage);
		if (
			frame.runState === "idle" &&
			frame.runId > 0 &&
			frame.runOutcome !== "pending"
		) {
			handle.lastSettledRunId = Math.max(handle.lastSettledRunId, frame.runId);
			handle.state =
				frame.runOutcome === "failed"
					? "error"
					: frame.runOutcome === "succeeded"
						? "done"
						: "running";
			if (frame.runId > previousSettledRunId) {
				acceptSettlement(
					handle,
					frame.runId,
					frame.runOutcome,
					frame.assistantTail,
					frame.updatedAt,
					"snapshot",
				);
			}
			notifyWaiters(handle);
		} else if (frame.runState !== "idle") handle.state = "running";
		handle.lifecycle = frame.runState;
		update(handle);
	}
	function handleHello(
		handle: SubagentHandle,
		frame: HelloFrame,
		conn: IpcConnection,
	) {
		if (handle.processState === "stopped") {
			addDiagnostic(handle, "Rejected IPC hello for a stopped incarnation.");
			conn.close();
			return;
		}
		if (!helloMatchesRegistryChild(handle.id, frame.childId)) {
			addDiagnostic(
				handle,
				`Rejected IPC hello for unexpected childId ${frame.childId}.`,
			);
			conn.close();
			return;
		}
		if (
			frame.ownerSessionFile !== handle.ownerSessionFile ||
			frame.ownerSessionId !== handle.ownerSessionId ||
			frame.launchControllerInstanceId !== handle.controllerInstanceId ||
			frame.incarnation !== handle.incarnation
		) {
			addDiagnostic(
				handle,
				`Rejected IPC hello for mismatched owner or incarnation.`,
			);
			conn.close();
			return;
		}
		if (handle.seenHelloConnections.has(frame.connectionId)) return;
		handle.seenHelloConnections.add(frame.connectionId);
		const sessionChanged =
			(!!handle.sessionId && handle.sessionId !== frame.sessionId) ||
			frame.reason === "new" ||
			frame.reason === "resume";
		const previousConnection = handle.ipcConn;
		if (previousConnection && previousConnection.id !== conn.id) {
			rejectPendingAcks(
				handle,
				previousConnection.id,
				"Child IPC connection changed before acknowledgement.",
			);
			const closeTimer = setTimeout(() => previousConnection.close(), 250);
			closeTimer.unref();
		}
		handle.ipcConn = conn;
		handle.connectionId = frame.connectionId;
		handle.sessionId = frame.sessionId;
		handle.sessionPath = frame.sessionFile;
		handle.pid = frame.pid;
		handle.actualModel = frame.model || undefined;
		handle.actualThinking = isThinking(frame.thinkingLevel)
			? frame.thinkingLevel
			: handle.requestedThinking;
		handle.ipcReadyAt ||= now();
		handle.reconnecting = false;
		handle.pendingHeartbeat = undefined;
		handle.disconnectedAt = undefined;
		handle.disconnectDeadlineAt = undefined;
		recordCurrentFrame(handle);
		handle.processState = "alive";
		if (sessionChanged) {
			resetRunViewForSession(handle);
			handle.activeTools.clear();
			handle.isStreaming = false;
		}
		update(handle);
		notifyWaiters(handle);
	}
	function recordCurrentFrame(handle: SubagentHandle): void {
		handle.lastIpcFrameAt = monotonicNow();
	}
	function startReconnectGrace(handle: SubagentHandle, at = monotonicNow()): void {
		handle.pendingHeartbeat = undefined;
		handle.disconnectedAt = at;
		handle.disconnectDeadlineAt = at + RECONNECT_GRACE_MS;
		handle.reconnecting = true;
		reconcileWatchdog();
	}
	async function attemptTerminalCleanup(handle: SubagentHandle): Promise<void> {
		if (handle.terminalCleanup.status !== "pending") return;
		await withTerminalCleanupLock(handle, async () => {
			if (handle.terminalCleanup.status !== "pending") return;
			let shouldPersist = false;
			try {
				if (!(await requireCurrentAuthority())) return;
				if (!handle.terminalStateDurable) {
					if (!(await persist())) {
						handle.terminalCleanup.nextAttemptAt =
							monotonicNow() + HEARTBEAT_SWEEP_MS;
						return;
					}
					handle.terminalStateDurable = true;
				}
				shouldPersist = true;
				handle.terminalCleanup.attempts++;
				if (!handle.zellijSessionName || handle.paneId === undefined) {
					const message = `Cannot clean up #${handle.id}: missing ${!handle.zellijSessionName ? "Zellij session name" : "terminal pane ID"}.`;
					handle.terminalCleanup = {
						status: "failed",
						attempts: handle.terminalCleanup.attempts,
						lastError: message,
					};
					addDiagnostic(handle, message);
					return;
				}
				await closePaneInSession(requireHandleDedicatedSession(handle), handle.paneId);
				handle.cleanupRequired = false;
				handle.terminalCleanup = { status: "complete", attempts: handle.terminalCleanup.attempts };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (/pane.*(not found|does not exist)|no such pane/i.test(message)) {
					handle.cleanupRequired = false;
					handle.terminalCleanup = { status: "complete", attempts: handle.terminalCleanup.attempts };
				} else if (handle.terminalCleanup.attempts >= CLEANUP_RETRY_DELAYS_MS.length) {
					handle.terminalCleanup = {
						status: "failed",
						attempts: handle.terminalCleanup.attempts,
						lastError: message,
					};
					addDiagnostic(handle, `Terminal cleanup failed: ${message}`);
				} else {
					handle.terminalCleanup.nextAttemptAt =
						monotonicNow() + CLEANUP_RETRY_DELAYS_MS[handle.terminalCleanup.attempts]!;
					handle.terminalCleanup.lastError = message;
					addDiagnostic(handle, `Terminal cleanup retry scheduled: ${message}`);
				}
			} finally {
				if (shouldPersist) await persist();
				reconcileWatchdog();
			}
		});
	}
	async function declareDead(
		handle: SubagentHandle,
		reason: "heartbeat_timeout" | "reconnect_timeout" | "quit" | "kill",
	): Promise<void> {
		if (!(await requireCurrentAuthority()) || handle.processState === "stopped") return;
		handle.deathReason = reason;
		handle.pendingHeartbeat = undefined;
		handle.disconnectedAt = undefined;
		handle.disconnectDeadlineAt = undefined;
		handle.reconnecting = false;
		rejectPendingAcks(handle, handle.ipcConn?.id || "", "Child IPC connection ended.");
		markStopped(handle, now(), {
			error:
				reason === "heartbeat_timeout"
					? "IPC heartbeat timed out."
					: reason === "reconnect_timeout"
						? "IPC reconnect grace expired."
						: undefined,
		});
		handle.cleanupRequired = true;
		handle.terminalStateDurable = false;
		handle.terminalCleanup = {
			status: "pending",
			attempts: 0,
			nextAttemptAt: monotonicNow(),
		};
		notifyWaiters(handle);
		await cleanupTransport(handle);
		update(handle, false);
		if (!(await persist())) {
			handle.terminalCleanup.nextAttemptAt = monotonicNow() + HEARTBEAT_SWEEP_MS;
			reconcileWatchdog();
			return;
		}
		handle.terminalStateDurable = true;
		await attemptTerminalCleanup(handle);
	}
	function enqueueAuthorizedMutation(
		handle: SubagentHandle,
		action: () => void | Promise<void>,
	): Promise<void> {
		if (handle.ipcMutationsClosed) return handle.ipcMutationChain;
		handle.ipcMutationChain = handle.ipcMutationChain
			.then(async () => {
				if (await requireCurrentAuthority()) await action();
			})
			.catch((error) =>
				addDiagnostic(
					handle,
					`Authorized IPC mutation failed: ${String(error)}`,
				),
			);
		return handle.ipcMutationChain;
	}
	async function attachServer(handle: SubagentHandle): Promise<void> {
		if (!(await requireCurrentAuthority()))
			throw new Error(leaseConflictMessage());
		await handle.ipcServer?.close().catch(() => {});
		handle.ipcServer = await startIpcServer(handle.socketPath, {
			onHello: (frame, conn) =>
				enqueueAuthorizedMutation(handle, () =>
					handleHello(handle, frame, conn),
				),
			onSnapshot: (frame, conn) =>
				enqueueAuthorizedMutation(handle, () => {
					if (
						frame.childId !== handle.id ||
						!isCurrentEpochWithOwner(handle, frame, conn) ||
						frame.sessionId !== handle.sessionId
					) {
						addDiagnostic(
							handle,
							"Ignored snapshot from a stale IPC connection or session epoch.",
						);
						return;
					}
					recordCurrentFrame(handle);
					if (frame.runId >= handle.runSequence) applySnapshot(handle, frame);
				}),
			onEvent: (frame: EventFrame, conn) =>
				enqueueAuthorizedMutation(handle, () => {
					if (
						frame.childId !== handle.id ||
						!isCurrentEpochWithOwner(handle, frame, conn)
					) {
						addDiagnostic(
							handle,
							"Ignored event from a stale IPC connection epoch.",
						);
						return;
					}
					recordCurrentFrame(handle);
					if (frame.event === "session_shutdown") return;
					dispatchSubagentEvent(
						handle,
						{ ...frame, type: frame.event },
						dispatchOptions(handle),
					);
				}),
			onAck: (frame, conn) =>
				enqueueAuthorizedMutation(handle, () => {
					if (
						frame.childId !== handle.id ||
						!isCurrentEpochWithOwner(handle, frame, conn)
					) {
						addDiagnostic(handle, "Ignored acknowledgement from a stale IPC connection epoch.");
						return;
					}
					recordCurrentFrame(handle);
					const pending = handle.pendingAcks.get(frame.id);
					if (
						!pending ||
						!acknowledgementMatchesConnectionEpoch(
							{
								parentConnectionId: handle.ipcConn?.id,
								childConnectionId: handle.connectionId,
							},
							frame,
							conn,
							pending,
						)
					) {
						addDiagnostic(handle, "Ignored acknowledgement without a current request.");
						return;
					}
					clearTimeout(pending.timer);
					handle.pendingAcks.delete(frame.id);
					pending.resolve(frame);
				}),
			onBye: (frame, conn) =>
				enqueueAuthorizedMutation(handle, () => {
					if (
						frame.childId !== handle.id ||
						!isCurrentEpochWithOwner(handle, frame, conn)
					)
						return;
					recordCurrentFrame(handle);
					addDiagnostic(handle, `Child connection closing for ${frame.reason}.`);
				}),
			onPong: (frame: PongFrame, conn) =>
				enqueueAuthorizedMutation(handle, () => {
					if (
						frame.childId !== handle.id ||
						!isCurrentEpochWithOwner(handle, frame, conn)
					)
						return;
					recordCurrentFrame(handle);
					const pending = handle.pendingHeartbeat;
					if (
						pending &&
						frame.id === pending.id &&
						pending.parentConnectionId === conn.id &&
						pending.childConnectionId === frame.connectionId
					)
						handle.pendingHeartbeat = undefined;
				}),
			onConnectionClose: (conn, hadBye, reason) =>
				enqueueAuthorizedMutation(handle, async () => {
					if (handle.processState === "stopped" || handle.ipcConn?.id !== conn.id)
						return;
					rejectPendingAcks(
						handle,
						conn.id,
						"Child IPC connection closed before acknowledgement.",
					);
					handle.ipcConn = undefined;
					if (hadBye && reason === "quit") {
						await declareDead(handle, "quit");
						return;
					}
					startReconnectGrace(handle);
					addDiagnostic(
						handle,
						`Child IPC disconnected${hadBye ? ` (${reason})` : ""}; awaiting reconnect.`,
					);
				}),
			onConnectionError: (_conn, error) =>
				addDiagnostic(handle, `IPC connection error: ${error.message}`),
			onDiagnostic: (message) => addDiagnostic(handle, message),
		});
	}
	function awaitReady(
		handle: SubagentHandle,
		timeoutMs = STARTUP_TIMEOUT_MS,
	): Promise<void> {
		if (handle.ipcConn && handle.actualModel && handle.sessionPath)
			return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				handle.waiters.delete(check);
				reject(
					new Error(`Timed out waiting for child #${handle.id} IPC hello.`),
				);
			}, timeoutMs);
			const check = () => {
				if (!handle.ipcConn || !handle.actualModel || !handle.sessionPath)
					return;
				clearTimeout(timer);
				handle.waiters.delete(check);
				resolve();
			};
			handle.waiters.add(check);
			check();
		});
	}
	async function sendMessage(
		handle: SubagentHandle,
		deliverAs: "followUp" | "steer",
		content: string,
	): Promise<AckFrame> {
		if (!(await requireCurrentAuthority()))
			throw new Error(leaseConflictMessage());
		if (handle.processState !== "alive")
			return Promise.reject(
				new Error(`Subagent #${handle.id} is no longer running.`),
			);
		if (!handle.ipcConn)
			return Promise.reject(
				new Error(`Subagent #${handle.id} is reconnecting and not ready.`),
			);
		const connection = handle.ipcConn;
		const connectionId = handle.connectionId;
		if (!connection || !connectionId)
			return Promise.reject(
				new Error(`Subagent #${handle.id} is reconnecting and not ready.`),
			);
		const id = `${handle.id}:${++handle.requestSequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				handle.pendingAcks.delete(id);
				reject(
					new Error(
						`${deliverAs === "steer" ? "Steer" : "Follow-up"} acknowledgement timed out; delivery may still have occurred.`,
					),
				);
			}, ACK_TIMEOUT_MS);
			handle.pendingAcks.set(id, {
				childConnectionId: connectionId,
				parentConnectionId: connection.id,
				resolve: (frame) =>
					frame.ok
						? resolve(frame)
						: reject(new Error(frame.error || "Child rejected message.")),
				reject,
				timer,
			});
			connection.send({
				type: "send",
				id,
				deliverAs,
				content,
				ownerSessionFile: handle.ownerSessionFile,
				ownerSessionId: handle.ownerSessionId,
				launchControllerInstanceId: handle.controllerInstanceId,
				incarnation: handle.incarnation,
			});
		});
	}
	async function interrupt(handle: SubagentHandle): Promise<boolean> {
		if (handle.processState !== "alive")
			throw new Error(`Subagent #${handle.id} is no longer running.`);
		const paneId = handle.paneId;
		if (paneId === undefined || !handle.zellijSessionName)
			throw new Error(`Subagent #${handle.id} stable pane identity is unavailable.`);
		if (!(await requireCurrentAuthority()))
			throw new Error(leaseConflictMessage());
		const cursor = handle.lastSettledRunId;
		await sendKeysInSession(requireHandleDedicatedSession(handle), paneId, "Esc");
		if (handle.runState === "idle") return true;
		const settled = await waitFor(
			[{ handle, cursor }],
			ABORT_ACK_TIMEOUT_MS / 1000,
			undefined,
		);
		if (settled !== "completed") {
			addDiagnostic(
				handle,
				"Esc interrupt did not settle within the acknowledgement deadline.",
			);
			return false;
		}
		return true;
	}
	async function cleanupTransport(handle: SubagentHandle): Promise<void> {
		const connection = handle.ipcConn;
		const server = handle.ipcServer;
		handle.ipcConn = undefined;
		handle.ipcServer = undefined;
		connection?.close();
		await server
			?.close()
			.catch((error) =>
				addDiagnostic(handle, `IPC cleanup failed: ${String(error)}`),
			);
		if (dirname(handle.socketPath) !== handle.sessionDir) {
			await fs
				.rmdir(dirname(handle.socketPath))
				.catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") {
						addDiagnostic(
							handle,
							`IPC fallback directory cleanup failed: ${error.message}`,
						);
					}
				});
		}
	}
	async function terminate(handle: SubagentHandle): Promise<SubagentHandle> {
		if (!(await requireCurrentAuthority()))
			throw new Error(leaseConflictMessage());
		if (handle.processState === "stopped") return handle;
		if (handle.terminationPromise) return handle.terminationPromise;
		handle.terminationPromise = (async () => {
			settlementNotifications.suppressChild(handle.id);
			requestKill(handle, now());
			update(handle, false);
			await interrupt(handle).catch((error) =>
				addDiagnostic(handle, `Interrupt before kill failed: ${String(error)}`),
			);
			await new Promise((resolve) => setTimeout(resolve, TERM_DEADLINE_MS));
			await enqueueAuthorizedMutation(handle, () => declareDead(handle, "kill"));
			handle.completedAt ||= now();
			await handle.settlementPersistenceChain;
			await persistenceChain;
			return handle;
		})();
		return handle.terminationPromise;
	}

	async function retireAfterUncertainChildLaunch(
		handle: SubagentHandle,
		error: unknown,
		removeHandleAfterSettlement: boolean,
	): Promise<never> {
		if (!dedicatedLifecycle) throw error;
		setDedicatedSessionStatus(latestCtx, undefined);
		const retiringLifecycle = dedicatedLifecycle;
		try {
			await retireDedicatedLifecycle(
				getAgentDir(),
				retiringLifecycle,
				() => settleChildrenAfterWholeSessionDeletion(retiringLifecycle.owner),
			);
			dedicatedLifecycle = undefined;
			if (removeHandleAfterSettlement && !handle.cleanupRequired)
				handles.delete(handle.id);
			await persist();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				`Child launch was uncertain (${error instanceof Error ? error.message : String(error)}) and whole-session cleanup remains pending.`,
			);
		}
		throw error;
	}

	async function launch(
		spec: TaskSpec,
		cwd: string,
		requestedModel: string,
		requestedThinking: ThinkingLevel,
		ctx: ExtensionContext,
	): Promise<SubagentHandle> {
		const zellijSessionName = await ensureDedicatedSession(ctx);
		if (!(await requireCurrentAuthority()))
			throw new Error(leaseConflictMessage());
		const resolvedOwner = owner;
		if (!resolvedOwner)
			throw new Error("Controller owner identity is not established.");
		const stat = await fs.stat(cwd).catch(() => undefined);
		if (!stat?.isDirectory())
			throw new Error(
				`Subagent cwd does not exist or is not a directory: ${cwd}`,
			);
		const id = createId();
		const incarnation = createId();
		const sessionDir = join(getAgentDir(), "sessions", "subagents", id);
		await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
		await fs.chmod(sessionDir, 0o700).catch(() => {});
		const preferredSocket = incarnationSocketDir(
			getAgentDir(),
			resolvedOwner,
			id,
			incarnation,
		);
		const socketPath = await prepareIpcSocketPath(
			preferredSocket,
			`${id}-${incarnation.slice(0, 8)}`,
		);
		const handle = createHandle({
			childId: id,
			name: spec.name?.trim() || undefined,
			task: spec.task,
			cwd,
			sessionDir,
			socketPath,
			requestedModel,
			requestedThinking,
			zellijSessionName,
			processState: "alive",
			runState: "idle",
			createdAt: now(),
			lastActivityAt: now(),
			ownerSessionFile: resolvedOwner.ownerSessionFile,
			ownerSessionId: resolvedOwner.ownerSessionId,
			controllerInstanceId,
			incarnation,
		});
		handles.set(id, handle);
		await attachServer(handle);
		await persist();
		let launchPresenceUncertain = false;
		try {
			const command = getPiInvocation([
				"-e",
				childExtensionPath,
				"--session-dir",
				sessionDir,
				"--model",
				requestedModel,
				"--thinking",
				requestedThinking,
			]);
			const env = {
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_CHILD_ID: id,
				PI_SUBAGENT_OWNER_SESSION_FILE: resolvedOwner.ownerSessionFile,
				PI_SUBAGENT_OWNER_SESSION_ID: resolvedOwner.ownerSessionId,
				PI_SUBAGENT_CONTROLLER_INSTANCE_ID: controllerInstanceId,
				PI_SUBAGENT_INCARNATION: incarnation,
				PI_SUBAGENT_RUN_ID_BASE: "0",
				PI_SUBAGENT_SYSTEM_PROMPT: spec.systemPrompt || "",
				PI_SUBAGENT_DEPTH: String(getDepth() + 1),
				PI_SUBAGENT_PROMPT_PATH: handle.promptPath,
				PI_SUBAGENT_SESSION_DIR: handle.sessionDir,
				BRIDGE_SOCKET_PATH: socketPath,
				BRIDGE_LOG_PATH: join(sessionDir, "child-events.log"),
				TERM: "xterm-256color",
			};
			launchPresenceUncertain = true;
			const launched = await newTabInSession(
				zellijSessionName,
				spec.name?.trim() || `subagent-${id.slice(0, 8)}`,
				cwd,
				command,
				env,
			);
			handle.tabId = launched.tabId;
			handle.zellijSessionName = launched.sessionName;
			handle.paneId = await discoverPaneIdInSession(zellijSessionName, handle.tabId, paneIdentity(handle));
			launchPresenceUncertain = false;
			update(handle);
			await awaitReady(handle);
			const before = handle.runSequence;
			await sendMessage(handle, "followUp", spec.task);
			await waitUntil(
				() => handle.runSequence > before || handle.processState === "stopped",
				1000,
			);
			return handle;
		} catch (error) {
			addDiagnostic(
				handle,
				`Child startup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (launchPresenceUncertain)
				return retireAfterUncertainChildLaunch(handle, error, true);
			await terminate(handle).catch(() => {});
			if (!handle.cleanupRequired) handles.delete(id);
			await persist();
			throw error;
		}
	}

	async function resumeChild(
		handle: SubagentHandle,
		task: string | undefined,
		ctx?: ExtensionContext,
	): Promise<void> {
		if (handle.cleanupRequired)
			throw new Error(
				`Subagent #${handle.id} has required terminal cleanup. Resume is blocked until cleanup completes.`,
			);
		const zellijSessionName = await ensureDedicatedSession(ctx);
		if (!(await requireCurrentAuthority()))
			throw new Error(leaseConflictMessage());
		const resolvedOwner = owner;
		if (!resolvedOwner)
			throw new Error("Controller owner identity is not established.");
		const sessionFile = handle.sessionPath;
		if (!sessionFile)
			throw new Error(
				`No usable child session file exists for #${handle.id}; resume is not possible.`,
			);
		const usable = await fs
			.stat(sessionFile)
			.then((s) => s.isFile() && s.size > 0)
			.catch(() => false);
		if (!usable)
			throw new Error(
				`No usable child session file exists for #${handle.id}; resume is not possible.`,
			);
		const oldIncarnation = handle.incarnation;
		const incarnation = createId();
		const preferredSocket = incarnationSocketDir(
			getAgentDir(),
			resolvedOwner,
			handle.id,
			incarnation,
		);
		const socketPath = await prepareIpcSocketPath(
			preferredSocket,
			`${handle.id}-${incarnation.slice(0, 8)}`,
		);
		handle.incarnation = incarnation;
		handle.controllerInstanceId = controllerInstanceId;
		handle.socketPath = socketPath;
		handle.zellijSessionName = zellijSessionName;
		handle.resumedFrom = oldIncarnation;
		reviveForResume(handle);
		handle.completedAt = undefined;
		handle.error = undefined;
		handle.stopReason = undefined;
		handle.reconnecting = false;
		handle.terminationPromise = undefined;
		handle.seenHelloConnections = new Set();
		handle.pendingAcks = new Map();
		handle.ipcConn = undefined;
		handle.ipcReadyAt = undefined;
		handle.exitCode = undefined;
		handle.pendingHeartbeat = undefined;
		handle.disconnectedAt = undefined;
		handle.disconnectDeadlineAt = undefined;
		handle.deathReason = undefined;
		handle.terminalCleanup = { status: "none", attempts: 0 };
		handle.terminalStateDurable = false;
		handle.ipcMutationsClosed = false;
		handle.lastIpcFrameAt = monotonicNow();
		await attachServer(handle);
		let launchPresenceUncertain = false;
		try {
			const command = getPiInvocation([
				"--session",
				sessionFile,
				"-e",
				childExtensionPath,
				"--session-dir",
				handle.sessionDir,
				"--model",
				handle.requestedModel,
				"--thinking",
				handle.requestedThinking,
			]);
			const env = {
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_CHILD_ID: handle.id,
				PI_SUBAGENT_OWNER_SESSION_FILE: resolvedOwner.ownerSessionFile,
				PI_SUBAGENT_OWNER_SESSION_ID: resolvedOwner.ownerSessionId,
				PI_SUBAGENT_CONTROLLER_INSTANCE_ID: controllerInstanceId,
				PI_SUBAGENT_INCARNATION: incarnation,
				PI_SUBAGENT_RUN_ID_BASE: String(handle.runSequence),
				PI_SUBAGENT_SYSTEM_PROMPT: "",
				PI_SUBAGENT_DEPTH: String(getDepth() + 1),
				PI_SUBAGENT_PROMPT_PATH: handle.promptPath,
				PI_SUBAGENT_SESSION_DIR: handle.sessionDir,
				BRIDGE_SOCKET_PATH: socketPath,
				BRIDGE_LOG_PATH: join(handle.sessionDir, "child-events.log"),
				TERM: "xterm-256color",
			};
			launchPresenceUncertain = true;
			const launched = await newTabInSession(
				zellijSessionName,
				handle.name || `subagent-${handle.id.slice(0, 8)}`,
				handle.cwd,
				command,
				env,
			);
			handle.tabId = launched.tabId;
			handle.zellijSessionName = launched.sessionName;
			handle.paneId = await discoverPaneIdInSession(zellijSessionName, handle.tabId, paneIdentity(handle));
			launchPresenceUncertain = false;
			update(handle);
			await awaitReady(handle);
			if (task) {
				const before = handle.runSequence;
				await sendMessage(handle, "followUp", task);
				await waitUntil(
					() =>
						handle.runSequence > before || handle.processState === "stopped",
					1000,
				);
			}
		} catch (error) {
			addDiagnostic(
				handle,
				`Child resume failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (launchPresenceUncertain)
				return retireAfterUncertainChildLaunch(handle, error, false);
			await terminate(handle).catch(() => {});
			throw error;
		}
	}
	function waitUntil(
		predicate: () => boolean,
		timeoutMs: number,
	): Promise<void> {
		return new Promise((resolve) => {
			if (predicate()) return resolve();
			const deadline = now() + timeoutMs;
			const timer = setInterval(() => {
				if (predicate() || now() >= deadline) {
					clearInterval(timer);
					resolve();
				}
			}, 20);
		});
	}
	async function waitFor(
		targets: {
			handle: SubagentHandle;
			cursor: number;
			settledRunId?: number;
		}[],
		timeoutSeconds: number,
		signal: AbortSignal | undefined,
	): Promise<"completed" | "timedOut" | "canceled"> {
		const done = () =>
			targets.every((target) => {
				if (target.handle.lastSettledRunId > target.cursor) {
					target.settledRunId ||= target.handle.lastSettledRunId;
					return true;
				}
				return target.handle.processState === "stopped";
			});
		if (done()) return "completed";
		return new Promise((resolve) => {
			let finished = false;
			const waiters = new Map<SubagentHandle, () => void>();
			const finish = (value: "completed" | "timedOut" | "canceled") => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				for (const [handle, waiter] of waiters) handle.waiters.delete(waiter);
				resolve(value);
			};
			const check = () => {
				if (done()) finish("completed");
			};
			for (const { handle } of targets) {
				const waiter = () => check();
				waiters.set(handle, waiter);
				handle.waiters.add(waiter);
			}
			const timer = setTimeout(() => finish("timedOut"), timeoutSeconds * 1000);
			const abort = () => finish("canceled");
			if (signal?.aborted) finish("canceled");
			else signal?.addEventListener("abort", abort, { once: true });
			check();
		});
	}

	function getDepth() {
		return Math.max(
			0,
			Number.parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10) || 0,
		);
	}
	function selectedModel(
		ctx: ExtensionContext,
		spec: TaskSpec,
	): { model?: string; thinking?: ThinkingLevel; error?: string } {
		const raw = spec.model;
		if (!raw || !spec.thinking)
			return { error: "Subagent model and thinking are required." };
		const all = ctx.modelRegistry.getAll();
		const matches = raw.includes("/")
			? all.filter(
					(model) =>
						`${model.provider}/${model.id}`.toLowerCase() === raw.toLowerCase(),
				)
			: all.filter((model) => model.id.toLowerCase() === raw.toLowerCase());
		if (matches.length !== 1)
			return {
				error:
					matches.length > 1
						? `Model ${raw} is ambiguous; use provider/model.`
						: `Unknown model ${raw}. Use list_models.`,
			};
		const available = new Set(
			ctx.modelRegistry
				.getAvailable()
				.map((model) => `${model.provider}/${model.id}`),
		);
		const match = matches[0];
		if (!match) return { error: `Unknown model ${raw}. Use list_models.` };
		const ref = `${match.provider}/${match.id}`;
		if (!available.has(ref))
			return { error: `Model ${ref} is known but unavailable.` };
		const thinking = spec.thinking;
		if (!isThinking(thinking))
			return { error: `Invalid thinking level ${String(thinking)}.` };
		return { model: ref, thinking };
	}

	async function reconcile() {
		if (!owner || !(await requireCurrentAuthority())) return;
		const path = ownerRegistryPath(getAgentDir(), owner);
		const saved = registryEntriesForOwner(await loadRegistry(path), owner);
		for (const entry of saved) {
			const existing = handles.get(entry.childId);
			const handle = existing || createHandle(entry);
			if (!existing) handles.set(handle.id, handle);
			if (handle.processState === "alive" && !handle.ipcServer) {
				startReconnectGrace(handle);
				await attachServer(handle).catch((error) => {
					addDiagnostic(handle, `Reattach listener failed: ${String(error)}`);
				});
			}
			if (handle.cleanupRequired) {
				handle.terminalCleanup.status = "pending";
				handle.terminalCleanup.nextAttemptAt = monotonicNow();
				void attemptTerminalCleanup(handle);
			}
		}
		await persist();
		reconcileWatchdog();
		refreshUi();
	}
	function toInspector(handle: SubagentHandle): InspectorHandle {
		const actualModel = handle.actualModel || {
			provider: handle.requestedModel.split("/")[0] || "unknown",
			id: handle.requestedModel.split("/")[1] || handle.requestedModel,
		};
		return {
			id: handle.id,
			name: handle.name,
			state: handle.state,
			lifecycle: handle.lifecycle,
			processState: handle.processState,
			runState: handle.runState,
			runId: handle.runSequence || undefined,
			tabId: handle.tabId,
			paneId: handle.paneId,
			reconnecting: handle.reconnecting,
			killing: handle.lifecycle === "killing",
			task: handle.task,
			cwd: handle.cwd,
			pid: handle.pid,
			exitCode: handle.exitCode,
			requestedModel: handle.requestedModel,
			requestedThinking: handle.requestedThinking,
			actualModel,
			actualThinking: handle.actualThinking || handle.requestedThinking,
			sessionPath: handle.sessionPath || "",
			promptPath: handle.promptPath,
			resultPath: handle.resultPath,
			resultKind: resultKind(handle),
			transcriptNote: handle.transcriptPersisted
				? "persisted transcript available"
				: "no persisted transcript yet",
			createdAt: handle.createdAt,
			ipcReadyAt: handle.ipcReadyAt,
			agentStartedAt: handle.agentStartedAt,
			lastActivityAt: handle.lastActivityAt,
			completedAt: handle.completedAt,
			currentTool: handle.currentTool,
			currentToolStartedAt: handle.currentToolStartedAt,
			lastTool: handle.lastTool,
			isStreaming: handle.isStreaming,
			usage: { ...handle.usage },
			stopReason: handle.stopReason,
			error:
				handle.terminalCleanup.status === "failed"
					? handle.terminalCleanup.lastError
					: handle.error,
			tentativeError: handle.tentativeError,
			finalError: handle.finalError,
			settledAt: handle.settledAt,
			resultPreview: truncate(handle.resultText),
			currentAssistantText: handle.currentAssistantText,
			latestAssistantText: handle.latestAssistantText,
			activeTools: [...handle.activeTools.values()].map((tool) => ({
				...tool,
			})),
			recentTools: handle.recentTools.map((tool) => ({ ...tool })),
		};
	}
	function refreshUi() {
		activeInspector?.refresh();
		const ctx = latestCtx;
		if (ctx?.mode !== "tui") return;
		const running = sorted().filter(active);
		if (!widgetVisible || !running.length) {
			ctx.ui.setWidget("subagent", undefined);
			return;
		}
		ctx.ui.setWidget(
			"subagent",
			running
				.slice(0, 12)
				.map(
					(handle) =>
						`${handle.processState === "alive" ? "●" : "○"} ${handle.id.slice(0, 8)}${handle.name ? ` ${handle.name}` : ""} · ${handle.processState}/${handle.runState} · ${lifecycleActivity(handle, handle)}`,
				),
		);
	}

	function stopTimers() {
		if (leaseRenewTimer) {
			clearInterval(leaseRenewTimer);
			leaseRenewTimer = undefined;
		}
		if (watchdogTimer) {
			clearTimeout(watchdogTimer);
			watchdogTimer = undefined;
		}
	}
	function startLeaseRenewal() {
		if (leaseRenewTimer) clearInterval(leaseRenewTimer);
		leaseRenewTimer = setInterval(() => {
			if (!owner || !leaseHeld) return;
			void renewLease(getAgentDir(), owner, controllerInstanceId, now()).then(
				(ok) => {
					if (!ok) {
						leaseHeld = false;
						suppressAllSettlementNotifications();
						setDedicatedSessionStatus(latestCtx, undefined);
						for (const handle of handles.values())
							addDiagnostic(handle, "Controller lease lost during renewal.");
						stopTimers();
						refreshUi();
					}
				},
				(error) => {
					for (const handle of handles.values())
						addDiagnostic(
							handle,
							`Lease renewal failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					leaseHeld = false;
					suppressAllSettlementNotifications();
					setDedicatedSessionStatus(latestCtx, undefined);
					stopTimers();
				},
			);
		}, LEASE_RENEW_INTERVAL_MS);
		leaseRenewTimer.unref();
	}
	function watchdogNeeded() {
		return [...handles.values()].some(
			(handle) =>
				handle.processState === "alive" || handle.terminalCleanup.status === "pending",
		);
	}
	function reconcileWatchdog() {
		if (watchdogTimer) {
			clearTimeout(watchdogTimer);
			watchdogTimer = undefined;
		}
		if (!leaseHeld || !watchdogNeeded()) return;
		const current = monotonicNow();
		const cleanupDelay = [...handles.values()]
			.filter(
				(handle) =>
					handle.terminalCleanup.status === "pending" &&
					handle.terminalCleanup.nextAttemptAt !== undefined,
			)
			.map((handle) => Math.max(0, handle.terminalCleanup.nextAttemptAt! - current))
			.reduce((minimum, delay) => Math.min(minimum, delay), HEARTBEAT_SWEEP_MS);
		watchdogTimer = setTimeout(
			() => void watchdogSweep(),
			Math.min(HEARTBEAT_SWEEP_MS, cleanupDelay),
		);
		watchdogTimer.unref();
	}
	async function watchdogSweep(): Promise<void> {
		if (watchdogSweepActive) return;
		watchdogSweepActive = true;
		try {
			if (!owner || !(await requireCurrentAuthority())) return;
			const current = monotonicNow();
			const stalled = parentStalled(lastWatchdogSweepAt, current);
			lastWatchdogSweepAt = current;
			const decisions = [...handles.values()].map((handle) =>
				enqueueAuthorizedMutation(handle, async () => {
					const at = monotonicNow();
					if (handle.terminalCleanup.status === "pending") {
						if (
							handle.terminalCleanup.nextAttemptAt === undefined ||
							handle.terminalCleanup.nextAttemptAt <= at
							)
							await attemptTerminalCleanup(handle);
						return;
					}
					if (handle.processState !== "alive") return;
					if (stalled) {
						if (handle.ipcConn) {
							handle.pendingHeartbeat = undefined;
							handle.lastIpcFrameAt = at;
						} else startReconnectGrace(handle, at);
						addDiagnostic(handle, "Watchdog stall reset the IPC observation window.");
						return;
					}
					if (
						heartbeatExpired(
							handle.pendingHeartbeat,
							at,
							handle.ipcConn?.id,
							handle.connectionId,
						)
					) {
						await declareDead(handle, "heartbeat_timeout");
						return;
					}
					if (reconnectExpired(handle.disconnectDeadlineAt, at, !!handle.ipcConn)) {
						await declareDead(handle, "reconnect_timeout");
						return;
					}
					if (
						pingDue(
							{
								processState: handle.processState,
								connected: !!handle.ipcConn && !!handle.connectionId,
								lastIpcFrameAt: handle.lastIpcFrameAt,
								pendingHeartbeat: handle.pendingHeartbeat,
							},
							at,
						) &&
						handle.ipcConn &&
						handle.connectionId
					) {
						const connection = handle.ipcConn;
						const childConnectionId = handle.connectionId;
						const id = createId();
						handle.pendingHeartbeat = {
							id,
							sentAt: at,
							deadlineAt: at + HEARTBEAT_RESPONSE_MS,
							parentConnectionId: connection.id,
							childConnectionId,
						};
						try {
							connection.send({
								type: "ping",
								id,
								ownerSessionFile: handle.ownerSessionFile,
								ownerSessionId: handle.ownerSessionId,
								launchControllerInstanceId: handle.controllerInstanceId,
								incarnation: handle.incarnation,
							});
						} catch {
							if (handle.ipcConn?.id === connection.id) {
								handle.ipcConn = undefined;
								startReconnectGrace(handle, at);
							}
						}
					}
				}),
			);
			await Promise.all(decisions);
		} finally {
			watchdogSweepActive = false;
			reconcileWatchdog();
		}
	}

	const cleanupLease = (leaseOwner: OwnerIdentity): RetainedCleanupLease => ({
		agentDir: getAgentDir(),
		owner: leaseOwner,
		controllerInstanceId,
	});

	async function establishController(ctx: ExtensionContext): Promise<void> {
		const sessionFile = ctx.sessionManager?.getSessionFile();
		const sessionId = ctx.sessionManager?.getSessionId();
		if (!sessionFile || !sessionId) {
			owner = null;
			leaseHeld = false;
			setDedicatedSessionStatus(ctx, undefined);
			return;
		}
		const canonicalSessionFile = await canonicalOwnerSessionFile(sessionFile);
		const resolved: OwnerIdentity = {
			ownerSessionFile: canonicalSessionFile,
			ownerSessionId: sessionId,
		};
		if (!(await ensureRetainedCleanupLeaseAuthority())) {
			owner = null;
			leaseHeld = false;
			setDedicatedSessionStatus(ctx, undefined);
			throw new Error(
				"Retiring subagent cleanup authority is unavailable; refusing to provision a new owner.",
			);
		}
		const resolvedLease = cleanupLease(resolved);
		const resolvedWasRetained = retainedCleanupLeaseExists(resolvedLease);
		const result = await acquireLease(
			getAgentDir(),
			resolved,
			controllerInstanceId,
			now(),
		);
		if (result.held) {
			owner = resolved;
			leaseHeld = true;
			try {
				dedicatedLifecycle = await establishDedicatedLifecycle(
					getAgentDir(),
					resolved,
					controllerInstanceId,
					now(),
					(error) => {
						setDedicatedSessionStatus(latestCtx, undefined);
						console.error(`Subagent Zellij guardian failed: ${error.message}`);
					},
					() => settleChildrenAfterWholeSessionDeletion(resolved),
					(cleanupOwner) => hasLeaseAuthority(
						getAgentDir(),
						cleanupOwner,
						controllerInstanceId,
						now(),
					),
				);
				setDedicatedSessionStatus(ctx, dedicatedLifecycle.record.sessionName);
				await resolveRetainedCleanupLeases(resolvedLease);
				startLeaseRenewal();
			} catch (error) {
				leaseHeld = false;
				setDedicatedSessionStatus(ctx, undefined);
				if (hasPendingDedicatedRetirement(resolved, controllerInstanceId)) {
					const retained = await retainCleanupLease(resolvedLease);
					if (!retained)
						console.error(
							"Subagent startup cleanup authority is unavailable; provisioning remains blocked.",
						);
				} else if (!resolvedWasRetained) {
					await releaseLease(getAgentDir(), resolved, controllerInstanceId);
				}
				owner = null;
				throw error;
			}
		} else {
			owner = null;
			leaseHeld = false;
			setDedicatedSessionStatus(ctx, undefined);
			console.error(
				`Subagent controller lease held by another Pi process for this session. Wait for it to exit or expire, then reload.`,
			);
		}
	}

	function leaseConflictMessage(): string {
		return "Controller lease is not held; another Pi process may own this session. Wait for it to exit or expire, then reload.";
	}

	function releaseLeaseIfHeld() {
		if (!owner || !leaseHeld) return Promise.resolve();
		return releaseLease(getAgentDir(), owner, controllerInstanceId);
	}

	/** The session is absent before this runs, so every child incarnation is terminal. */
	async function settleChildrenAfterWholeSessionDeletion(settlementOwner: OwnerIdentity): Promise<void> {
		// Recovery may run before normal reconcile or after the extension has
		// switched owners. Capture and write the retiring owner's registry rather
		// than consulting mutable controller ownership.
		const saved = registryEntriesForOwner(
			await loadRegistry(ownerRegistryPath(getAgentDir(), settlementOwner)),
			settlementOwner,
		);
		const settlementHandles = new Map(
			saved.map((entry) => [entry.childId, createHandle(entry)]),
		);
		for (const handle of handles.values())
			if (
				handle.ownerSessionFile === settlementOwner.ownerSessionFile &&
				handle.ownerSessionId === settlementOwner.ownerSessionId
			)
				settlementHandles.set(handle.id, handle);
		for (const handle of settlementHandles.values()) {
			rejectPendingAcks(handle, handle.ipcConn?.id || "", "Dedicated Zellij session was deleted.");
			await closeAndDrainIpcMutations(handle, () => cleanupTransport(handle));
			if (handle.processState !== "stopped") markStopped(handle, now());
			handle.cleanupRequired = false;
			handle.terminalStateDurable = true;
			handle.terminalCleanup = {
				status: "complete",
				attempts: Math.max(1, handle.terminalCleanup.attempts),
			};
			notifyWaiters(handle);
		}
		await Promise.all([...settlementHandles.values()].map((handle) => handle.settlementPersistenceChain));
		await persistenceChain;
		await saveRegistry(
			[...settlementHandles.values()].map(registryEntry),
			ownerRegistryPath(getAgentDir(), settlementOwner),
		);
		reconcileWatchdog();
		refreshUi();
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionShuttingDown = false;
		latestCtx = ctx;
		await establishController(ctx);
		await reconcile().catch((error) =>
			console.error(`Subagent reconcile failed: ${String(error)}`),
		);
		reconcileWatchdog();
		refreshUi();
	});
	pi.on("session_shutdown", async (event, ctx) => {
		sessionShuttingDown = true;
		suppressAllSettlementNotifications();
		latestCtx = ctx;
		const reason = event?.reason || "quit";
		if (reason !== "reload") setDedicatedSessionStatus(ctx, undefined);
		if (reason === "quit") {
			stopTimers();
			if (dedicatedLifecycle && await requireCurrentAuthority()) {
				const retiringLifecycle = dedicatedLifecycle;
				try {
					await retireDedicatedLifecycle(
						getAgentDir(),
						retiringLifecycle,
						() => settleChildrenAfterWholeSessionDeletion(retiringLifecycle.owner),
					);
					dedicatedLifecycle = undefined;
				} catch (error) {
					console.error(`Subagent dedicated Zellij cleanup failed: ${String(error)}`);
				}
			}
			await releaseLeaseIfHeld();
			await releaseRetainedCleanupLeasesForQuit();
		} else if (reason === "reload") {
			stopTimers();
			if (owner) preserveDedicatedLifecycleForReload(owner, controllerInstanceId);
			for (const handle of handles.values()) {
				handle.reconnecting = true;
				await handle.ipcServer?.close().catch(() => {});
				handle.ipcServer = undefined;
				handle.ipcConn = undefined;
			}
		} else {
			let retirementSucceeded = !dedicatedLifecycle;
			if (dedicatedLifecycle) {
				const retiringLifecycle = dedicatedLifecycle;
				// Transfer renewal to process-global retained authority before the
				// attempt can block or the extension-local timer is stopped.
				const retained = await retainCleanupLease(cleanupLease(retiringLifecycle.owner));
				stopTimers();
				if (!retained)
					console.error(
						"Subagent retiring-owner lease authority is unavailable; later provisioning will remain blocked.",
					);
				if (retained && await requireCurrentAuthority()) {
					try {
						await retireDedicatedLifecycle(
							getAgentDir(),
							retiringLifecycle,
							() => settleChildrenAfterWholeSessionDeletion(retiringLifecycle.owner),
						);
						dedicatedLifecycle = undefined;
						retirementSucceeded = true;
						await resolveRetainedCleanupLeases();
					} catch (error) {
						console.error(`Subagent dedicated Zellij cleanup failed: ${String(error)}`);
					}
				}
			} else {
				stopTimers();
			}
			for (const handle of handles.values()) {
				handle.reconnecting = true;
				await handle.ipcServer?.close().catch(() => {});
				handle.ipcServer = undefined;
				handle.ipcConn = undefined;
			}
			handles.clear();
			if (retirementSucceeded) await releaseLeaseIfHeld();
			owner = null;
			leaseHeld = false;
		}
		await persist();
		if (ctx.mode === "tui") ctx.ui.setWidget("subagent", undefined);
		latestCtx = null;
	});
	pi.on("before_agent_start", async (event) => ({
		systemPrompt:
			event.systemPrompt +
			`\n\nSubagent extension is available. Use it only for explicit delegation. subagent_start requires an explicit provider/model and thinking level; use list_models when needed instead of guessing. Children are persistent interactive Pi TUIs in tabs of a dedicated Pi-owned Zellij session. Start a child, then continue other work or end the current turn. Settlement notifications arrive automatically while children remain alive and start a follow-up turn. Use subagent_result with the child ID and run ID from the notification for exact settled output. Do not poll for routine completion. Use subagent_status for live diagnostics. Use subagent_follow_up for another turn, subagent_steer during a run, subagent_interrupt to abort a run while keeping the child alive, and subagent_kill only to terminate.`,
	}));

	pi.registerTool<typeof TaskSpecSchema, unknown>({
		name: "subagent_start",
		label: "Subagent Start",
		description:
			"Start a persistent interactive Pi TUI with an explicit model and thinking level in a new tab of the dedicated Pi-owned Zellij session after a bounded IPC handshake. Settlement notifications start a follow-up turn when the child finishes. Do not poll for completion. Call subagent_kill when the child is no longer useful.",
		parameters: TaskSpecSchema,
		async execute(_id, params, _signal, _update, ctx) {
			latestCtx = ctx;
			if (getDepth() > 0)
				return {
					content: [
						{
							type: "text" as const,
							text: "subagent_start is disabled inside delegated subagents.",
						},
					],
					details: { nestedDelegationBlocked: true },
				};
			const spec = params as TaskSpec;
			const choice = selectedModel(ctx, spec);
			if (!choice.model || !choice.thinking)
				return {
					content: [
						{
							type: "text" as const,
							text: choice.error || "Invalid subagent configuration.",
						},
					],
					details: {},
				};
			try {
				const handle = await launch(
					spec,
					spec.cwd || ctx.cwd,
					choice.model,
					choice.thinking,
					ctx,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Started persistent subagent #${handle.id} in Zellij tab ${handle.tabId}, pane ${handle.paneId}.`,
						},
					],
					details: { handle: await serialize(handle) },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: error instanceof Error ? error.message : String(error),
						},
					],
					details: {},
				};
			}
		},
	});
	pi.registerTool<typeof ListSchema, unknown>({
		name: "subagent_list",
		label: "Subagent List",
		description: "List current and retained persistent subagents.",
		parameters: ListSchema,
		async execute(_id, params) {
			const chosen = sorted().filter(
				(handle) => (params.includeFinished ?? true) || active(handle),
			);
			return {
				content: [
					{
						type: "text" as const,
						text: chosen.length
							? (await Promise.all(chosen.map(summary))).join("\n\n")
							: "No subagents tracked yet.",
					},
				],
				details: { handles: await Promise.all(chosen.map(serialize)) },
			};
		},
	});
	pi.registerTool<typeof StatusSchema, unknown>({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Return process/run lifecycle, live activity, Zellij identity, and artifacts.",
		parameters: StatusSchema,
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown subagent id: ${params.id}`,
						},
					],
					details: {},
				};
			const serial = await serialize(handle);
			return {
				content: [{ type: "text" as const, text: await summary(handle) }],
				details: {
					...serial,
					timestamps: {
						createdAt: serial.createdAt,
						ipcReadyAt: serial.ipcReadyAt,
						agentStartedAt: serial.agentStartedAt,
						lastActivityAt: serial.lastActivityAt,
						completedAt: serial.completedAt,
					},
					activity: {
						currentTool: serial.currentTool,
						lastTool: serial.lastTool,
						streaming: serial.isStreaming,
					},
				},
			};
		},
	});
	pi.registerTool<typeof ResultSchema, unknown>({
		name: "subagent_result",
		label: "Subagent Result",
		description:
			"Return the exact persisted output and outcome for one child run. This retrieval is idempotent and never falls back to another run.",
		parameters: ResultSchema,
		renderResult(result, options, theme) {
			const text = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			const lines = text.split("\n");
			const visibleText =
				options.expanded || lines.length <= SUBAGENT_RESULT_PREVIEW_LINES
					? text
					: `${lines.slice(0, SUBAGENT_RESULT_PREVIEW_LINES).join("\n")}\n${theme.fg("dim", "...")}`;
			return new Text(visibleText, 0, 0);
		},
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown subagent id: ${params.id}`,
						},
					],
					details: {
						status: "unknown_child",
						reason: "unknown_child",
						available: false,
						childId: params.id,
						runId: params.runId,
					},
				};
			await handle.settlementPersistenceChain;
			const exact = await readRunResult(handle.sessionDir, params.runId);
			if (exact.status === "available")
				return {
					content: [{ type: "text" as const, text: exact.record.result }],
					details: {
						status: "available",
						reason: exact.reason,
						available: true,
						childId: handle.id,
						...exact.record,
					},
				};
			if (
				params.runId === handle.runSequence &&
				handle.processState === "alive" &&
				handle.runState !== "idle"
			)
				return {
					content: [
						{
							type: "text" as const,
							text: `Subagent #${handle.id} run ${params.runId} is active.`,
						},
					],
					details: {
						status: "pending",
						reason: "run_active",
						available: false,
						childId: handle.id,
						runId: params.runId,
					},
				};
			const reason =
				exact.status === "missing" && params.runId > handle.runSequence
					? "run_not_known"
					: exact.reason;
			return {
				content: [
					{
						type: "text" as const,
						text: exact.message,
					},
				],
				details: {
					status: exact.status,
					reason,
					available: false,
					childId: handle.id,
					runId: params.runId,
					resultPath: exact.resultPath,
					metadataPath: exact.metadataPath,
				},
			};
		},
	});
	pi.registerTool<typeof MessageSchema, unknown>({
		name: "subagent_steer",
		label: "Subagent Steer",
		description: "Deliver guidance during a running child turn over IPC.",
		parameters: MessageSchema,
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown subagent id: ${params.id}`,
						},
					],
					details: {},
				};
			try {
				const ack = await sendMessage(handle, "steer", params.message.trim());
				return {
					content: [
						{
							type: "text" as const,
							text: `Steering accepted by #${handle.id}.`,
						},
					],
					details: {
						handle: await serialize(handle),
						accepted: true,
						queued: ack.queued,
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: String(error) }],
					details: { accepted: false },
				};
			}
		},
	});
	pi.registerTool<typeof MessageSchema, unknown>({
		name: "subagent_follow_up",
		label: "Subagent Follow Up",
		description: "Send another user turn to a live persistent child over IPC.",
		parameters: MessageSchema,
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown subagent id: ${params.id}`,
						},
					],
					details: {},
				};
			try {
				const before = handle.runSequence;
				const ack = await sendMessage(
					handle,
					"followUp",
					params.message.trim(),
				);
				await waitUntil(
					() =>
						handle.runSequence > before || handle.processState === "stopped",
					1000,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Follow-up accepted by #${handle.id}.`,
						},
					],
					details: {
						handle: await serialize(handle),
						accepted: true,
						queued: ack.queued,
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: String(error) }],
					details: { accepted: false },
				};
			}
		},
	});
	pi.registerTool<typeof IdSchema, unknown>({
		name: "subagent_interrupt",
		label: "Subagent Interrupt",
		description:
			"Cooperatively abort the current run with Esc while keeping the child process alive.",
		parameters: IdSchema,
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown subagent id: ${params.id}`,
						},
					],
					details: {},
				};
			try {
				const interrupted = await interrupt(handle);
				return {
					content: [
						{
							type: "text" as const,
							text: interrupted
								? `Interrupted #${handle.id}; child remains alive.`
								: `Esc sent to #${handle.id}, but settlement acknowledgement timed out.`,
						},
					],
					details: { handle: await serialize(handle), interrupted },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: String(error) }],
					details: { interrupted: false },
				};
			}
		},
	});
	pi.registerTool<typeof IdSchema, unknown>({
		name: "subagent_kill",
		label: "Subagent Kill",
		description:
			"Terminate the child tab after cooperative interrupt and bounded escalation. Use this cleanup action for completed or abandoned children.",
		parameters: IdSchema,
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown subagent id: ${params.id}`,
						},
					],
					details: {},
				};
			if (!active(handle))
				return {
					content: [
						{
							type: "text" as const,
							text: `Subagent #${handle.id} is already stopped.`,
						},
					],
					details: { handle: await serialize(handle) },
				};
			await terminate(handle);
			const stopped = handle.processState === "stopped";
			return {
				content: [
					{
						type: "text" as const,
						text: stopped
							? `Terminated subagent #${handle.id}; artifacts were retained.`
							: `Could not confirm termination of subagent #${handle.id}; the tracked process still appears live.`,
					},
				],
				details: { handle: await serialize(handle), terminated: stopped },
			};
		},
	});
	pi.registerTool<typeof ResumeSchema, unknown>({
		name: "subagent_resume",
		label: "Subagent Resume",
		description:
			"Resume a stopped child from its saved Pi session file in a new process incarnation. The child reopens its prior conversation in a new tab with a new socket and pane. Use this only for stopped children that have a persisted session file.",
		parameters: ResumeSchema,
		async execute(_id, params, _signal, _update, ctx) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown subagent id: ${params.id}`,
						},
					],
					details: {},
				};
			if (active(handle))
				return {
					content: [
						{
							type: "text" as const,
							text: `Subagent #${handle.id} is still alive; resume is for stopped children.`,
						},
					],
					details: { handle: await serialize(handle) },
				};
			if (handle.cleanupRequired)
				return {
					content: [
						{
							type: "text" as const,
							text: `Subagent #${handle.id} has required terminal cleanup. Resume is blocked until cleanup completes.`,
						},
					],
					details: { handle: await serialize(handle) },
				};
			if (!requireLease())
				return {
					content: [{ type: "text" as const, text: leaseConflictMessage() }],
					details: {},
				};
			const sessionFile = handle.sessionPath;
			const usable = sessionFile
				? await fs
						.stat(sessionFile)
						.then((s) => s.isFile() && s.size > 0)
						.catch(() => false)
				: false;
			if (!usable)
				return {
					content: [
						{
							type: "text" as const,
							text: `No usable child session file exists for #${handle.id}; resume is not possible.`,
						},
					],
					details: { handle: await serialize(handle) },
				};
			try {
				await resumeChild(handle, params.task, ctx);
				return {
					content: [
						{
							type: "text" as const,
							text: `Resumed subagent #${handle.id} from ${sessionFile} in a new incarnation.`,
						},
					],
					details: { handle: await serialize(handle) },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: error instanceof Error ? error.message : String(error),
						},
					],
					details: { handle: await serialize(handle) },
				};
			}
		},
	});

	pi.registerCommand("subagents", {
		description: "Inspect persistent subagents",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			if (ctx.mode !== "tui") {
				console.log((await Promise.all(sorted().map(summary))).join("\n\n"));
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => {
					const inspector = new SubagentInspector(tui, theme, keybindings, {
						getHandles: () => sorted().map(toInspector),
						steer: async (id) => {
							const message = await ctx.ui.editor(`Steer #${id}`, "");
							if (!message) return "Canceled.";
							const handle = handles.get(id);
							if (!handle) return "Subagent no longer exists.";
							await sendMessage(handle, "steer", message);
							return "Accepted.";
						},
						kill: async (id) => {
							const handle = handles.get(id);
							if (!handle) return "Subagent no longer exists.";
							await terminate(handle);
							return "Killed.";
						},
						clearFinished: () => {
							let count = 0;
							for (const handle of handles.values())
								if (!active(handle) && !handle.cleanupRequired) {
									handles.delete(handle.id);
									count++;
								}
							void persist();
							return count;
						},
						onClose: () => {
							inspector.dispose();
							activeInspector = undefined;
							done(undefined);
						},
					});
					activeInspector = inspector;
					return inspector;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "100%",
						maxHeight: "100%",
						margin: 0,
					},
				},
			);
		},
	});
	pi.registerCommand("subagents-toggle", {
		description: "Toggle subagent widget",
		handler: async (_args, ctx) => {
			widgetVisible = !widgetVisible;
			refreshUi();
			if (ctx.mode === "tui")
				ctx.ui.notify(
					`Subagent widget ${widgetVisible ? "enabled" : "disabled"}.`,
					"info",
				);
		},
	});
	pi.registerCommand("subagents-kill-all", {
		description: "Terminate all live subagents",
		handler: async () => {
			await Promise.allSettled(sorted().filter(active).map(terminate));
		},
	});
}
