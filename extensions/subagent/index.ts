import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, promises as fs } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@mariozechner/pi-coding-agent";
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
	reconcileRegistryForOwner,
	saveRegistry,
} from "./registry.js";
import {
	type InspectorHandle,
	SubagentInspector,
	sanitizeTerminalText,
} from "./ui.js";
import {
	closeValidatedSubagentTab,
	discoverPaneId,
	listPanes,
	newTab,
	paneMatchesSubagent,
	requireZellij,
	revalidatePane,
	sendKeys,
} from "./zellij.js";

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
const controllerInstanceKey = Symbol.for("pi.subagent.controllerInstanceId");
const controllerGlobal = globalThis as typeof globalThis & {
	[controllerInstanceKey]?: string;
};
const processControllerInstanceId =
	controllerGlobal[controllerInstanceKey] ?? createControllerInstanceId();
controllerGlobal[controllerInstanceKey] = processControllerInstanceId;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
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
	tools?: string[];
	systemPrompt?: string;
}

interface SubagentHandle extends SubagentDispatchHandle {
	id: string;
	name?: string;
	task: string;
	cwd: string;
	requestedModel: string;
	requestedThinking: ThinkingLevel;
	configuredTools: string[];
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
	exitCode?: number;
	reconnecting?: boolean;
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
	persistedResultHash?: string;
	stderr: string;
	diagnostics: string[];
	waiters: Set<() => void>;
	terminationPromise?: Promise<SubagentHandle>;
	ipcMutationChain: Promise<void>;
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
] as const);
const TaskSpecSchema = Type.Object({
	name: Type.Optional(Type.String()),
	task: Type.String({ minLength: 1 }),
	cwd: Type.Optional(Type.String()),
	model: Type.String({ minLength: 1 }),
	thinking: ThinkingSchema,
	tools: Type.Optional(Type.Array(Type.String())),
	systemPrompt: Type.Optional(Type.String()),
});
const ListSchema = Type.Object({
	includeFinished: Type.Optional(Type.Boolean({ default: true })),
});
const StatusSchema = Type.Object({ id: Type.String() });
const WaitSchema = Type.Object({
	id: Type.Optional(Type.String()),
	all: Type.Optional(Type.Boolean()),
	timeoutSeconds: Type.Number({ minimum: 1 }),
	afterRunId: Type.Optional(Type.Number({ minimum: 0 })),
});
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
	return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(
		String(value),
	);
}
function truncate(value: string | undefined, max = 240) {
	const text = (value || "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function hashText(text: string) {
	return createHash("sha1").update(text).digest("hex");
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
	const offlineArgs = ["--offline", ...args];
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
	let livenessTimer: NodeJS.Timeout | undefined;

	const sorted = () =>
		[...handles.values()].sort(
			(a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
		);
	const active = (handle: SubagentHandle) => handle.processState === "alive";
	const paneIdentity = (handle: SubagentHandle) => ({
		childId: handle.id,
		socketPath: handle.socketPath,
		ownerSessionFile: handle.ownerSessionFile,
		ownerSessionId: handle.ownerSessionId,
		controllerInstanceId: handle.controllerInstanceId,
		incarnation: handle.incarnation,
	});
	const requireLease = (): boolean => leaseHeld && owner !== null;
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
			stopTimers();
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
	const registryEntries = (): RegistryEntry[] =>
		sorted().map((handle) => ({
			childId: handle.id,
			name: handle.name,
			task: handle.task,
			cwd: handle.cwd,
			tabId: handle.tabId,
			paneId: handle.paneId,
			sessionDir: handle.sessionDir,
			socketPath: handle.socketPath,
			sessionFile: handle.sessionPath,
			promptPath: handle.promptPath,
			requestedModel: handle.requestedModel,
			requestedThinking: handle.requestedThinking,
			configuredTools: [...handle.configuredTools],
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
		}));
	const persist = async () => {
		if (!owner || !(await requireCurrentAuthority())) return;
		const path = ownerRegistryPath(getAgentDir(), owner);
		persistenceChain = persistenceChain
			.then(() => saveRegistry(registryEntries(), path))
			.catch((error) => {
				for (const handle of handles.values())
					addDiagnostic(
						handle,
						`Registry persistence failed: ${error instanceof Error ? error.message : String(error)}`,
					);
			});
		await persistenceChain;
	};
	const trimRetained = () => {
		if (handles.size <= MAX_RETAINED_HANDLES) return;
		const stopped = [...handles.values()]
			.filter((candidate) => candidate.processState === "stopped")
			.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
		while (handles.size > MAX_RETAINED_HANDLES && stopped.length) {
			const candidate = stopped.shift();
			if (candidate) handles.delete(candidate.id);
		}
	};
	const update = (handle: SubagentHandle) => {
		handle.lastActivityAt = now();
		trimRetained();
		refreshUi();
		reconcileLivenessTimer();
		void persist();
	};

	async function ensureResult(handle: SubagentHandle): Promise<void> {
		if (!handle.resultText) return;
		const hash = hashText(handle.resultText);
		if (handle.persistedResultHash === hash) return;
		handle.resultPath ||= join(handle.sessionDir, "result.md");
		await fs.writeFile(handle.resultPath, handle.resultText, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.chmod(handle.resultPath, 0o600).catch(() => {});
		handle.persistedResultHash = hash;
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
		await ensureResult(handle).catch((error) =>
			addDiagnostic(handle, `Result persistence failed: ${String(error)}`),
		);
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
			pid: handle.pid,
			exitCode: handle.exitCode,
			reconnecting: handle.reconnecting,
			requestedModel: handle.requestedModel,
			requestedThinking: handle.requestedThinking,
			actualModel,
			actualThinking: handle.actualThinking || handle.requestedThinking,
			configuredTools: [...handle.configuredTools],
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
			error: handle.error || handle.finalError,
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
			configuredTools: string[];
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
			configuredTools: [...entry.configuredTools],
			sessionDir: entry.sessionDir,
			socketPath: entry.socketPath,
			promptPath:
				entry.promptPath ||
				join(entry.sessionDir, "pi-effective-system-prompt.txt"),
			sessionPath: entry.sessionFile,
			tabId: entry.tabId,
			paneId: entry.paneId,
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
			reconnecting: entry.detached,
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
			onAssistantFinalized: () => void ensureResult(handle),
			onSettled: () => {
				handle.completedAt = handle.settledAt;
				handle.error = handle.finalError;
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
		handle.processState = "alive";
		if (sessionChanged) {
			resetRunViewForSession(handle);
			handle.activeTools.clear();
			handle.isStreaming = false;
		}
		update(handle);
		notifyWaiters(handle);
	}
	async function probeProcess(handle: SubagentHandle): Promise<void> {
		if (!(await requireCurrentAuthority())) return;
		if (
			handle.processState === "stopped" ||
			handle.tabId === undefined ||
			handle.paneId === undefined
		)
			return;
		try {
			const panes = await listPanes();
			const pane = panes.find(
				(candidate) =>
					candidate.id === handle.paneId && candidate.tab_id === handle.tabId,
			);
			const identityMatches = pane
				? paneMatchesSubagent(
						pane,
						handle.tabId,
						handle.paneId,
						paneIdentity(handle),
					)
				: false;
			if (!identityMatches) {
				handle.exitCode = pane?.exit_status ?? undefined;
				markStopped(handle, now(), {
					code: pane?.exit_status,
					error:
						pane && !pane.exited
							? "Tracked Zellij IDs now belong to an unrelated process."
							: undefined,
				});
				handle.reconnecting = false;
				notifyWaiters(handle);
				await cleanupTransport(handle);
				update(handle);
			}
		} catch (error) {
			addDiagnostic(
				handle,
				`Zellij liveness probe failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	function enqueueAuthorizedMutation(
		handle: SubagentHandle,
		action: () => void | Promise<void>,
	): void {
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
						frame.childId === handle.id &&
						isCurrentEpochWithOwner(handle, frame, conn) &&
						frame.sessionId === handle.sessionId &&
						frame.runId >= handle.runSequence
					) {
						applySnapshot(handle, frame);
					} else {
						addDiagnostic(
							handle,
							"Ignored snapshot from a stale IPC connection or session epoch.",
						);
					}
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
					if (frame.event === "session_shutdown") return;
					dispatchSubagentEvent(
						handle,
						{ ...frame, type: frame.event },
						dispatchOptions(handle),
					);
				}),
			onAck: (frame, conn) =>
				enqueueAuthorizedMutation(handle, () => {
					const pending = handle.pendingAcks.get(frame.id);
					if (
						!pending ||
						frame.ownerSessionFile !== handle.ownerSessionFile ||
						frame.ownerSessionId !== handle.ownerSessionId ||
						frame.launchControllerInstanceId !== handle.controllerInstanceId ||
						frame.incarnation !== handle.incarnation ||
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
						addDiagnostic(
							handle,
							"Ignored acknowledgement from a stale IPC connection epoch.",
						);
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
					handle.reconnecting = frame.reason !== "quit";
					addDiagnostic(
						handle,
						`Child connection closing for ${frame.reason}.`,
					);
					update(handle);
				}),
			onPong: () => {},
			onConnectionClose: (conn, hadBye, reason) =>
				enqueueAuthorizedMutation(handle, () => {
					if (handle.ipcConn?.id !== conn.id) return;
					rejectPendingAcks(
						handle,
						conn.id,
						"Child IPC connection closed before acknowledgement.",
					);
					handle.ipcConn = undefined;
					handle.reconnecting = reason !== "quit";
					addDiagnostic(
						handle,
						`Child IPC disconnected${hadBye ? ` (${reason})` : ""}; awaiting reconnect.`,
					);
					update(handle);
					const probeTimer = setTimeout(
						() => void probeProcess(handle),
						reason === "quit" ? KILL_DEADLINE_MS : 0,
					);
					probeTimer.unref();
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
	async function safePane(handle: SubagentHandle): Promise<boolean> {
		if (!(await requireCurrentAuthority())) return false;
		if (handle.tabId === undefined || handle.paneId === undefined) return false;
		if (
			await revalidatePane(handle.tabId, handle.paneId, paneIdentity(handle))
		) {
			return true;
		}
		await probeProcess(handle);
		return false;
	}
	async function interrupt(handle: SubagentHandle): Promise<boolean> {
		if (handle.processState !== "alive")
			throw new Error(`Subagent #${handle.id} is no longer running.`);
		if (!(await safePane(handle)))
			throw new Error(
				`Subagent #${handle.id} pane identity could not be revalidated.`,
			);
		const cursor = handle.lastSettledRunId;
		const paneId = handle.paneId;
		if (paneId === undefined)
			throw new Error(`Subagent #${handle.id} pane identity is unavailable.`);
		if (!(await requireCurrentAuthority()))
			throw new Error(leaseConflictMessage());
		await sendKeys(paneId, "Esc");
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
			requestKill(handle, now());
			update(handle);
			await interrupt(handle).catch((error) =>
				addDiagnostic(handle, `Interrupt before kill failed: ${String(error)}`),
			);
			await new Promise((resolve) => setTimeout(resolve, TERM_DEADLINE_MS));
			if (
				handle.processState === "alive" &&
				handle.tabId !== undefined &&
				handle.paneId !== undefined
			) {
				try {
					if (!(await requireCurrentAuthority()))
						throw new Error(leaseConflictMessage());
					const closed = await closeValidatedSubagentTab(
						handle.tabId,
						handle.paneId,
						paneIdentity(handle),
					);
					if (!closed) await probeProcess(handle);
				} catch (error) {
					addDiagnostic(
						handle,
						`Failed to close tracked Zellij tab: ${String(error)}`,
					);
				}
			}
			const deadline = now() + KILL_DEADLINE_MS;
			while (handle.processState === "alive" && now() < deadline) {
				await probeProcess(handle);
				if (handle.processState === "alive")
					await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (handle.processState === "alive") {
				addDiagnostic(
					handle,
					"Termination deadline elapsed while the tracked child still appears live.",
				);
			} else {
				await cleanupTransport(handle);
			}
			handle.completedAt ||=
				handle.processState === "stopped" ? now() : undefined;
			await ensureResult(handle);
			update(handle);
			await persistenceChain;
			return handle;
		})();
		return handle.terminationPromise;
	}

	async function launch(
		spec: TaskSpec,
		cwd: string,
		requestedModel: string,
		requestedThinking: ThinkingLevel,
	): Promise<SubagentHandle> {
		requireZellij();
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
			configuredTools: getRequestedTools(spec.tools),
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
				PI_SUBAGENT_ACTIVE_TOOLS: handle.configuredTools.join(","),
				PI_SUBAGENT_DEPTH: String(getDepth() + 1),
				PI_SUBAGENT_PROMPT_PATH: handle.promptPath,
				BRIDGE_SOCKET_PATH: socketPath,
				BRIDGE_LOG_PATH: join(sessionDir, "child-events.log"),
				TERM: "xterm-256color",
			};
			handle.tabId = await newTab(
				spec.name?.trim() || `subagent-${id.slice(0, 8)}`,
				cwd,
				command,
				env,
			);
			handle.paneId = await discoverPaneId(handle.tabId);
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
			await terminate(handle).catch(() => {});
			handles.delete(id);
			await persist();
			throw error;
		}
	}

	async function resumeChild(
		handle: SubagentHandle,
		task?: string,
	): Promise<void> {
		requireZellij();
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
		await attachServer(handle);
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
				PI_SUBAGENT_ACTIVE_TOOLS: handle.configuredTools.join(","),
				PI_SUBAGENT_DEPTH: String(getDepth() + 1),
				PI_SUBAGENT_PROMPT_PATH: handle.promptPath,
				BRIDGE_SOCKET_PATH: socketPath,
				BRIDGE_LOG_PATH: join(handle.sessionDir, "child-events.log"),
				TERM: "xterm-256color",
			};
			handle.tabId = await newTab(
				handle.name || `subagent-${handle.id.slice(0, 8)}`,
				handle.cwd,
				command,
				env,
			);
			handle.paneId = await discoverPaneId(handle.tabId);
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
		targets: { handle: SubagentHandle; cursor: number }[],
		timeoutSeconds: number,
		signal: AbortSignal | undefined,
	): Promise<"completed" | "timedOut" | "canceled"> {
		const done = () =>
			targets.every(
				({ handle, cursor }) =>
					handle.processState === "stopped" || handle.lastSettledRunId > cursor,
			);
		await Promise.all(targets.map(({ handle }) => probeProcess(handle)));
		if (done()) return "completed";
		return new Promise((resolve) => {
			let finished = false;
			const waiters = new Map<SubagentHandle, () => void>();
			const finish = (value: "completed" | "timedOut" | "canceled") => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				clearInterval(probeTimer);
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
			const probeTimer = setInterval(() => {
				void Promise.all(
					targets.map(({ handle }) => probeProcess(handle)),
				).then(check);
			}, 500);
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
	function getRequestedTools(requested?: string[]) {
		const available = new Set(pi.getActiveTools());
		return (requested?.length ? requested : [...available]).filter(
			(name) => available.has(name) && !name.startsWith("subagent_"),
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
		if (!process.env.ZELLIJ_SESSION_NAME) return;
		if (!owner || !(await requireCurrentAuthority())) return;
		const path = ownerRegistryPath(getAgentDir(), owner);
		const saved = await loadRegistry(path);
		const panes = await listPanes();
		const reconciled = reconcileRegistryForOwner(saved, panes, owner);
		for (const entry of reconciled) {
			const existing = handles.get(entry.childId);
			if (existing) {
				if (entry.processState === "stopped") {
					markStopped(existing, now(), {
						error: "Pane was not live during reconciliation.",
					});
					notifyWaiters(existing);
				} else if (!existing.ipcServer) {
					existing.reconnecting = true;
					await attachServer(existing).catch((error) => {
						addDiagnostic(
							existing,
							`Reattach listener failed: ${String(error)}`,
						);
					});
				}
				continue;
			}
			const handle = createHandle(entry);
			handles.set(handle.id, handle);
			if (handle.processState === "alive") {
				handle.reconnecting = true;
				await attachServer(handle).catch((error) => {
					addDiagnostic(handle, `Reattach listener failed: ${String(error)}`);
				});
			}
		}
		await persist();
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
			configuredTools: [...handle.configuredTools],
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
			error: handle.error,
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
		if (livenessTimer) {
			clearInterval(livenessTimer);
			livenessTimer = undefined;
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
					stopTimers();
				},
			);
		}, LEASE_RENEW_INTERVAL_MS);
		leaseRenewTimer.unref();
	}
	function anyOwnedChildAlive() {
		return [...handles.values()].some(
			(handle) => handle.processState === "alive",
		);
	}
	function reconcileLivenessTimer() {
		if (livenessTimer) {
			clearInterval(livenessTimer);
			livenessTimer = undefined;
		}
		if (!leaseHeld || !anyOwnedChildAlive()) return;
		livenessTimer = setInterval(() => {
			void livenessTick();
		}, 1000);
		livenessTimer.unref();
	}
	async function livenessTick() {
		if (!owner || !(await requireCurrentAuthority())) return;
		let panes: Awaited<ReturnType<typeof listPanes>>;
		try {
			panes = await listPanes();
		} catch (error) {
			for (const handle of handles.values()) {
				if (handle.processState !== "alive") continue;
				addDiagnostic(
					handle,
					`Liveness poll failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}
		for (const handle of handles.values()) {
			if (handle.processState !== "alive") continue;
			if (handle.tabId === undefined || handle.paneId === undefined) continue;
			const pane = panes.find(
				(candidate) =>
					candidate.id === handle.paneId && candidate.tab_id === handle.tabId,
			);
			const matches = pane
				? paneMatchesSubagent(
						pane,
						handle.tabId,
						handle.paneId,
						paneIdentity(handle),
					)
				: false;
			if (!matches) {
				handle.exitCode = pane?.exit_status ?? undefined;
				markStopped(handle, now(), {
					code: pane?.exit_status,
					error:
						pane && !pane.exited
							? "Tracked Zellij IDs now belong to an unrelated process."
							: undefined,
				});
				handle.reconnecting = false;
				notifyWaiters(handle);
				await cleanupTransport(handle);
				update(handle);
			}
		}
		reconcileLivenessTimer();
	}

	async function establishController(ctx: ExtensionContext): Promise<void> {
		const sessionFile = ctx.sessionManager?.getSessionFile();
		const sessionId = ctx.sessionManager?.getSessionId();
		if (!sessionFile || !sessionId) {
			owner = null;
			leaseHeld = false;
			return;
		}
		const canonicalSessionFile = await canonicalOwnerSessionFile(sessionFile);
		const resolved: OwnerIdentity = {
			ownerSessionFile: canonicalSessionFile,
			ownerSessionId: sessionId,
		};
		const result = await acquireLease(
			getAgentDir(),
			resolved,
			controllerInstanceId,
			now(),
		);
		if (result.held) {
			owner = resolved;
			leaseHeld = true;
			startLeaseRenewal();
		} else {
			owner = null;
			leaseHeld = false;
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

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		await establishController(ctx);
		await reconcile().catch((error) =>
			console.error(`Subagent reconcile failed: ${String(error)}`),
		);
		reconcileLivenessTimer();
		refreshUi();
	});
	pi.on("session_shutdown", async (event, ctx) => {
		latestCtx = ctx;
		const reason = event?.reason || "quit";
		if (reason === "quit") {
			stopTimers();
			if (await requireCurrentAuthority())
				await Promise.allSettled(
					sorted().map(async (handle) => {
						if (active(handle)) {
							await terminate(handle);
							return;
						}
						if (handle.tabId === undefined || handle.paneId === undefined)
							return;
						await closeValidatedSubagentTab(
							handle.tabId,
							handle.paneId,
							paneIdentity(handle),
						);
					}),
				);
			await releaseLeaseIfHeld();
		} else if (reason === "reload") {
			stopTimers();
			for (const handle of handles.values()) {
				handle.reconnecting = true;
				await handle.ipcServer?.close().catch(() => {});
				handle.ipcServer = undefined;
				handle.ipcConn = undefined;
			}
		} else {
			stopTimers();
			for (const handle of handles.values()) {
				handle.reconnecting = true;
				await handle.ipcServer?.close().catch(() => {});
				handle.ipcServer = undefined;
				handle.ipcConn = undefined;
			}
			handles.clear();
			await releaseLeaseIfHeld();
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
			`\n\nSubagent extension is available. Use it only for explicit delegation. subagent_start requires an explicit provider/model and thinking level; use list_models when needed instead of guessing. Children are persistent interactive Pi TUIs in tabs of the current Zellij session. Use subagent_follow_up for another turn, subagent_steer during a run, subagent_interrupt to abort a run while keeping the child alive, subagent_wait with a finite timeout and settlement cursor, and subagent_kill only to terminate.`,
	}));

	pi.registerTool<typeof TaskSpecSchema, unknown>({
		name: "subagent_start",
		label: "Subagent Start",
		description:
			"Start a persistent interactive Pi TUI with an explicit model and thinking level in a new tab of the current Zellij session after a bounded IPC handshake. Call subagent_kill when the child is no longer useful.",
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
			await probeProcess(handle);
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
	pi.registerTool<typeof WaitSchema, unknown>({
		name: "subagent_wait",
		label: "Subagent Wait",
		description:
			"Bounded wait for a run settlement cursor or stopped process. Completion does not terminate the child.",
		parameters: WaitSchema,
		async execute(_id, params, signal) {
			if (!Number.isFinite(params.timeoutSeconds) || params.timeoutSeconds < 1)
				return {
					content: [
						{
							type: "text" as const,
							text: "timeoutSeconds must be finite and at least 1.",
						},
					],
					details: { outcome: "timedOut", handles: [] },
				};
			const hasId = !!params.id;
			const hasAll = params.all === true;
			if (hasId === hasAll)
				return {
					content: [
						{
							type: "text" as const,
							text: "Provide exactly one of id or all:true.",
						},
					],
					details: { outcome: "timedOut", handles: [] },
				};
			let chosen: SubagentHandle[];
			if (hasId) {
				const handle = params.id ? handles.get(params.id) : undefined;
				if (!handle)
					return {
						content: [
							{
								type: "text" as const,
								text: `Unknown subagent id: ${params.id}`,
							},
						],
						details: { outcome: "timedOut", handles: [] },
					};
				chosen = [handle];
			} else chosen = sorted().filter(active);
			const targets = chosen.map((handle) => ({
				handle,
				cursor:
					params.afterRunId ??
					(handle.resultText && handle.runOutcome === "succeeded"
						? 0
						: handle.lastSettledRunId),
			}));
			const waited = await waitFor(targets, params.timeoutSeconds, signal);
			const settledHandles = await Promise.all(chosen.map(serialize));
			const settled = chosen.find(
				(handle) =>
					handle.resultText &&
					handle.runOutcome === "succeeded" &&
					handle.lastSettledRunId > (params.afterRunId ?? 0),
			);
			const resultText = settled?.resultText;
			const outcome = waited;
			return {
				content: [
					{
						type: "text" as const,
						text: resultText
							? resultText
							: `Wait ${outcome}. Child processes remain ${chosen.every(active) ? "alive" : "unchanged"}.`,
					},
				],
				details: {
					outcome,
					result: resultText || undefined,
					handles: settledHandles,
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
				await resumeChild(handle, params.task);
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
								if (!active(handle)) {
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
