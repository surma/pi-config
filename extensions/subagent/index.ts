import { randomBytes } from "node:crypto";
import { accessSync, constants, promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, delimiter, dirname, join, resolve } from "node:path";
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
	createLifecycleState,
	lifecycleActivity,
	markStopped,
	requestKill,
	reviveForResume,
	type RunOutcome,
	type SessionLifecycle,
	type SettlementStatus,
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
	boundOutputError,
	writeCallerOutput,
	type OutputStatus,
} from "./output-store.js";
import {
	deactivateAssistantMessage,
} from "./live-state.js";
import {
	readTranscript,
	type TranscriptOptions,
	type TranscriptStatus,
} from "./transcript.js";
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
	RpcChildTransport,
	type RpcProcessClose,
	type RpcRecord,
	type RpcResponseRecord,
} from "./rpc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const childExtensionPath = join(__dirname, "child.ts");
const STARTUP_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ABORT_TIMEOUT_MS = 1_000;
const ASSISTANT_DISPLAY_MAX = 64 * 1024;
const TOOL_OUTPUT_TAIL_MAX = 16 * 1024;
const MAX_RECENT_TOOLS = 8;
const MAX_RETAINED_HANDLES = 24;
const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LENGTH = 2_048;
const MAX_STDERR_TAIL = 8 * 1024;
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
interface TaskSpec {
	name?: string;
	task: string;
	cwd?: string;
	model: string;
	thinking: ThinkingLevel;
	systemPrompt?: string;
	outputPath?: string;
}
interface AssistantAssembly {
	message: Record<string, unknown>;
}
interface RuntimeChild {
	id: string;
	incarnation: string;
	transport: RpcChildTransport;
	queuedRecords: RpcRecord[];
	consumer?: (record: RpcRecord) => void;
	closeConsumer?: (close: RpcProcessClose) => void;
	closed?: RpcProcessClose;
	diagnostics: string[];
	handle?: SubagentHandle;
}

const runtimeChildrenKey = Symbol.for("pi.subagent.rpcChildren");
const runtimeGlobal = globalThis as typeof globalThis & {
	[runtimeChildrenKey]?: Map<string, RuntimeChild>;
};
const runtimeChildren =
	runtimeGlobal[runtimeChildrenKey] ?? new Map<string, RuntimeChild>();
if (!runtimeGlobal[runtimeChildrenKey]) runtimeGlobal[runtimeChildrenKey] = runtimeChildren;

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

function tail(
	value: string | undefined,
	max = MAX_STDERR_TAIL,
): string | undefined {
	if (!value) return undefined;
	return value.length > max ? value.slice(-max) : value;
}

function isSettlementStatus(value: unknown): value is SettlementStatus {
	return (
		value === "pending" ||
		value === "settled" ||
		value === "closed_without_settlement"
	);
}

function isRunOutcome(value: unknown): value is RunOutcome {
	return (
		value === "pending" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "aborted"
	);
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && Number(value) >= 0
		? Number(value)
		: undefined;
}

