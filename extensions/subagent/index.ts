import { type ChildProcess, spawn } from "node:child_process";
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
	createLifecycleState,
	lifecycleActivity,
	markStopped,
	requestKill,
	resetRunViewForSession,
	reviveForResume,
	type SessionLifecycle,
	type SubagentRun,
} from "./lifecycle.js";
import { isProcessAlive } from "./lock.js";
import {
	acquireLease,
	canonicalOwnerSessionFile,
	createControllerInstanceId,
	hasLeaseAuthority,
	LEASE_RENEW_INTERVAL_MS,
	leasePath,
	type OwnerIdentity,
	ownerRegistryPath,
	readLeaseRecord,
	releaseLease,
	renewLease,
} from "./owner.js";
import {
	loadRegistry,
	type RegistryEntry,
	registryEntriesForOwner,
	saveRegistry,
} from "./registry.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const childExtensionPath = join(__dirname, "child.ts");
const STARTUP_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 10_000;
const ABORT_SETTLE_TIMEOUT_MS = 1_000;
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
interface PendingRpcCommand {
	type: string;
	resolve(response: Record<string, unknown>): void;
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

interface SubagentHandle extends SubagentDispatchHandle {
	id: string;
	name?: string;
	task: string;
	cwd: string;
	requestedModel: string;
	requestedThinking: ThinkingLevel;
	sessionDir: string;
	promptPath: string;
	childProcess?: ChildProcess;
	rpcReady: boolean;
	pid?: number;
	exitCode?: number;
	actualModel?: ActualModel;
	actualThinking?: ThinkingLevel;
	sessionPath?: string;
	sessionId?: string;
	createdAt: number;
	lastActivityAt: number;
	completedAt?: number;
	resultPath?: string;
	transcriptPersisted?: boolean;
	stderr: string;
	diagnostics: string[];
	waiters: Set<() => void>;
	terminationPromise?: Promise<SubagentHandle>;
	settlementPersistenceChain: Promise<void>;
	pendingRpcCommands: Map<string, PendingRpcCommand>;
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

/** Parse JSONL lines from a readable stream and call onLine for each object. */
function attachJsonlReader(
	stream: NodeJS.ReadableStream,
	onLine: (parsed: Record<string, unknown>) => void,
	onError?: (error: Error) => void,
): void {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				if (parsed && typeof parsed === "object") onLine(parsed as Record<string, unknown>);
			} catch (error) {
				onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		}
	});
}

/** Write a JSONL command to the child process stdin. */
function writeRpcCommand(
	handle: SubagentHandle,
	command: Record<string, unknown>,
): void {
	if (!handle.childProcess?.stdin?.writable) return;
	handle.childProcess.stdin.write(`${JSON.stringify(command)}\n`);
}