function isOutputStatus(value: unknown): value is OutputStatus {
	return (
		value === "not_requested" ||
		value === "pending" ||
		value === "written" ||
		value === "collision" ||
		value === "failed"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyMessage(message: Record<string, unknown>): Record<string, unknown> {
	return {
		...message,
		content: Array.isArray(message.content)
			? message.content.map((part) => (isRecord(part) ? { ...part } : part))
			: message.content,
	};
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

export function buildRpcChildInvocation(options: {
	sessionFile?: string;
	childExtensionPath?: string;
	sessionDir: string;
	model: string;
	thinking: ThinkingLevel;
}): string[] {
	const args = ["--mode", "rpc"];
	if (options.sessionFile) args.push("--session", options.sessionFile);
	args.push(
		"-e",
		options.childExtensionPath || childExtensionPath,
		"--session-dir",
		options.sessionDir,
		"--model",
		options.model,
		"--thinking",
		options.thinking,
	);
	return getPiInvocation(args);
}

function childEnvironment(values: {
	childId: string;
	incarnation: string;
	depth: number;
	runIdBase: number;
	systemPrompt: string;
	promptPath: string;
	sessionDir: string;
	leasePath: string;
	ownerSessionFile: string;
	ownerSessionId: string;
	controllerInstanceId: string;
}): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_SUBAGENT_")) delete env[key];
	}
	Object.assign(env, {
		PI_SUBAGENT_CHILD: "1",
		PI_SUBAGENT_CHILD_ID: values.childId,
		PI_SUBAGENT_INCARNATION: values.incarnation,
		PI_SUBAGENT_RUN_ID_BASE: String(values.runIdBase),
		PI_SUBAGENT_SYSTEM_PROMPT: values.systemPrompt,
		PI_SUBAGENT_DEPTH: String(values.depth),
		PI_SUBAGENT_PROMPT_PATH: values.promptPath,
		PI_SUBAGENT_SESSION_DIR: values.sessionDir,
		PI_SUBAGENT_LEASE_PATH: values.leasePath,
		PI_SUBAGENT_OWNER_SESSION_FILE: values.ownerSessionFile,
		PI_SUBAGENT_OWNER_SESSION_ID: values.ownerSessionId,
		PI_SUBAGENT_CONTROLLER_INSTANCE_ID: values.controllerInstanceId,
	});
	return env;
}

function attachRuntime(
	runtime: RuntimeChild,
	consumer: (record: RpcRecord) => void,
	closeConsumer: (close: RpcProcessClose) => void,
): void {
	runtime.consumer = consumer;
	runtime.closeConsumer = closeConsumer;
	const queued = runtime.queuedRecords.splice(0);
	for (const record of queued) consumer(record);
	if (runtime.closed) closeConsumer(runtime.closed);
}

function detachRuntime(runtime: RuntimeChild): void {
	runtime.consumer = undefined;
	runtime.closeConsumer = undefined;
}

function runtimeMatches(handle: SubagentHandle, runtime: RuntimeChild): boolean {
	return (
		runtimeChildren.get(handle.id) === runtime &&
		handle.runtime === runtime &&
		handle.incarnation === runtime.incarnation
	);
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
	actualModel?: ActualModel;
	actualThinking?: ThinkingLevel;
	sessionPath?: string;
	sessionId?: string;
	pid?: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	rpcReady: boolean;
	rpc?: RpcChildTransport;
	runtime?: RuntimeChild;
	createdAt: number;
	rpcReadyAt?: number;
	lastActivityAt: number;
	completedAt?: number;
	outputPath?: string;
	outputStatus: OutputStatus;
	outputError?: string;
	transcriptStatus: TranscriptStatus;
	outputWriteChain: Promise<void>;
	stderr: string;
	diagnostics: string[];
	waiters: Set<() => void>;
	terminationPromise?: Promise<SubagentHandle>;
	processCloseHandled: boolean;
	ownerSessionFile: string;
	ownerSessionId: string;
	incarnation: string;
	resumedFrom?: string;
	assistantAssembly?: AssistantAssembly;
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
		outputPath: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Optional caller-owned output path. Relative paths use the caller cwd.",
			}),
		),
	},
	{ additionalProperties: false },
);
const ListSchema = Type.Object({
	includeFinished: Type.Optional(Type.Boolean({ default: true })),
});
const StatusSchema = Type.Object(
	{
		id: Type.String(),
		messageOffset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
		numMessages: Type.Optional(
			Type.Integer({ minimum: 0, maximum: 20, default: 3 }),
		),
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

function updateAssistantAssembly(
	handle: SubagentHandle,
	record: RpcRecord,
): Record<string, unknown> | undefined {
	const direct = isRecord(record.message) ? record.message : undefined;
	if (record.type === "message_start" && direct?.role === "assistant") {
		handle.assistantAssembly = { message: copyMessage(direct) };
		return direct;
	}
	if (record.type === "message_end" && direct?.role === "assistant") {
		handle.assistantAssembly = undefined;
		return direct;
	}
	if (record.type === "message_update" && direct?.role === "assistant") {
		handle.assistantAssembly = { message: copyMessage(direct) };
		return direct;
	}
	if (record.type !== "message_update") return direct;
	const assembly = handle.assistantAssembly;
	const event = isRecord(record.assistantMessageEvent)
		? record.assistantMessageEvent
		: undefined;
	if (!assembly || !event) return undefined;
	const content = Array.isArray(assembly.message.content)
		? assembly.message.content
		: (assembly.message.content = []);
	const rawIndex = event.contentIndex;
	const index = Number.isInteger(rawIndex) ? Number(rawIndex) : content.length;
	const type = typeof event.type === "string" ? event.type : "";
	const existing = isRecord(content[index]) ? content[index] : undefined;
	if (type === "text_start") {
		content[index] = { type: "text", text: "" };
	} else if (type === "text_delta") {
		const block = existing?.type === "text" ? existing : { type: "text", text: "" };
		block.text = `${typeof block.text === "string" ? block.text : ""}${typeof event.delta === "string" ? event.delta : ""}`;
		content[index] = block;
	} else if (type === "text_end") {
		const block = existing?.type === "text" ? existing : { type: "text", text: "" };
		if (typeof event.content === "string") block.text = event.content;
		content[index] = block;
	} else if (type === "thinking_start") {
		content[index] = { type: "thinking", thinking: "" };
	} else if (type === "thinking_delta") {
		const block =
			existing?.type === "thinking"
				? existing
				: { type: "thinking", thinking: "" };
		block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${typeof event.delta === "string" ? event.delta : ""}`;
		content[index] = block;
	} else if (type === "thinking_end") {
		const block =
			existing?.type === "thinking"
				? existing
				: { type: "thinking", thinking: "" };
		if (typeof event.content === "string") block.thinking = event.content;
		content[index] = block;
	} else if (type === "toolcall_start") {
		content[index] = {
			type: "toolCall",
			name: typeof event.name === "string" ? event.name : "",
			arguments: {},
		};
	} else if (type === "toolcall_end" && isRecord(event.toolCall)) {
		content[index] = { ...event.toolCall };
	} else if (type === "toolcall_delta") {
		const block =
			existing?.type === "toolCall"
				? existing
				: { type: "toolCall", name: "", arguments: "" };
		const delta = typeof event.delta === "string" ? event.delta : "";
		block.arguments = `${typeof block.arguments === "string" ? block.arguments : ""}${delta}`;
		content[index] = block;
	}
	return assembly.message;
}

function applyResponseState(handle: SubagentHandle, response: RpcResponseRecord): void {
	if (!isRecord(response.data)) return;
	const data = response.data;
	if (typeof data.sessionFile === "string" && data.sessionFile)
		handle.sessionPath = data.sessionFile;
	if (typeof data.sessionId === "string" && data.sessionId)
		handle.sessionId = data.sessionId;
	if (isRecord(data.model) && typeof data.model.provider === "string" && typeof data.model.id === "string")
		handle.actualModel = {
			provider: data.model.provider,
			id: data.model.id,
			...(typeof data.model.name === "string" ? { name: data.model.name } : {}),
		};
	if (isThinking(data.thinkingLevel)) handle.actualThinking = data.thinkingLevel;
}

function assistantModelFromRecord(handle: SubagentHandle, record: RpcRecord): void {
	const message = isRecord(record.message) ? record.message : undefined;
	if (!message) return;
	if (typeof message.provider === "string" && typeof message.model === "string")
		handle.actualModel = {
			provider: message.provider,
			id: message.model,
		};
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
	let authorityLossPromise: Promise<void> | undefined;
	let sessionShuttingDown = false;
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
		settlementNotifications.suppressAll();
	};

	const sorted = () =>
		[...handles.values()].sort(
			(a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
		);
	const active = (handle: SubagentHandle) => handle.processState === "alive";
	const requireLease = (): boolean => leaseHeld && owner !== null;
	const setControllerStatus = (
		ctx: ExtensionContext | null,
		text: string | undefined,
	): void => {
		ctx?.ui?.setStatus("subagent-rpc", text);
	};

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
		if (!leaseHeld || !owner) return false;
		const authoritative = await ensureLeaseAuthority(owner);
		if (!authoritative)
			void loseAuthority(
				"Controller lease lost. Run /reload to re-establish it.",
			);
		return authoritative;
	}

	const addDiagnostic = (handle: SubagentHandle, message: string) => {
		handle.diagnostics.push(message.slice(0, MAX_DIAGNOSTIC_LENGTH));
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
		pid: handle.pid,
		exitCode: handle.exitCode,
		exitSignal: handle.exitSignal,
		sessionDir: handle.sessionDir,
		sessionFile: handle.sessionPath,
		promptPath: handle.promptPath,
		requestedModel: handle.requestedModel,
		requestedThinking: handle.requestedThinking,
		processState: handle.processState,
		runState: handle.runState,
		runId: handle.runSequence || undefined,
		runCursor: handle.runSequence || undefined,
		lastSettledRunId: handle.lastSettledRunId || undefined,
		runOutcome: handle.runOutcome,
		settlementStatus: handle.settlementStatus,
		createdAt: handle.createdAt,
		lastActivityAt: handle.lastActivityAt,
		error: handle.error || handle.finalError,
		stderrTail: tail(handle.stderr),
		diagnostics: handle.diagnostics.length ? [...handle.diagnostics] : undefined,
		outputPath: handle.outputPath,
		outputStatus: handle.outputStatus,
		outputError: handle.outputError
			? boundOutputError(handle.outputError)
			: undefined,
		ownerSessionFile: handle.ownerSessionFile,
		ownerSessionId: handle.ownerSessionId,
		incarnation: handle.incarnation,
		resumedFrom: handle.resumedFrom,
	});
	const registryEntries = (): RegistryEntry[] => sorted().map(registryEntry);
	const persist = (snapshot?: RegistryEntry[]): Promise<boolean> => {
		const persistenceOwner = owner;
		if (!persistenceOwner || !leaseHeld) return Promise.resolve(false);
		const path = ownerRegistryPath(getAgentDir(), persistenceOwner);
		const entries = snapshot || registryEntries();
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
		if (shouldPersist && leaseHeld) void persist();
	};

	function acceptSettlement(
		handle: SubagentHandle,
		runId: number,
		outcome: Exclude<RunOutcome, "pending">,
		result: string,
		settledAt: number,
	): void {
		const notification: SettlementNotificationRecord = {
			ownerSessionFile: handle.ownerSessionFile,
			ownerSessionId: handle.ownerSessionId,
			childId: handle.id,
			incarnation: handle.incarnation,
			runId,
			eventKind: "run_settled",
			outcome,
		};

		// Queue the non-durable wake before any optional persistence or output work.
		if (!sessionShuttingDown && leaseHeld && !handle.killRequestedAt)
			settlementNotifications.queue(notification);

		handle.outputStatus = handle.outputPath ? "pending" : "not_requested";
		handle.outputError = undefined;
		if (!handle.outputPath) return;

		const outputPath = handle.outputPath;
		const outputContent = result;
		const write = handle.outputWriteChain.then(async () => {
			const written = await writeCallerOutput({
				path: outputPath,
				content: outputContent,
			});
			handle.outputStatus = written.status;
			if (written.status === "failed") {
				handle.outputError = written.error;
				addDiagnostic(
					handle,
					`Run ${runId} caller output failed: ${written.error}`,
				);
			} else {
				handle.outputError = undefined;
			}
			update(handle);
		});
		handle.outputWriteChain = write.catch((error) => {
			handle.outputStatus = "failed";
			handle.outputError = boundOutputError(error);
			addDiagnostic(handle, `Run ${runId} caller output failed: ${handle.outputError}`);
			update(handle);
		});
		void handle.outputWriteChain;
	}

	async function serialize(
		handle: SubagentHandle,
		transcriptOptions: TranscriptOptions = {},
	) {
		const transcript = await readTranscript(handle.sessionPath, transcriptOptions);
		handle.transcriptStatus = transcript.status;
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
			ownerSessionFile: handle.ownerSessionFile,
			ownerSessionId: handle.ownerSessionId,
			incarnation: handle.incarnation,
			state: handle.state,
			lifecycle: handle.lifecycle,
			processState: handle.processState,
			runState: handle.runState,
			runId: handle.runSequence || undefined,
			lastSettledRunId: handle.lastSettledRunId || undefined,
			runOutcome: handle.runOutcome || "pending",
			sessionPath: handle.sessionPath || "",
			lastActivityAt: handle.lastActivityAt,
			settlement: { status: handle.settlementStatus },
			transcript: {
				status: transcript.status,
				messages: transcript.messages,
				nextMessageOffset: transcript.nextMessageOffset,
			},
			error: handle.error || handle.finalError || undefined,
			stderrTail: tail(handle.stderr),
			output: {
				path: handle.outputPath,
				status: handle.outputStatus,
				...(handle.outputError
					? { error: boundOutputError(handle.outputError) }
					: {}),
			},
			task: handle.task,
			cwd: handle.cwd,
			sessionDir: handle.sessionDir,
			pid: handle.pid,
			exitCode: handle.exitCode,
			exitSignal: handle.exitSignal,
			rpcReady: handle.rpcReady,
			requestedModel: handle.requestedModel,
			requestedThinking: handle.requestedThinking,
			actualModel,
			actualThinking: handle.actualThinking || handle.requestedThinking,
			promptPath: handle.promptPath,
			createdAt: handle.createdAt,
			rpcReadyAt: handle.rpcReadyAt,
			agentStartedAt: handle.agentStartedAt,
			completedAt: handle.completedAt,
			currentTool: handle.currentTool,
			currentToolStartedAt: handle.currentToolStartedAt,
			lastTool: handle.lastTool,
			isStreaming: handle.isStreaming,
			usage: { ...handle.usage },
			stopReason: handle.stopReason,
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
			`#${handle.id}${handle.name ? ` ${handle.name}` : ""} ${handle.processState}/${handle.runState} · run:${handle.runSequence || 0}\n  actual ${formatModel(serial.actualModel)} · thinking:${serial.actualThinking}\n  process ${handle.pid ?? "?"}${handle.exitCode !== undefined ? ` · exit ${handle.exitCode}` : ""}${handle.rpcReady ? " · RPC ready" : ""}\n  session ${serial.sessionPath} (transcript ${serial.transcript.status})${serial.error ? `\n  error ${truncate(serial.error, 180)}` : ""}`,
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
			incarnation: string;
		},
	): SubagentHandle {
		const stopped = entry.processState === "stopped";
		const runSequence = Math.max(
			nonnegativeSafeInteger(entry.runCursor) ??
				nonnegativeSafeInteger(entry.runId) ??
				0,
			nonnegativeSafeInteger(entry.lastSettledRunId) ?? 0,
		);
		const lastSettledRunId = Math.min(
			runSequence,
			nonnegativeSafeInteger(entry.lastSettledRunId) ?? 0,
		);
		const outputPath =
			typeof entry.outputPath === "string" && entry.outputPath.length > 0
				? entry.outputPath
				: undefined;
		const outputStatus = outputPath
			? isOutputStatus(entry.outputStatus) && entry.outputStatus !== "not_requested"
				? entry.outputStatus
				: "pending"
			: "not_requested";
		const runOutcome = isRunOutcome(entry.runOutcome)
			? entry.runOutcome
			: "pending";
		const restoredState = stopped
			? runOutcome === "failed" || entry.error
				? "error"
				: "done"
			: "starting";
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
			exitCode: entry.exitCode,
			exitSignal: entry.exitSignal,
			processState: stopped ? "stopped" : "alive",
			runState: entry.runState || "idle",
			runSequence,
			lastSettledRunId,
			runOutcome,
			settlementStatus: isSettlementStatus(entry.settlementStatus)
				? entry.settlementStatus
				: "pending",
			state: restoredState,
			lifecycle: stopped
				? restoredState
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
			createdAt: entry.createdAt,
			lastActivityAt: entry.lastActivityAt,
			outputPath,
			outputStatus,
			outputError:
				entry.outputError === undefined
					? undefined
					: boundOutputError(entry.outputError),
			transcriptStatus: "missing",
			outputWriteChain: Promise.resolve(),
			stderr: typeof entry.stderrTail === "string" ? tail(entry.stderrTail) || "" : "",
			error: entry.error,
			finalError:
				entry.error && (stopped || runOutcome === "failed")
					? entry.error
					: undefined,
			diagnostics: Array.isArray(entry.diagnostics)
				? entry.diagnostics
						.filter((item): item is string => typeof item === "string")
						.slice(-MAX_DIAGNOSTICS)
				: [],
			waiters: new Set(),
			processCloseHandled: stopped,
			rpcReady: false,
			ownerSessionFile: entry.ownerSessionFile,
			ownerSessionId: entry.ownerSessionId,
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
					);
				}
				notifyWaiters(handle);
				update(handle);
			},
		};
	}

	function handleProcessClose(
		handle: SubagentHandle,
		close: RpcProcessClose,
		runtime?: RuntimeChild,
	): void {
		if (runtime && !runtimeMatches(handle, runtime)) return;
		if (handle.processCloseHandled) return;
		handle.processCloseHandled = true;
		handle.rpcReady = false;
		handle.isStreaming = false;
		handle.activeTools.clear();
		handle.currentTool = undefined;
		handle.currentToolStartedAt = undefined;
		deactivateAssistantMessage(handle);
		handle.assistantAssembly = undefined;
		handle.exitCode = close.code;
		handle.exitSignal = close.signal;
		handle.stderr = (runtime?.transport || handle.rpc)?.stderr || handle.stderr;
		addDiagnostic(
			handle,
			`RPC child process closed (code=${close.code ?? "null"} signal=${close.signal ?? "none"}).`,
		);
		if (close.error)
			addDiagnostic(handle, `RPC child process close error: ${close.error.message}`);
		if (handle.processState !== "stopped") {
			markStopped(handle, now(), {
				code: close.code,
				signal: close.signal,
				error: close.error?.message,
			});
		}
		notifyWaiters(handle);
		update(handle);
	}

	function handleRpcRecord(
		handle: SubagentHandle,
		runtime: RuntimeChild,
		record: RpcRecord,
	): void {
		if (!runtimeMatches(handle, runtime)) return;
		if (handle.processState === "stopped") {
			addDiagnostic(handle, `Ignored RPC event ${String(record.type)} after process close.`);
			return;
		}
		if (record.type === "message_start" || record.type === "message_update" || record.type === "message_end") {
			const message = updateAssistantAssembly(handle, record);
			if (message) {
				assistantModelFromRecord(handle, { ...record, message });
				dispatchSubagentEvent(handle, { ...record, message }, dispatchOptions(handle));
			} else {
				addDiagnostic(handle, `Ignored RPC ${String(record.type)} without an assistant message.`);
			}
			return;
		}
		if (record.type === "agent_start") handle.assistantAssembly = undefined;
		const accepted = dispatchSubagentEvent(handle, record, dispatchOptions(handle));
		if (record.type === "agent_settled" && accepted)
			handle.assistantAssembly = undefined;
	}

	function bindRuntime(handle: SubagentHandle, runtime: RuntimeChild): void {
		runtime.handle = handle;
		handle.runtime = runtime;
		handle.rpc = runtime.transport;
		handle.pid = runtime.transport.process.pid;
		handle.rpcReady = !runtime.transport.isClosed;
		if (handle.rpcReady) handle.rpcReadyAt ||= now();
		for (const diagnostic of runtime.diagnostics.splice(0))
			addDiagnostic(handle, diagnostic);
		attachRuntime(
			runtime,
			(record) => handleRpcRecord(handle, runtime, record),
			(close) => handleProcessClose(handle, close, runtime),
		);
	}

	function startRuntime(handle: SubagentHandle, invocation: string[], env: NodeJS.ProcessEnv): Promise<void> {
		const [command, ...args] = invocation;
		if (!command) throw new Error("Pi invocation is empty.");
		let child: ChildProcess;
		try {
			child = spawn(command, args, {
				cwd: handle.cwd,
				env,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			throw new Error(`Could not start RPC child: ${error instanceof Error ? error.message : String(error)}`);
		}
		const runtime = {
			id: handle.id,
			incarnation: handle.incarnation,
			queuedRecords: [],
			diagnostics: [],
		} as RuntimeChild;
		const transport = new RpcChildTransport(child, {
			onRecord: (record) => {
				if (runtime.consumer) runtime.consumer(record);
				else runtime.queuedRecords.push(record);
			},
			onDiagnostic: (message) => {
				if (runtime.handle && runtimeMatches(runtime.handle, runtime))
					addDiagnostic(runtime.handle, message);
				else if (!runtime.handle) runtime.diagnostics.push(message);
			},
			onClose: (close) => {
				runtime.closed = close;
				if (runtime.closeConsumer) runtime.closeConsumer(close);
			},
			requestTimeoutMs: REQUEST_TIMEOUT_MS,
		});
		runtime.transport = transport;
		runtimeChildren.set(handle.id, runtime);
		bindRuntime(handle, runtime);
		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error(`Timed out waiting for RPC child #${handle.id} to spawn.`));
			}, STARTUP_TIMEOUT_MS);
			timer.unref?.();
			const onSpawn = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				handle.pid = child.pid;
				handle.rpcReady = true;
				handle.rpcReadyAt = now();
				notifyWaiters(handle);
				resolve();
			};
			const onError = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
			if (child.pid !== undefined) onSpawn();
		});
	}

	function awaitReady(handle: SubagentHandle): Promise<void> {
		if (handle.rpcReady && handle.rpc) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				handle.waiters.delete(check);
				reject(new Error(`Timed out waiting for RPC child #${handle.id} to become ready.`));
			}, STARTUP_TIMEOUT_MS);
			timer.unref?.();
			const check = () => {
				if (handle.rpcReady && handle.rpc) {
					clearTimeout(timer);
					handle.waiters.delete(check);
					resolve();
				} else if (handle.processState === "stopped") {
					clearTimeout(timer);
					handle.waiters.delete(check);
					reject(new Error(`RPC child #${handle.id} closed before it became ready.`));
				}
			};
			handle.waiters.add(check);
			check();
		});
	}

	async function sendRpc(
		handle: SubagentHandle,
		body: RpcRecord,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<RpcResponseRecord> {
		if (!(await requireCurrentAuthority()))
			throw new Error(await leaseConflictMessage());
		if (handle.processState !== "alive")
			throw new Error(`Subagent #${handle.id} is no longer running.`);
		if (!handle.rpc || !handle.rpcReady)
			throw new Error(`Subagent #${handle.id} RPC process is not ready.`);
		const response = await handle.rpc.send(body, timeoutMs);
		applyResponseState(handle, response);
		update(handle);
		return response;
	}

	async function terminate(
		handle: SubagentHandle,
		checkAuthority = true,
	): Promise<SubagentHandle> {
		if (checkAuthority && !(await requireCurrentAuthority()))
			throw new Error(await leaseConflictMessage());
		if (handle.processState === "stopped") return handle;
		if (handle.terminationPromise) return handle.terminationPromise;
		handle.terminationPromise = (async () => {
			settlementNotifications.suppressChild(handle.id);
			requestKill(handle, now());
			update(handle, false);
			const transport = handle.rpc;
			if (transport) {
				await transport
					.terminate({
						abort: true,
						abortTimeoutMs: ABORT_TIMEOUT_MS,
						closeAfterAbortMs: 250,
						termTimeoutMs: 1_500,
						killTimeoutMs: 2_500,
					})
					.catch((error) => addDiagnostic(handle, `RPC termination failed: ${String(error)}`));
				if (handle.processState !== "stopped" && !transport.isClosed)
					transport.forceClose({
						code: null,
						signal: "SIGKILL",
						error: new Error("RPC child termination was forced."),
					});
			} else {
				handleProcessClose(handle, {
					code: null,
					signal: "SIGKILL",
					error: new Error("RPC child did not expose a process."),
				});
			}
			handle.completedAt ||= now();
			await persistenceChain;
			return handle;
		})();
		return handle.terminationPromise;
	}

	async function loseAuthority(reason: string): Promise<void> {
		if (authorityLossPromise) return authorityLossPromise;
		leaseHeld = false;
		suppressAllSettlementNotifications();
		stopTimers();
		setControllerStatus(latestCtx, undefined);
		for (const handle of handles.values()) addDiagnostic(handle, reason);
		refreshUi();
		const children = sorted().filter(active);
		const termination = Promise.allSettled(
			children.map((handle) => terminate(handle, false)),
		).then(() => undefined);
		authorityLossPromise = termination.finally(() => {
			authorityLossPromise = undefined;
		});
		return authorityLossPromise;
	}

	async function deliverMessage(
		handle: SubagentHandle,
		requestedCommand: "steer" | "follow_up",
		message: string,
	): Promise<"prompt" | "steer" | "follow_up"> {
		const command = handle.runState === "idle" ? "prompt" : requestedCommand;
		const before = handle.runSequence;
		await sendRpc(handle, { type: command, message });
		if (command === "prompt")
			await waitUntil(
				() => handle.runSequence > before || handle.processState === "stopped",
				1_000,
			);
		return command;
	}

	async function interrupt(handle: SubagentHandle): Promise<boolean> {
		if (handle.processState !== "alive")
			throw new Error(`Subagent #${handle.id} is no longer running.`);
		if (!(await requireCurrentAuthority()))
			throw new Error(await leaseConflictMessage());
		if (handle.runState === "idle") return true;
		handle.abortRequestedAt = now();
		try {
			await sendRpc(handle, { type: "abort" }, ABORT_TIMEOUT_MS);
			return true;
		} catch (error) {
			handle.abortRequestedAt = undefined;
			addDiagnostic(handle, `RPC abort failed: ${String(error)}`);
			return false;
		}
	}

	async function launch(
		spec: TaskSpec,
		cwd: string,
		requestedModel: string,
		requestedThinking: ThinkingLevel,
		outputPath?: string,
	): Promise<SubagentHandle> {
		if (!(await requireCurrentAuthority()))
			throw new Error(await leaseConflictMessage());
		const resolvedOwner = owner;
		if (!resolvedOwner)
			throw new Error("Controller owner identity is not established.");
		const stat = await fs.stat(cwd).catch(() => undefined);
		if (!stat?.isDirectory())
			throw new Error(`Subagent cwd does not exist or is not a directory: ${cwd}`);
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
			outputPath,
			processState: "alive",
			runState: "idle",
			createdAt: now(),
			lastActivityAt: now(),
			ownerSessionFile: resolvedOwner.ownerSessionFile,
			ownerSessionId: resolvedOwner.ownerSessionId,
			incarnation,
		});
		handles.set(id, handle);
		await persist();
		try {
			const invocation = buildRpcChildInvocation({
				sessionDir,
				model: requestedModel,
				thinking: requestedThinking,
			});
			await startRuntime(
				handle,
				invocation,
				childEnvironment({
					childId: id,
					incarnation,
					depth: getDepth() + 1,
					runIdBase: 0,
					systemPrompt: spec.systemPrompt || "",
					promptPath: handle.promptPath,
					sessionDir,
					leasePath: leasePath(getAgentDir(), resolvedOwner),
					ownerSessionFile: resolvedOwner.ownerSessionFile,
					ownerSessionId: resolvedOwner.ownerSessionId,
					controllerInstanceId,
				}),
			);
			await awaitReady(handle);
			await sendRpc(handle, { type: "get_state" }, STARTUP_TIMEOUT_MS);
			const before = handle.runSequence;
			await sendRpc(handle, { type: "prompt", message: spec.task });
			await waitUntil(
				() => handle.runSequence > before || handle.processState === "stopped",
				1_000,
			);
			return handle;
		} catch (error) {
			addDiagnostic(
				handle,
				`Child startup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			await terminate(handle, false).catch(() => {});
			handles.delete(id);
			await persist();
			throw error;
		}
	}

	async function resumeChild(handle: SubagentHandle, task?: string): Promise<void> {
		if (!(await requireCurrentAuthority()))
			throw new Error(await leaseConflictMessage());
		const resolvedOwner = owner;
		if (!resolvedOwner)
			throw new Error("Controller owner identity is not established.");
		const sessionFile = handle.sessionPath;
		if (!sessionFile)
			throw new Error(`No usable child session file exists for #${handle.id}; resume is not possible.`);
		const usable = await fs
			.stat(sessionFile)
			.then((s) => s.isFile() && s.size > 0)
			.catch(() => false);
		if (!usable)
			throw new Error(`No usable child session file exists for #${handle.id}; resume is not possible.`);
		// Complete older output publication before persisting the new incarnation.
		await handle.outputWriteChain;
		const runIdBase = Math.max(
			handle.runSequence,
			handle.lastSettledRunId,
		);
		const oldIncarnation = handle.incarnation;
		const incarnation = createId();
		const nextRegistry = registryEntries().map((entry) =>
			entry.childId === handle.id
				? {
						...entry,
						pid: undefined,
						exitCode: undefined,
						exitSignal: undefined,
						processState: "alive" as const,
						runState: "idle" as const,
						runId: runIdBase || undefined,
						runCursor: runIdBase || undefined,
						runOutcome: "pending" as const,
						settlementStatus: "pending" as const,
						error: undefined,
						incarnation,
						resumedFrom: oldIncarnation,
					}
				: entry,
		);
		if (!(await persist(nextRegistry)))
			throw new Error(`Could not persist the resumed state for #${handle.id}.`);
		handle.runSequence = runIdBase;
		handle.incarnation = incarnation;
		handle.resumedFrom = oldIncarnation;
		reviveForResume(handle);
		handle.completedAt = undefined;
		handle.error = undefined;
		handle.stopReason = undefined;
		handle.terminationPromise = undefined;
		handle.rpcReady = false;
		handle.rpcReadyAt = undefined;
		handle.rpc = undefined;
		handle.runtime = undefined;
		handle.processCloseHandled = false;
		handle.exitCode = undefined;
		handle.exitSignal = undefined;
		handle.isStreaming = false;
		handle.activeTools.clear();
		handle.currentTool = undefined;
		handle.currentToolStartedAt = undefined;
		deactivateAssistantMessage(handle);
		handle.assistantAssembly = undefined;
		try {
			const invocation = buildRpcChildInvocation({
				sessionFile,
				sessionDir: handle.sessionDir,
				model: handle.requestedModel,
				thinking: handle.requestedThinking,
			});
			await startRuntime(
				handle,
				invocation,
				childEnvironment({
					childId: handle.id,
					incarnation,
					depth: getDepth() + 1,
					runIdBase,
					systemPrompt: "",
					promptPath: handle.promptPath,
					sessionDir: handle.sessionDir,
					leasePath: leasePath(getAgentDir(), resolvedOwner),
					ownerSessionFile: resolvedOwner.ownerSessionFile,
					ownerSessionId: resolvedOwner.ownerSessionId,
					controllerInstanceId,
				}),
			);
			await awaitReady(handle);
			await sendRpc(handle, { type: "get_state" }, STARTUP_TIMEOUT_MS);
			if (task) {
				const before = handle.runSequence;
				await sendRpc(handle, { type: "prompt", message: task });
				await waitUntil(
					() => handle.runSequence > before || handle.processState === "stopped",
					1_000,
				);
			}
		} catch (error) {
			addDiagnostic(
				handle,
				`Child resume failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			await terminate(handle, false).catch(() => {});
			throw error;
		}
	}

	function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			if (predicate()) return resolve();
			const deadline = now() + timeoutMs;
			const timer = setInterval(() => {
				if (predicate() || now() >= deadline) {
					clearInterval(timer);
					resolve();
				}
			}, 20);
			timer.unref?.();
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
		if (!isThinking(spec.thinking))
			return { error: `Invalid thinking level ${String(spec.thinking)}.` };
		return { model: ref, thinking: spec.thinking };
	}

	async function reconcile() {
		if (!owner || !(await requireCurrentAuthority())) return;
		const path = ownerRegistryPath(getAgentDir(), owner);
		const saved = registryEntriesForOwner(await loadRegistry(path), owner);
		for (const entry of saved) {
			const existing = handles.get(entry.childId);
			const runtime = runtimeChildren.get(entry.childId);
			const retained = runtime?.handle;
			const handle = existing || retained || createHandle(entry);
			if (!existing) handles.set(handle.id, handle);
			if (runtime && runtime.incarnation === handle.incarnation) {
				bindRuntime(handle, runtime);
			} else if (handle.processState === "alive") {
				markStopped(handle, now(), {
					error: "RPC child process was not available after controller reload.",
				});
			}
			if (runtime?.transport.isClosed) runtimeChildren.delete(entry.childId);
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
			runOutcome: handle.runOutcome || "pending",
			settlementStatus: handle.settlementStatus,
			rpcReady: handle.rpcReady,
			killing: handle.lifecycle === "killing",
			task: handle.task,
			cwd: handle.cwd,
			pid: handle.pid,
			exitCode: handle.exitCode,
			exitSignal: handle.exitSignal,
			requestedModel: handle.requestedModel,
			requestedThinking: handle.requestedThinking,
			actualModel,
			actualThinking: handle.actualThinking || handle.requestedThinking,
			sessionPath: handle.sessionPath || "",
			promptPath: handle.promptPath,
			outputPath: handle.outputPath,
			outputStatus: handle.outputStatus,
			transcriptStatus: handle.transcriptStatus,
			createdAt: handle.createdAt,
			rpcReadyAt: handle.rpcReadyAt,
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
			stderrTail: tail(handle.stderr),
			tentativeError: handle.tentativeError,
			finalError: handle.finalError,
			settledAt: handle.settledAt,
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
					if (ok) return;
					void loseAuthority(
						"Controller lease lost during renewal. Run /reload to re-establish it.",
					);
				},
				(error) => {
					void loseAuthority(`Controller lease renewal failed: ${String(error)}`);
				},
			);
		}, LEASE_RENEW_INTERVAL_MS);
		leaseRenewTimer.unref();
	}

	async function establishController(ctx: ExtensionContext): Promise<void> {
		const sessionFile = ctx.sessionManager?.getSessionFile();
		const sessionId = ctx.sessionManager?.getSessionId();
		if (!sessionFile || !sessionId) {
			owner = null;
			leaseHeld = false;
			stopTimers();
			setControllerStatus(ctx, undefined);
			return;
		}
		const resolved: OwnerIdentity = {
			ownerSessionFile: await canonicalOwnerSessionFile(sessionFile),
			ownerSessionId: sessionId,
		};
		const result = await acquireLease(
			getAgentDir(),
			resolved,
			controllerInstanceId,
			now(),
		);
		if (result.conflict) {
			owner = null;
			leaseHeld = false;
			stopTimers();
			setControllerStatus(ctx, undefined);
			const { existing } = result;
			console.error(
				`Subagent controller lease for this session is held by controller ${existing.controllerInstanceId} (pid ${existing.pid}, ${isProcessAlive(existing.pid) ? "running" : "not running"}), expiring ${new Date(existing.expiresAt).toISOString()}. Quit that Pi process, then reload here.`,
			);
			return;
		}
		owner = resolved;
		leaseHeld = true;
		setControllerStatus(ctx, "ready");
		startLeaseRenewal();
	}

	async function leaseConflictMessage(): Promise<string> {
		const base = "Subagent controller lease is not held.";
		if (!owner)
			return `${base} This Pi session has no persisted session file, so no controller was established.`;
		const path = leasePath(getAgentDir(), owner);
		const existing = await readLeaseRecord(getAgentDir(), owner).catch(() => undefined);
		if (!existing)
			return `${base} No lease record exists at ${path}. Run /reload to re-establish this controller.`;
		if (existing.controllerInstanceId === controllerInstanceId)
			return `${base} The record at ${path} still belongs to this process (pid ${existing.pid}), but this controller stopped holding it. Run /reload to reclaim it.`;
		return isProcessAlive(existing.pid)
			? `${base} Another live Pi process (pid ${existing.pid}) owns session ${existing.ownerSessionId} and holds ${path}. Quit that process, then run /reload here.`
			: `${base} The record at ${path} names pid ${existing.pid}, which is no longer running. Run /reload to take it over.`;
	}

	function releaseLeaseIfHeld() {
		if (!owner || !leaseHeld) return Promise.resolve();
		return releaseLease(getAgentDir(), owner, controllerInstanceId);
	}

	async function waitForOutputWrites(): Promise<void> {
		await Promise.all([...handles.values()].map((handle) => handle.outputWriteChain));
	}

	async function stopAllChildren(): Promise<void> {
		await Promise.allSettled(
			sorted()
				.filter(active)
				.map((handle) => terminate(handle, false)),
		);
		await waitForOutputWrites();
		await persistenceChain;
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
		if (reason === "reload") {
			stopTimers();
			for (const handle of handles.values()) {
				if (!handle.runtime) continue;
				handle.runtime.handle = handle;
				detachRuntime(handle.runtime);
			}
			await waitForOutputWrites();
			await persistenceChain;
			if (ctx.mode === "tui") ctx.ui.setWidget("subagent", undefined);
			latestCtx = null;
			return;
		}
		await stopAllChildren();
		await persist();
		await persistenceChain;
		stopTimers();
		await releaseLeaseIfHeld();
		owner = null;
		leaseHeld = false;
		for (const [id, runtime] of runtimeChildren) {
			if (runtime.transport.isClosed || handles.has(id)) runtimeChildren.delete(id);
		}
		if (reason !== "quit") handles.clear();
		if (ctx.mode === "tui") ctx.ui.setWidget("subagent", undefined);
		latestCtx = null;
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt:
			event.systemPrompt +
			`\n\nSubagent extension is available. Use it only for explicit delegation. subagent_start requires an explicit provider/model and thinking level; use list_models when needed instead of guessing. Children are persistent Pi RPC processes. Native agent_end is intermediate. Native agent_settled is the only run completion edge, and the child remains alive and idle after settlement. Prompt, follow-up, steer, and abort responses confirm acceptance or queueing only. The start command observes run acceptance for at most one second and does not wait for the model response. Settlement wakes are best effort, non-durable steering messages for success, failure, and abort. Do not poll subagent_status or use sleep commands to wait for completion. Use subagent_status for bounded run diagnosis, transcript pages, output status, process-close evidence, and stale or missing evidence. Transcript pages read bounded JSONL projections with available, missing, incomplete, or unreadable status, and transcript text never proves completion. A process close before agent_settled is terminal closed_without_settlement evidence with exit code, signal, stderr, and diagnostics, and it never emits a settlement wake. Set outputPath when the caller needs one atomic, non-overwriting output file; output status is independent of run outcome. The owner lease, incarnation, and durable run cursor survive reload and resume, and stale runtime callbacks are ignored. A cooperative abort is acknowledged when accepted; agent_settled with outcome aborted is the completion edge. There is no watchdog. Use subagent_follow_up for another turn, subagent_steer during a run, subagent_interrupt to abort while keeping the child alive, and subagent_kill for bounded termination.`,
	}));

	pi.registerTool<typeof TaskSpecSchema, unknown>({
		name: "subagent_start",
		label: "Subagent Start",
		description:
			"Start a persistent Pi RPC child with an explicit model and thinking level. The response confirms acceptance only. Use outputPath for optional caller-owned atomic output. A best-effort settlement wake reports success, failure, or abort. Diagnose runs with subagent_status instead of polling for completion. Call subagent_kill when the child is no longer useful.",
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
				const callerCwd = ctx.cwd;
				const childCwd = spec.cwd ? resolve(callerCwd, spec.cwd) : callerCwd;
				const outputPath = spec.outputPath
					? resolve(callerCwd, spec.outputPath)
					: undefined;
				const handle = await launch(
					spec,
					childCwd,
					choice.model,
					choice.thinking,
					outputPath,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Started persistent subagent #${handle.id} as a Pi RPC child process.`,
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
				details: { handles: await Promise.all(chosen.map((handle) => serialize(handle))) },
			};
		},
	});
	pi.registerTool<typeof StatusSchema, unknown>({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Return bounded process/run diagnostics, settlement evidence, transcript text, and caller output status. Use this tool for diagnosis only. Do not infer completion from polling, silence, transcript text, or output files.",
		parameters: StatusSchema,
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			const serial = await serialize(handle, {
				messageOffset: params.messageOffset,
				numMessages: params.numMessages,
			});
			return {
				content: [{ type: "text" as const, text: await summary(handle) }],
				details: {
					...serial,
					timestamps: {
						createdAt: serial.createdAt,
						rpcReadyAt: serial.rpcReadyAt,
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
	pi.registerTool<typeof MessageSchema, unknown>({
		name: "subagent_steer",
		label: "Subagent Steer",
		description: "Accept or queue guidance during a child turn over RPC. The response does not mean completion.",
		parameters: MessageSchema,
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			try {
				const command = await deliverMessage(
					handle,
					"steer",
					params.message.trim(),
				);
				return {
					content: [{ type: "text" as const, text: `Steering accepted by #${handle.id}.` }],
					details: {
						handle: await serialize(handle),
						accepted: true,
						queued: command !== "prompt",
						command,
					},
				};
			} catch (error) {
				return { content: [{ type: "text" as const, text: String(error) }], details: { accepted: false } };
			}
		},
	});
	pi.registerTool<typeof MessageSchema, unknown>({
		name: "subagent_follow_up",
		label: "Subagent Follow Up",
		description: "Accept or queue another user turn for a live persistent child. The response does not mean completion.",
		parameters: MessageSchema,
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			try {
				const command = await deliverMessage(
					handle,
					"follow_up",
					params.message.trim(),
				);
				return {
					content: [{ type: "text" as const, text: `Follow-up accepted by #${handle.id}.` }],
					details: {
						handle: await serialize(handle),
						accepted: true,
						queued: command !== "prompt",
						command,
					},
				};
			} catch (error) {
				return { content: [{ type: "text" as const, text: String(error) }], details: { accepted: false } };
			}
		},
	});
	pi.registerTool<typeof IdSchema, unknown>({
		name: "subagent_interrupt",
		label: "Subagent Interrupt",
		description: "Accept a cooperative abort while keeping the child process alive. Native settlement reports the eventual aborted outcome.",
		parameters: IdSchema,
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			try {
				const interrupted = await interrupt(handle);
				return {
					content: [
						{
							type: "text" as const,
							text: interrupted
								? `Abort accepted by #${handle.id}; the child remains alive until native settlement.`
								: `Abort was not accepted by #${handle.id}.`,
						},
					],
					details: {
						handle: await serialize(handle),
						interrupted,
						accepted: interrupted,
						settlementPending: interrupted && handle.runState !== "idle",
					},
				};
			} catch (error) {
				return { content: [{ type: "text" as const, text: String(error) }], details: { interrupted: false } };
			}
		},
	});
	pi.registerTool<typeof IdSchema, unknown>({
		name: "subagent_kill",
		label: "Subagent Kill",
		description: "Terminate the child process after cooperative abort and bounded escalation. Use this cleanup action for completed or abandoned children.",
		parameters: IdSchema,
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			if (!active(handle))
				return {
					content: [{ type: "text" as const, text: `Subagent #${handle.id} is already stopped.` }],
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
		description: "Resume a stopped child from its saved Pi session file in a new RPC process incarnation.",
		parameters: ResumeSchema,
		async execute(_id, params) {
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			if (active(handle))
				return {
					content: [{ type: "text" as const, text: `Subagent #${handle.id} is still alive; resume is for stopped children.` }],
					details: { handle: await serialize(handle) },
				};
			if (!requireLease())
				return { content: [{ type: "text" as const, text: await leaseConflictMessage() }], details: {} };
			try {
				await resumeChild(handle, params.task);
				return {
					content: [{ type: "text" as const, text: `Resumed subagent #${handle.id} from ${handle.sessionPath} in a new RPC process incarnation.` }],
					details: { handle: await serialize(handle) },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
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
							const command = await deliverMessage(handle, "steer", message);
							return `Accepted via ${command}.`;
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
				ctx.ui.notify(`Subagent widget ${widgetVisible ? "enabled" : "disabled"}.`, "info");
		},
	});
	pi.registerCommand("subagents-kill-all", {
		description: "Terminate all live subagents",
		handler: async () => {
			await Promise.allSettled(sorted().filter(active).map((handle) => terminate(handle)));
		},
	});
}