/** Send a command to the child and wait for a matching response frame. */
function sendRpcCommand(
	handle: SubagentHandle,
	command: Record<string, unknown>,
	timeoutMs = ACK_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
	const commandType = String(command.type);
	return new Promise((resolve, reject) => {
		const existing = handle.pendingRpcCommands.get(commandType);
		if (existing) {
			clearTimeout(existing.timer);
			existing.reject(new Error(`Superseded by new ${commandType} command.`));
		}
		const timer = setTimeout(() => {
			handle.pendingRpcCommands.delete(commandType);
			reject(
				new Error(
					`RPC command "${commandType}" timed out after ${timeoutMs}ms.`,
				),
			);
		}, timeoutMs);
		handle.pendingRpcCommands.set(commandType, {
			type: commandType,
			resolve,
			reject,
			timer,
		});
		writeRpcCommand(handle, command);
	});
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
	let sessionShuttingDown = false;
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
	const requireLease = (): boolean => leaseHeld && owner !== null;
	const addDiagnostic = (handle: SubagentHandle, message: string) => {
		handle.diagnostics.push(message.slice(0, 2048));
		if (handle.diagnostics.length > MAX_DIAGNOSTICS)
			handle.diagnostics.splice(0, handle.diagnostics.length - MAX_DIAGNOSTICS);
	};
	const notifyWaiters = (handle: SubagentHandle) => {
		for (const waiter of [...handle.waiters]) waiter();
	};
	const rejectPendingRpcCommands = (handle: SubagentHandle, message: string) => {
		for (const [type, pending] of handle.pendingRpcCommands) {
			clearTimeout(pending.timer);
			pending.reject(new Error(message));
			handle.pendingRpcCommands.delete(type);
		}
	};

	const registryEntry = (handle: SubagentHandle): RegistryEntry => ({
		childId: handle.id,
		name: handle.name,
		task: handle.task,
		cwd: handle.cwd,
		sessionDir: handle.sessionDir,
		sessionFile: handle.sessionPath,
		promptPath: handle.promptPath,
		requestedModel: handle.requestedModel,
		requestedThinking: handle.requestedThinking,
		processState: handle.processState,
		runState: handle.runState,
		runId: handle.runSequence || undefined,
		lastSettledRunId: handle.lastSettledRunId || undefined,
		pid: handle.pid,
		createdAt: handle.createdAt,
		lastActivityAt: handle.lastActivityAt,
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
			if (candidate) handles.delete(candidate.id);
		}
	};
	const update = (handle: SubagentHandle, shouldPersist = true) => {
		handle.lastActivityAt = now();
		trimRetained();
		refreshUi();
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
			transcriptPersisted: transcript.persisted,
			transcriptNote: transcript.note,
			createdAt: handle.createdAt,
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
			resultPreview: handle.resultText ? truncate(handle.resultText) : undefined,
			currentAssistantText: handle.currentAssistantText || undefined,
			latestAssistantText: handle.latestAssistantText || undefined,
			activeTools: [...handle.activeTools.values()].map((tool) => ({ ...tool })),
			recentTools: handle.recentTools.map((tool) => ({ ...tool })),
			tentativeError: handle.tentativeError,
			finalError: handle.finalError,
			settledAt: handle.settledAt,
			diagnostics: handle.diagnostics.length ? [...handle.diagnostics] : undefined,
		};
	}
	async function summary(handle: SubagentHandle) {
		const serial = await serialize(handle);
		return sanitizeTerminalText(
			`#${handle.id}${handle.name ? ` ${handle.name}` : ""} ${handle.processState}/${handle.runState} · run:${handle.runSequence || 0}\n  actual ${formatModel(serial.actualModel)} · thinking:${serial.actualThinking}\n  pid:${handle.pid ?? "?"} · exit:${handle.exitCode ?? "-"}\n  session ${serial.sessionPath} (${serial.transcriptNote})${serial.error ? `\n  error ${truncate(serial.error, 180)}` : ""}`,
		);
	}

	function createHandle(
		entry: Partial<RegistryEntry> & {
			childId: string;
			task: string;
			cwd: string;
			sessionDir: string;
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
			promptPath:
				entry.promptPath ||
				join(entry.sessionDir, "pi-effective-system-prompt.txt"),
			sessionPath: entry.sessionFile,
			pid: entry.pid,
			childProcess: undefined,
			rpcReady: false,
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
			pendingRpcCommands: new Map(),
			createdAt: entry.createdAt,
			lastActivityAt: entry.lastActivityAt,
			stderr: "",
			diagnostics: [],
			waiters: new Set(),
			settlementPersistenceChain: Promise.resolve(),
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

	function handleRpcLine(
		handle: SubagentHandle,
		parsed: Record<string, unknown>,
	): void {
		const type = typeof parsed.type === "string" ? parsed.type : undefined;
		if (!type) return;
		handle.rpcReady = true;

		// Resolve pending RPC command responses.
		if (type === "response") {
			const commandType = typeof parsed.command === "string" ? parsed.command : undefined;
			if (commandType) {
				const pending = handle.pendingRpcCommands.get(commandType);
				if (pending) {
					clearTimeout(pending.timer);
					handle.pendingRpcCommands.delete(commandType);
					if (parsed.success === false) {
						pending.reject(
							new Error(
								typeof parsed.error === "string"
									? parsed.error
									: `RPC command "${commandType}" failed.`,
							),
						);
					} else {
						pending.resolve(parsed);
					}
				}
			}
			return;
		}

		// Dispatch lifecycle events to the shared dispatcher.
		if (type === "agent_settled") {
			dispatchSubagentEvent(handle, { type: "agent_settled", ...parsed }, dispatchOptions(handle));
			notifyWaiters(handle);
			return;
		}
		if (
			type === "agent_start" ||
			type === "agent_end" ||
			type === "message_start" ||
			type === "message_update" ||
			type === "message_end" ||
			type === "tool_execution_start" ||
			type === "tool_execution_update" ||
			type === "tool_execution_end" ||
			type === "extension_error"
		) {
			dispatchSubagentEvent(handle, { type, ...parsed }, dispatchOptions(handle));
			return;
		}
	}

	async function declareDead(handle: SubagentHandle): Promise<void> {
		if (handle.processState === "stopped") return;
		rejectPendingRpcCommands(handle, "Child process ended.");
		markStopped(handle, now(), {});
		notifyWaiters(handle);
		update(handle, false);
		await persist();
	}

	function attachChildProcess(handle: SubagentHandle, child: ChildProcess): void {
		handle.childProcess = child;
		handle.pid = child.pid;

		attachJsonlReader(
			child.stdout!,
			(parsed) => handleRpcLine(handle, parsed),
			(error) => addDiagnostic(handle, `RPC parse error: ${error.message}`),
		);

		child.stderr!.setEncoding("utf8");
		child.stderr!.on("data", (chunk: string) => {
			handle.stderr += chunk;
			if (handle.stderr.length > 64 * 1024)
				handle.stderr = handle.stderr.slice(-64 * 1024);
		});

		child.on("close", (code) => {
			handle.exitCode = code ?? undefined;
			handle.childProcess = undefined;
			rejectPendingRpcCommands(handle, "Child process closed.");
			void declareDead(handle);
		});
	}

	async function waitForReady(
		handle: SubagentHandle,
		timeoutMs = STARTUP_TIMEOUT_MS,
	): Promise<void> {
		if (handle.rpcReady || handle.processState === "stopped") return;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				handle.waiters.delete(check);
				if (!handle.rpcReady)
					reject(new Error(`Timed out waiting for child #${handle.id} to become ready.`));
				else resolve();
			}, timeoutMs);
			const check = () => {
				if (!handle.rpcReady && handle.processState !== "stopped") return;
				clearTimeout(timer);
				handle.waiters.delete(check);
				if (handle.processState === "stopped")
					reject(new Error(`Child #${handle.id} died before becoming ready.`));
				else resolve();
			};
			handle.waiters.add(check);
			check();
		});
	}

	async function sendMessage(
		handle: SubagentHandle,
		deliverAs: "followUp" | "steer",
		content: string,
	): Promise<void> {
		if (!(await requireCurrentAuthority()))
			throw new Error(await leaseConflictMessage());
		if (handle.processState !== "alive")
			throw new Error(`Subagent #${handle.id} is no longer running.`);
		const rpcType = deliverAs === "steer" ? "steer" : "follow_up";
		await sendRpcCommand(handle, { type: rpcType, message: content });
	}

	async function interrupt(handle: SubagentHandle): Promise<boolean> {
		if (handle.processState !== "alive")
			throw new Error(`Subagent #${handle.id} is no longer running.`);
		if (!(await requireCurrentAuthority()))
			throw new Error(await leaseConflictMessage());
		const cursor = handle.lastSettledRunId;
		writeRpcCommand(handle, { type: "abort" });
		if (handle.runState === "idle") return true;
		const settled = await waitFor(
			[{ handle, cursor }],
			ABORT_SETTLE_TIMEOUT_MS / 1000,
			undefined,
		);
		if (settled !== "completed") {
			addDiagnostic(
				handle,
				"Abort command did not settle within the acknowledgement deadline.",
			);
			return false;
		}
		return true;
	}

	async function terminate(handle: SubagentHandle): Promise<SubagentHandle> {
		if (!(await requireCurrentAuthority()))
			throw new Error(await leaseConflictMessage());
		if (handle.processState === "stopped") return handle;
		if (handle.terminationPromise) return handle.terminationPromise;
		handle.terminationPromise = (async () => {
			settlementNotifications.suppressChild(handle.id);
			requestKill(handle, now());
			update(handle, false);

			// 1. Send abort and wait briefly.
			writeRpcCommand(handle, { type: "abort" });
			await new Promise((resolve) => setTimeout(resolve, TERM_DEADLINE_MS));

			if (handle.processState === "stopped") {
				handle.completedAt ||= now();
				await handle.settlementPersistenceChain;
				await persistenceChain;
				return handle;
			}

			// 2. SIGTERM.
			handle.childProcess?.kill("SIGTERM");
			await new Promise((resolve) => setTimeout(resolve, TERM_DEADLINE_MS));

			if (handle.processState === "stopped") {
				handle.completedAt ||= now();
				await handle.settlementPersistenceChain;
				await persistenceChain;
				return handle;
			}

			// 3. SIGKILL.
			handle.childProcess?.kill("SIGKILL");
			await new Promise((resolve) => setTimeout(resolve, KILL_DEADLINE_MS));

			if (handle.processState !== "stopped") {
				rejectPendingRpcCommands(handle, "Child process forcibly killed.");
				markStopped(handle, now(), {});
				notifyWaiters(handle);
				update(handle);
			}

			handle.completedAt ||= now();
			await handle.settlementPersistenceChain;
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
		_ctx: ExtensionContext,
	): Promise<SubagentHandle> {
		if (!(await requireCurrentAuthority()))
			throw new Error(await leaseConflictMessage());
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

		const handle = createHandle({
			childId: id,
			name: spec.name?.trim() || undefined,
			task: spec.task,
			cwd,
			sessionDir,
			requestedModel,
			requestedThinking,
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
		await persist();

		try {
			const command = getPiInvocation([
				"--mode",
				"rpc",
				"-e",
				childExtensionPath,
				"--session-dir",
				sessionDir,
				"--model",
				requestedModel,
				"--thinking",
				requestedThinking,
			]);
			const env: NodeJS.ProcessEnv = {
				...process.env,
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_CHILD_ID: id,
				PI_SUBAGENT_INCARNATION: incarnation,
				PI_SUBAGENT_SYSTEM_PROMPT: spec.systemPrompt || "",
				PI_SUBAGENT_DEPTH: String(getDepth() + 1),
				PI_SUBAGENT_PROMPT_PATH: handle.promptPath,
				PI_SUBAGENT_SESSION_DIR: handle.sessionDir,
			};
			const child = spawn(command[0]!, command.slice(1), {
				cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			});
			attachChildProcess(handle, child);
			update(handle);
			await waitForReady(handle);
			// Send the initial task as a prompt command.
			const before = handle.runSequence;
			await sendRpcCommand(handle, { type: "prompt", message: spec.task }, ACK_TIMEOUT_MS);
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
		task: string | undefined,
		_ctx?: ExtensionContext,
	): Promise<void> {
		if (!(await requireCurrentAuthority()))
			throw new Error(await leaseConflictMessage());
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
		handle.incarnation = incarnation;
		handle.controllerInstanceId = controllerInstanceId;
		handle.resumedFrom = oldIncarnation;
		reviveForResume(handle);
		handle.completedAt = undefined;
		handle.error = undefined;
		handle.stopReason = undefined;
		handle.terminationPromise = undefined;
		handle.childProcess = undefined;
		handle.rpcReady = false;
		handle.pendingRpcCommands = new Map();
		handle.exitCode = undefined;

		try {
			const command = getPiInvocation([
				"--mode",
				"rpc",
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
			const env: NodeJS.ProcessEnv = {
				...process.env,
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_CHILD_ID: handle.id,
				PI_SUBAGENT_INCARNATION: incarnation,
				PI_SUBAGENT_SYSTEM_PROMPT: "",
				PI_SUBAGENT_DEPTH: String(getDepth() + 1),
				PI_SUBAGENT_PROMPT_PATH: handle.promptPath,
				PI_SUBAGENT_SESSION_DIR: handle.sessionDir,
			};
			const child = spawn(command[0]!, command.slice(1), {
				cwd: handle.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			});
			attachChildProcess(handle, child);
			update(handle);
			await waitForReady(handle);
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

	/**
	 * Restore stopped handles from the registry. Live handles cannot be
	 * reattached with RPC mode — any alive-but-unattached handles are marked
	 * stopped.
	 */
	async function reconcile() {
		if (!owner || !(await requireCurrentAuthority())) return;
		const path = ownerRegistryPath(getAgentDir(), owner);
		const saved = registryEntriesForOwner(await loadRegistry(path), owner);
		for (const entry of saved) {
			const existing = handles.get(entry.childId);
			const handle = existing || createHandle(entry);
			if (!existing) handles.set(handle.id, handle);
			// Without an IPC server, alive-but-unattached handles cannot reconnect.
			if (handle.processState === "alive" && !handle.childProcess) {
				markStopped(handle, now(), { error: "Process lost across session reload." });
				notifyWaiters(handle);
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
			activeTools: [...handle.activeTools.values()].map((tool) => ({ ...tool })),
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
						for (const handle of handles.values())
							addDiagnostic(
								handle,
								"Controller lease lost during renewal: the lease record is missing or now belongs to another controller. Run /reload to re-establish it.",
							);
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
					stopTimers();
				},
			);
		}, LEASE_RENEW_INTERVAL_MS);
		leaseRenewTimer.unref();
	}

	/**
	 * Wall-clock expiry can lapse without any competing controller, most visibly
	 * across host suspend. Re-extend our own record before concluding that
	 * authority was lost.
	 */
	async function ensureLeaseAuthority(
		authorityOwner: OwnerIdentity,
	): Promise<boolean> {
		const agentDir = getAgentDir();
		if (
			await hasLeaseAuthority(
				agentDir,
				authorityOwner,
				controllerInstanceId,
				now(),
			)
		)
			return true;
		return renewLease(
			agentDir,
			authorityOwner,
			controllerInstanceId,
			now(),
		).catch(() => false);
	}
	async function requireCurrentAuthority(): Promise<boolean> {
		if (!leaseHeld || !owner || !controllerInstanceId) return false;
		const authoritative = await ensureLeaseAuthority(owner);
		if (!authoritative) {
			leaseHeld = false;
			suppressAllSettlementNotifications();
			stopTimers();
			refreshUi();
		}
		return authoritative;
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
			const { existing } = result;
			console.error(
				`Subagent controller lease for this session file is held by controller ${existing.controllerInstanceId} (pid ${existing.pid}, ${isProcessAlive(existing.pid) ? "running" : "not running"}), expiring ${new Date(existing.expiresAt).toISOString()}. Quit that Pi process, then reload here.`,
			);
		}
	}

	async function leaseConflictMessage(): Promise<string> {
		const base = "Subagent controller lease is not held.";
		if (!owner)
			return `${base} This Pi session has no persisted session file, so no controller was established.`;
		const path = leasePath(getAgentDir(), owner);
		const existing = await readLeaseRecord(getAgentDir(), owner).catch(
			() => undefined,
		);
		if (!existing)
			return `${base} No lease record exists at ${path}. Run /reload to re-establish this controller.`;
		if (existing.controllerInstanceId === controllerInstanceId)
			return `${base} The record at ${path} still belongs to this process (pid ${existing.pid}), but this controller stopped holding it (expired ${new Date(existing.expiresAt).toISOString()}). Waiting will not help. Run /reload to reclaim it.`;
		return isProcessAlive(existing.pid)
			? `${base} Another live Pi process (pid ${existing.pid}) owns session ${existing.ownerSessionId} and holds ${path}. Quit that process, then run /reload here.`
			: `${base} The record at ${path} names pid ${existing.pid}, which is no longer running (expired ${new Date(existing.expiresAt).toISOString()}). Run /reload to take it over.`;
	}

	function releaseLeaseIfHeld() {
		if (!owner || !leaseHeld) return Promise.resolve();
		return releaseLease(getAgentDir(), owner, controllerInstanceId);
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionShuttingDown = false;
		latestCtx = ctx;
		await establishController(ctx);
		await reconcile().catch((error) =>
			console.error(`Subagent reconcile failed: ${String(error)}`),
		);
		refreshUi();
	});
	pi.on("session_shutdown", async (event, ctx) => {
		sessionShuttingDown = true;
		suppressAllSettlementNotifications();
		latestCtx = ctx;
		const reason = event?.reason || "quit";
		if (reason === "quit" || reason === "reload") {
			stopTimers();
			// Kill all live children.
			await Promise.allSettled(sorted().filter(active).map(terminate));
			if (reason === "quit") await releaseLeaseIfHeld();
			if (reason === "reload") {
				handles.clear();
			}
		} else {
			stopTimers();
			await Promise.allSettled(sorted().filter(active).map(terminate));
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
			`\n\nSubagent extension is available. Use it only for explicit delegation. subagent_start requires an explicit provider/model and thinking level; use list_models when needed instead of guessing. Children are persistent Pi RPC subprocesses. Start a child, then continue other work or end the current turn. Settlement notifications arrive automatically while children remain alive. These notifications start a follow-up turn. Rely on these notifications for completion. Do not poll subagent_status or use sleep commands to wait for completion. Use subagent_result with the child ID and run ID from the notification for exact settled output. Use subagent_status only for live diagnostics, never as a completion check. Use subagent_follow_up for another turn, subagent_steer during a run, subagent_interrupt to abort a run while keeping the child alive, and subagent_kill only to terminate.`,
	}));

	pi.registerTool<typeof TaskSpecSchema, unknown>({
		name: "subagent_start",
		label: "Subagent Start",
		description:
			"Start a persistent Pi RPC subprocess with an explicit model and thinking level. Settlement notifications start a follow-up turn when the child finishes. Rely on these notifications. Do not poll subagent_status or use sleep commands to wait for completion. Call subagent_kill when the child is no longer useful.",
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
							text: `Started persistent subagent #${handle.id} (pid ${handle.pid ?? "?"}).`,
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
			"Return process/run lifecycle, live activity, and artifacts. Use this tool only for live diagnostics. Do not poll this tool for completion.",
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
		description: "Deliver guidance during a running child turn over RPC.",
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
				await sendMessage(handle, "steer", params.message.trim());
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
		description: "Send another user turn to a live persistent child over RPC.",
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
				await sendMessage(handle, "followUp", params.message.trim());
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
			"Cooperatively abort the current run while keeping the child process alive.",
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
								: `Abort sent to #${handle.id}, but settlement acknowledgement timed out.`,
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
			"Terminate the child subprocess after cooperative abort and bounded escalation. Use this cleanup action for completed or abandoned children.",
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
			"Resume a stopped child from its saved Pi session file in a new process incarnation. The child reopens its prior conversation in a new subprocess with a new incarnation. Use this only for stopped children that have a persisted session file.",
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
			if (!requireLease())
				return {
					content: [{ type: "text" as const, text: await leaseConflictMessage() }],
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
