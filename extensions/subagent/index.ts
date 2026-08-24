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
	drainSubagentEventQueue,
	enqueueSubagentEventQueue,
	isCriticalSubagentEvent,
	MAX_SUBAGENT_EVENT_DRAIN_RECORDS,
	MAX_SUBAGENT_EVENT_QUEUE_RECORDS,
	type SubagentDispatchHandle,
	type SubagentEventQueueState,
} from "./dispatch-event.js";
import {
	createLifecycleState,
	lifecycleActivity,
	markStopped,
	requestKill,
	reviveForResume,
	syncLifecycleCompatibility,
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
	type TranscriptResult,
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
import * as childProtocol from "./child.js";
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
const ABORT_TIMEOUT_MS = 2_000;
const FILE_OPERATION_TIMEOUT_MS = 5_000;
const PERSISTENCE_TIMEOUT_MS = 5_000;
const OUTPUT_WRITE_TIMEOUT_MS = 5_000;
const TRANSCRIPT_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const CHILD_OPERATION_TIMEOUT_MS = 5_000;
const ASSISTANT_DISPLAY_MAX = 64 * 1024;
const TOOL_OUTPUT_TAIL_MAX = 16 * 1024;
const MAX_RECENT_TOOLS = 8;
const MAX_ACTIVE_CHILDREN = 8;
const MAX_RETAINED_HANDLES = 24;
export const MAX_CALLER_TASK_LENGTH = 64 * 1024;
export const MAX_QUEUED_CHILD_OPERATIONS = 32;
const MAX_RELOAD_DRAIN_RETRIES = 8;
const RELOAD_DRAIN_RETRY_DELAY_MS = 25;
const OVERFLOW_TRANSPORT_FENCE_TIMEOUT_MS = 250;
const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LENGTH = 2_048;
const MAX_STDERR_TAIL = 8 * 1024;

const childHealthProtocol = childProtocol as unknown as {
	childExtensionHealthPath?: (sessionDir: string, incarnation: string) => string;
	verifyChildExtensionHealth?: (path: string) => Promise<boolean>;
	CHILD_EXTENSION_HEALTH_SIGNAL?: string;
	CHILD_EXTENSION_HEALTH_MAX_BYTES?: number;
};
const CHILD_EXTENSION_HEALTH_SIGNAL =
	childHealthProtocol.CHILD_EXTENSION_HEALTH_SIGNAL ||
	"pi-subagent-child-extension-ready/v1\n";
const CHILD_EXTENSION_HEALTH_MAX_BYTES =
	childHealthProtocol.CHILD_EXTENSION_HEALTH_MAX_BYTES || 128;
const childExtensionHealthPath =
	childHealthProtocol.childExtensionHealthPath ||
	((sessionDir: string, incarnation: string) =>
		join(sessionDir, `child-extension-health-${incarnation}.marker`));
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
	queueState: SubagentEventQueueState;
	consumer?: (record: RpcRecord) => void;
	closeConsumer?: (close: RpcProcessClose) => void;
	closed?: RpcProcessClose;
	diagnostics: string[];
	handle?: SubagentHandle;
	forced?: boolean;
	fenced: boolean;
	overflowFenceTimer?: NodeJS.Timeout;
	drainTimer?: NodeJS.Timeout;
	draining: boolean;
	drainFailures: number;
	drain?: () => void;
	deliverClose?: () => void;
}

interface PendingPersistence {
	entries: RegistryEntry[];
	owner: OwnerIdentity;
	path: string;
	generation: number;
	waiters: Array<(result: boolean) => void>;
}

type PersistedRegistryEntry = RegistryEntry & {
	killRequestedAt?: number;
};

function abortError(reason?: unknown): Error {
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

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal.reason);
}

function assertCallerTask(task: string): void {
	if (task.length > MAX_CALLER_TASK_LENGTH)
		throw new Error(
			`The subagent task exceeds the ${MAX_CALLER_TASK_LENGTH}-character limit.`,
		);
}

/** Observe an operation while bounding both cancellation and slow dependencies. */
function bounded<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	timeoutMessage: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			const error = new Error(timeoutMessage);
			error.name = "TimeoutError";
			reject(error);
		}, timeoutMs);
		timer.unref?.();
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(abortError(signal?.reason));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		void promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function deadlineTimeout(deadline: number | undefined, fallback: number): number {
	if (deadline === undefined) return fallback;
	return Math.max(1, Math.min(fallback, deadline - now()));
}

function emptyTranscriptResult(): TranscriptResult {
	return { status: "unreadable", messages: [], nextMessageOffset: 0 };
}

async function verifyChildExtensionHealth(
	path: string,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		if (childHealthProtocol.verifyChildExtensionHealth)
			return await bounded(
				childHealthProtocol.verifyChildExtensionHealth(path),
				FILE_OPERATION_TIMEOUT_MS,
				signal,
				"Timed out checking the child extension health marker.",
			);
		const stat = await bounded(
			fs.stat(path),
			FILE_OPERATION_TIMEOUT_MS,
			signal,
			"Timed out checking the child extension health marker.",
			);
		if (!stat.isFile() || stat.size < 0 || stat.size > CHILD_EXTENSION_HEALTH_MAX_BYTES)
			return false;
		const content = await bounded(
			fs.readFile(path),
			FILE_OPERATION_TIMEOUT_MS,
			signal,
			"Timed out reading the child extension health marker.",
			);
		return (
			content.byteLength <= CHILD_EXTENSION_HEALTH_MAX_BYTES &&
			content.toString("utf8") === CHILD_EXTENSION_HEALTH_SIGNAL
		);
	} catch (error) {
		if (isAbortError(error)) throw error;
		return false;
	}
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
	systemPrompt: string;
	promptPath: string;
	sessionDir: string;
	healthPath: string;
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
		PI_SUBAGENT_SYSTEM_PROMPT: values.systemPrompt,
		PI_SUBAGENT_DEPTH: String(values.depth),
		PI_SUBAGENT_PROMPT_PATH: values.promptPath,
		PI_SUBAGENT_SESSION_DIR: values.sessionDir,
		PI_SUBAGENT_HEALTH_PATH: values.healthPath,
		PI_SUBAGENT_LEASE_PATH: values.leasePath,
		PI_SUBAGENT_OWNER_SESSION_FILE: values.ownerSessionFile,
		PI_SUBAGENT_OWNER_SESSION_ID: values.ownerSessionId,
		PI_SUBAGENT_CONTROLLER_INSTANCE_ID: values.controllerInstanceId,
	});
	return env;
}

function addRuntimeDiagnostic(runtime: RuntimeChild, message: string): void {
	runtime.diagnostics.push(message.slice(0, MAX_DIAGNOSTIC_LENGTH));
	if (runtime.diagnostics.length > MAX_DIAGNOSTICS)
		runtime.diagnostics.splice(0, runtime.diagnostics.length - MAX_DIAGNOSTICS);
}

function fenceRuntimeTransport(runtime: RuntimeChild): void {
	if (runtime.overflowFenceTimer) {
		clearTimeout(runtime.overflowFenceTimer);
		runtime.overflowFenceTimer = undefined;
	}
	if (runtime.transport.isClosed) return;
	runtime.forced = true;
	try {
		runtime.transport.forceClose({
			code: null,
			signal: "SIGKILL",
			error: new Error("Reload event queue overflowed; runtime transport was fenced."),
			osCloseObserved: false,
			forced: true,
		});
	} catch (error) {
		addRuntimeDiagnostic(
			runtime,
			`Reload runtime transport fence failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function scheduleOverflowTransportFence(runtime: RuntimeChild): void {
	if (runtime.overflowFenceTimer || runtime.transport.isClosed) return;
	runtime.overflowFenceTimer = setTimeout(() => {
		runtime.overflowFenceTimer = undefined;
		fenceRuntimeTransport(runtime);
	}, OVERFLOW_TRANSPORT_FENCE_TIMEOUT_MS);
	runtime.overflowFenceTimer.unref?.();
}

function maybeFenceRuntimeAfterRecord(
	runtime: RuntimeChild,
	record: RpcRecord,
): void {
	if (runtime.fenced && record.type === "agent_settled")
		fenceRuntimeTransport(runtime);
}

function removeRuntime(runtime: RuntimeChild, clearQueue = true): void {
	if (runtime.overflowFenceTimer) {
		clearTimeout(runtime.overflowFenceTimer);
		runtime.overflowFenceTimer = undefined;
	}
	if (runtime.drainTimer) {
		clearTimeout(runtime.drainTimer);
		runtime.drainTimer = undefined;
	}
	runtime.consumer = undefined;
	runtime.closeConsumer = undefined;
	runtime.handle = undefined;
	runtime.drain = undefined;
	runtime.deliverClose = undefined;
	runtime.draining = false;
	runtime.drainFailures = 0;
	if (clearQueue) runtime.queuedRecords.length = 0;
	if (runtimeChildren.get(runtime.id) === runtime) runtimeChildren.delete(runtime.id);
}

/** Queue one detached runtime record through the shared bounded queue contract. */
export function queueRuntimeRecord(runtime: RuntimeChild, record: RpcRecord): boolean {
	if (runtime.queueState.overflowed) runtime.fenced = true;
	if (runtime.fenced && !isCriticalSubagentEvent(record)) return false;
	const accepted = enqueueSubagentEventQueue(runtime.queuedRecords, record, {
		maxRecords: MAX_SUBAGENT_EVENT_QUEUE_RECORDS,
		state: runtime.queueState,
		diagnostic: (message) => addRuntimeDiagnostic(runtime, message),
		onOverflow: () => {
			runtime.fenced = true;
			scheduleOverflowTransportFence(runtime);
		},
	});
	if (runtime.queueState.overflowed) runtime.fenced = true;
	if (accepted) maybeFenceRuntimeAfterRecord(runtime, record);
	return accepted;
}

/** Route a runtime record without bypassing the terminal overflow fence. */
export function routeRuntimeRecord(runtime: RuntimeChild, record: RpcRecord): boolean {
	if (runtime.queueState.overflowed) runtime.fenced = true;
	if (runtime.fenced && !isCriticalSubagentEvent(record)) return false;
	if (runtime.consumer) {
		try {
			runtime.consumer(record);
		} finally {
			maybeFenceRuntimeAfterRecord(runtime, record);
		}
		return true;
	}
	return queueRuntimeRecord(runtime, record);
}

function scheduleRuntimeDrain(runtime: RuntimeChild, delayMs: number): void {
	if (runtime.drainTimer || !runtime.consumer || !runtime.drain) return;
	const drain = runtime.drain;
	runtime.drainTimer = setTimeout(() => {
		runtime.drainTimer = undefined;
		if (runtime.drain === drain) drain();
	}, Math.max(0, Math.floor(delayMs)));
	runtime.drainTimer.unref?.();
}

/** Deliver a close event after any retained reload records drain. */
export function noteRuntimeClose(runtime: RuntimeChild, close: RpcProcessClose): void {
	if (runtime.overflowFenceTimer) {
		clearTimeout(runtime.overflowFenceTimer);
		runtime.overflowFenceTimer = undefined;
	}
	runtime.closed = close;
	runtime.deliverClose?.();
}

export function attachRuntime(
	runtime: RuntimeChild,
	consumer: (record: RpcRecord) => void,
	closeConsumer: (close: RpcProcessClose) => void,
	onCloseError?: (close: RpcProcessClose) => void,
): void {
	runtime.consumer = consumer;
	runtime.closeConsumer = closeConsumer;
	runtime.drainFailures = 0;
	const deliverClose = () => {
		const close = runtime.closed;
		if (!close || runtime.closeConsumer !== closeConsumer) return;
		if (runtime.draining || runtime.drainTimer) return;
		if (runtime.queuedRecords.length > 0) {
			scheduleRuntimeDrain(runtime, 0);
			return;
		}
		try {
			closeConsumer(close);
		} catch (error) {
			addRuntimeDiagnostic(
				runtime,
				`RPC close handling failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			try {
				onCloseError?.(close);
			} catch (fallbackError) {
				addRuntimeDiagnostic(
					runtime,
					`RPC close fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
				);
			}
		}
	};
	const drain = () => {
		runtime.drainTimer = undefined;
		if (runtime.consumer !== consumer || runtime.closeConsumer !== closeConsumer)
			return;
		if (runtime.draining) return;
		runtime.draining = true;
		const queuedBefore = runtime.queuedRecords.length;
		let delivered = 0;
		try {
			delivered = drainSubagentEventQueue(
				runtime.queuedRecords,
				(record) => {
					try {
						consumer(record);
					} finally {
						maybeFenceRuntimeAfterRecord(runtime, record);
					}
				},
				{
					maxRecords: MAX_SUBAGENT_EVENT_DRAIN_RECORDS,
					diagnostic: (message) => addRuntimeDiagnostic(runtime, message),
				},
			);
		} finally {
			runtime.draining = false;
		}
		if (runtime.consumer !== consumer || runtime.closeConsumer !== closeConsumer)
			return;
		if (runtime.queuedRecords.length > 0) {
			const batchSize = Math.min(
				queuedBefore,
				MAX_SUBAGENT_EVENT_DRAIN_RECORDS,
			);
			if (delivered < batchSize) {
				runtime.drainFailures++;
				if (runtime.drainFailures <= MAX_RELOAD_DRAIN_RETRIES)
					scheduleRuntimeDrain(runtime, RELOAD_DRAIN_RETRY_DELAY_MS);
				else
					addRuntimeDiagnostic(
						runtime,
						`Reload event drain retry limit reached after ${MAX_RELOAD_DRAIN_RETRIES} attempts; retained records remain queued.`,
					);
			} else {
				runtime.drainFailures = 0;
				scheduleRuntimeDrain(runtime, 0);
			}
			return;
		}
		runtime.drainFailures = 0;
		deliverClose();
	};
	runtime.drain = drain;
	runtime.deliverClose = deliverClose;
	if (runtime.queuedRecords.length > 0) scheduleRuntimeDrain(runtime, 0);
	else deliverClose();
}

function detachRuntime(runtime: RuntimeChild): void {
	if (runtime.drainTimer) {
		clearTimeout(runtime.drainTimer);
		runtime.drainTimer = undefined;
	}
	runtime.consumer = undefined;
	runtime.closeConsumer = undefined;
	runtime.drain = undefined;
	runtime.deliverClose = undefined;
	runtime.draining = false;
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
	extensionReady: boolean;
	rpc?: RpcChildTransport;
	runtime?: RuntimeChild;
	createdAt: number;
	rpcReadyAt?: number;
	lastActivityAt: number;
	completedAt?: number;
	outputPath?: string;
	outputStatus: OutputStatus;
	outputError?: string;
	extensionError?: string;
	transcriptStatus: TranscriptStatus;
	outputWriteChain: Promise<void>;
	stderr: string;
	diagnostics: string[];
	waiters: Set<() => void>;
	terminationPromise?: Promise<SubagentHandle>;
	rpcOperationPromise?: Promise<void>;
	processCloseHandled: boolean;
	osCloseObserved?: boolean;
	forced?: boolean;
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
		task: Type.String({ minLength: 1, maxLength: MAX_CALLER_TASK_LENGTH }),
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
			maxLength: MAX_CALLER_TASK_LENGTH,
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
	let persistenceGeneration = 0;
	let persistenceClosed = false;
	let activePersistence: PendingPersistence | undefined;
	let owner: OwnerIdentity | null = null;
	const controllerInstanceId = processControllerInstanceId;
	let leaseHeld = false;
	let leaseRenewTimer: NodeJS.Timeout | undefined;
	let leaseRenewGeneration = 0;
	let leaseRenewPromise: Promise<void> | undefined;
	let authorityLossPromise: Promise<void> | undefined;
	let pendingLaunches = 0;
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
				handle.killRequestedAt === undefined
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
	const activeCount = () => sorted().filter(active).length;
	const requireLease = (): boolean => leaseHeld && owner !== null;
	const childOperationTails = new Map<string, Promise<void>>();
	const childOperationCounts = new Map<string, number>();
	let launchReservationTail = Promise.resolve();
	async function withLaunchReservation<T>(
		signal: AbortSignal | undefined,
		operation: () => Promise<T>,
	): Promise<T> {
		const previous = launchReservationTail;
		let release!: () => void;
		let released = false;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const releaseCurrent = () => {
			if (released) return;
			released = true;
			release();
		};
		launchReservationTail = current;
		let operationPromise: Promise<T> | undefined;
		try {
			await bounded(
				previous,
				CHILD_OPERATION_TIMEOUT_MS,
				signal,
				"Timed out waiting for another subagent launch reservation.",
			);
			throwIfAborted(signal);
			operationPromise = Promise.resolve().then(operation);
			void operationPromise.then(releaseCurrent, releaseCurrent);
			return await operationPromise;
		} catch (error) {
			// Keep a canceled waiter chained to the live predecessor.
			if (!operationPromise) void previous.then(releaseCurrent, releaseCurrent);
			throw error;
		}
	}
	async function withChildOperation<T>(
		handle: SubagentHandle,
		signal: AbortSignal | undefined,
		operation: () => Promise<T>,
	): Promise<T> {
		throwIfAborted(signal);
		const operationCount = childOperationCounts.get(handle.id) || 0;
		if (operationCount >= MAX_QUEUED_CHILD_OPERATIONS)
			throw new Error(
				`The subagent operation queue is full at ${MAX_QUEUED_CHILD_OPERATIONS} operations.`,
			);
		childOperationCounts.set(handle.id, operationCount + 1);
		const previous = childOperationTails.get(handle.id) || Promise.resolve();
		let release!: () => void;
		let released = false;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const releaseCurrent = () => {
			if (released) return;
			released = true;
			release();
			const remaining = childOperationCounts.get(handle.id) || 0;
			if (remaining <= 1) childOperationCounts.delete(handle.id);
			else childOperationCounts.set(handle.id, remaining - 1);
			if (childOperationTails.get(handle.id) === current)
				childOperationTails.delete(handle.id);
		};
		childOperationTails.set(handle.id, current);
		let operationPromise: Promise<T> | undefined;
		try {
			await bounded(
				previous,
				CHILD_OPERATION_TIMEOUT_MS,
				signal,
				`Timed out waiting for another operation on subagent #${handle.id}.`,
			);
			throwIfAborted(signal);
			operationPromise = Promise.resolve().then(operation);
			// Cancellation can return before transport or termination cleanup settles.
			const completion = operationPromise.then(
				() => handle.terminationPromise || handle.rpcOperationPromise,
				() => handle.terminationPromise || handle.rpcOperationPromise,
			);
			void completion.then(releaseCurrent, releaseCurrent);
			return await operationPromise;
		} catch (error) {
			// Keep a canceled waiter chained to the live predecessor.
			if (!operationPromise) void previous.then(releaseCurrent, releaseCurrent);
			throw error;
		}
	}
	const setControllerStatus = (
		ctx: ExtensionContext | null,
		text: string | undefined,
	): void => {
		ctx?.ui?.setStatus("subagent-rpc", text);
	};

	async function ensureLeaseAuthority(
		authorityOwner: OwnerIdentity,
		signal?: AbortSignal,
	): Promise<boolean> {
		const agentDir = getAgentDir();
		try {
			const record = await bounded(
				readLeaseRecord(agentDir, authorityOwner),
				FILE_OPERATION_TIMEOUT_MS,
				signal,
				"Timed out checking subagent controller authority.",
			);
			// Compare the clock after the lease read completes.
			if (
				record?.ownerSessionFile === authorityOwner.ownerSessionFile &&
				record.ownerSessionId === authorityOwner.ownerSessionId &&
				record.controllerInstanceId === controllerInstanceId &&
				now() <= record.expiresAt
			)
				return true;
			return await bounded(
				renewLease(
					agentDir,
					authorityOwner,
					controllerInstanceId,
					now(),
				),
				FILE_OPERATION_TIMEOUT_MS,
				signal,
				"Timed out renewing subagent controller authority.",
			);
		} catch (error) {
			if (isAbortError(error)) throw error;
			return false;
		}
	}

	async function requireCurrentAuthority(signal?: AbortSignal): Promise<boolean> {
		throwIfAborted(signal);
		if (!leaseHeld || !owner) return false;
		const authorityOwner = owner;
		const authoritative = await ensureLeaseAuthority(authorityOwner, signal);
		if (
			!authoritative &&
			owner === authorityOwner &&
			leaseHeld
		)
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
	const registryEntry = (handle: SubagentHandle): PersistedRegistryEntry => ({
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
		killRequestedAt: handle.killRequestedAt,
		stderrTail: tail(handle.stderr),
		osCloseObserved: handle.osCloseObserved,
		forced: handle.forced,
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
	let pendingPersistence: PendingPersistence | undefined;
	let persistenceWorkerActive = false;
	const settlePersistence = (
		request: PendingPersistence,
		result: boolean,
	): void => {
		const waiters = request.waiters.splice(0);
		for (const waiter of waiters) waiter(result);
	};
	const fencePersistence = (close = false): void => {
		persistenceGeneration++;
		if (close) persistenceClosed = true;
		if (pendingPersistence) {
			settlePersistence(pendingPersistence, false);
			pendingPersistence = undefined;
		}
		if (activePersistence) settlePersistence(activePersistence, false);
	};
	const persistFailure = (error: unknown): void => {
		for (const handle of handles.values())
			addDiagnostic(
				handle,
				`Registry persistence failed: ${error instanceof Error ? error.message : String(error)}`,
			);
	};
	const startPersistenceWorker = (): void => {
		if (persistenceWorkerActive || persistenceClosed) return;
		persistenceWorkerActive = true;
		const previous = persistenceChain;
		const run = previous.then(async () => {
			while (pendingPersistence) {
				const request = pendingPersistence;
				pendingPersistence = undefined;
				activePersistence = request;
				let result = false;
				try {
					const authoritative =
						request.generation === persistenceGeneration &&
						!persistenceClosed &&
						owner &&
						owner.ownerSessionFile === request.owner.ownerSessionFile &&
						owner.ownerSessionId === request.owner.ownerSessionId &&
						leaseHeld &&
						(await requireCurrentAuthority());
					if (
						authoritative &&
						request.generation === persistenceGeneration &&
						!persistenceClosed
					) {
						const saveOperation = saveRegistry(request.entries, request.path);
						try {
							await bounded(
								saveOperation,
								PERSISTENCE_TIMEOUT_MS,
								undefined,
								"Timed out saving the subagent registry.",
							);
							result =
								request.generation === persistenceGeneration &&
								!persistenceClosed;
						} finally {
							// Keep the worker fenced until the actual filesystem operation ends.
							await saveOperation.catch(() => {});
						}
					}
				} catch (error) {
					if (
						request.generation === persistenceGeneration &&
						!persistenceClosed
					)
						persistFailure(error);
				}
				if (activePersistence === request) activePersistence = undefined;
				settlePersistence(request, result);
			}
		});
		persistenceChain = run.catch((error) => {
			persistFailure(error);
		});
		void persistenceChain.then(() => {
			persistenceWorkerActive = false;
			if (pendingPersistence) startPersistenceWorker();
		});
	};
	const persist = (
		snapshot?: RegistryEntry[],
		_options: { important?: boolean } = {},
	): Promise<boolean> => {
		const persistenceOwner = owner;
		if (!persistenceOwner || !leaseHeld || persistenceClosed)
			return Promise.resolve(false);
		const path = ownerRegistryPath(getAgentDir(), persistenceOwner);
		const entries = snapshot || registryEntries();
		return new Promise<boolean>((resolve) => {
			if (
				pendingPersistence &&
				(pendingPersistence.owner.ownerSessionFile !== persistenceOwner.ownerSessionFile ||
					pendingPersistence.owner.ownerSessionId !== persistenceOwner.ownerSessionId)
			) {
				settlePersistence(pendingPersistence, false);
				pendingPersistence = undefined;
			}
			if (!pendingPersistence) {
				pendingPersistence = {
					entries,
					owner: persistenceOwner,
					path,
					generation: persistenceGeneration,
					waiters: [resolve],
				};
			} else {
				pendingPersistence.entries = entries;
				pendingPersistence.path = path;
				pendingPersistence.generation = persistenceGeneration;
				pendingPersistence.waiters.push(resolve);
			}
			startPersistenceWorker();
		});
	};
	const trimRetained = () => {
		if (handles.size <= MAX_RETAINED_HANDLES) return;
		const stopped = [...handles.values()]
			.filter(
				(candidate) =>
					candidate.processState === "stopped" &&
					(!candidate.runtime || candidate.runtime.transport.isClosed),
			)
			.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
		while (handles.size > MAX_RETAINED_HANDLES && stopped.length) {
			const candidate = stopped.shift();
			if (candidate) handles.delete(candidate.id);
		}
	};
	let updateScheduled = false;
	let updatePersistenceRequested = false;
	const flushUpdates = (): void => {
		updateScheduled = false;
		const shouldPersist = updatePersistenceRequested;
		updatePersistenceRequested = false;
		refreshUi();
		if (shouldPersist && leaseHeld) void persist();
	};
	const update = (
		handle: SubagentHandle,
		shouldPersist = true,
		important = false,
	): void => {
		handle.lastActivityAt = now();
		trimRetained();
		if (shouldPersist && leaseHeld && !important)
			updatePersistenceRequested = true;
		if (important && leaseHeld) void persist();
		if (!updateScheduled) {
			updateScheduled = true;
			queueMicrotask(flushUpdates);
		}
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
		if (
			!sessionShuttingDown &&
			leaseHeld &&
			handle.killRequestedAt === undefined
		)
			settlementNotifications.queue(notification);

		handle.outputStatus = handle.outputPath ? "pending" : "not_requested";
		handle.outputError = undefined;
		if (!handle.outputPath) return;

		const outputPath = handle.outputPath;
		const outputContent = result;
		const write = handle.outputWriteChain.then(async () => {
			const written = await bounded(
				writeCallerOutput({
					path: outputPath,
					content: outputContent,
				}),
				OUTPUT_WRITE_TIMEOUT_MS,
				undefined,
				`Timed out writing caller output for subagent #${handle.id}.`,
			);
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
		signal?: AbortSignal,
	) {
		let transcript: Awaited<ReturnType<typeof readTranscript>>;
		try {
			transcript = await bounded(
				readTranscript(handle.sessionPath, transcriptOptions),
				TRANSCRIPT_TIMEOUT_MS,
				signal,
				`Timed out reading the transcript for subagent #${handle.id}.`,
			);
		} catch (error) {
			if (isAbortError(error)) throw error;
			addDiagnostic(
				handle,
				`Transcript read failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			transcript = emptyTranscriptResult();
		}
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
			killRequestedAt: handle.killRequestedAt,
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
			extensionError: handle.extensionError,
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
			osCloseObserved: handle.osCloseObserved,
			forced: handle.forced,
			diagnostics: handle.diagnostics.length
				? [...handle.diagnostics]
				: undefined,
		};
	}
	async function summary(
		handle: SubagentHandle,
		serial?: Awaited<ReturnType<typeof serialize>>,
	) {
		const details = serial || (await serialize(handle));
		return sanitizeTerminalText(
			`#${handle.id}${handle.name ? ` ${handle.name}` : ""} ${handle.processState}/${handle.runState} · run:${handle.runSequence || 0}\n  actual ${formatModel(details.actualModel)} · thinking:${details.actualThinking}\n  process ${handle.pid ?? "?"}${handle.exitCode !== undefined ? ` · exit ${handle.exitCode}` : ""}${handle.rpcReady ? " · RPC ready" : ""}\n  session ${details.sessionPath} (transcript ${details.transcript.status})${details.error ? `\n  error ${truncate(details.error, 180)}` : ""}`,
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
		const persistedKillRequestedAt = nonnegativeSafeInteger(
			(entry as Partial<RegistryEntry> & { killRequestedAt?: unknown })
				.killRequestedAt,
		);
		const killRequestedAt =
			persistedKillRequestedAt ??
			(stopped && entry.error === "Killed" ? entry.lastActivityAt : undefined);
		const killed = stopped && killRequestedAt !== undefined;
		const restoredState = stopped
			? killed
				? "killed"
				: runOutcome === "failed" || entry.error
					? "error"
					: "done"
			: "starting";
		const handle = {
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
			killRequestedAt,
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
			extensionError: undefined,
			transcriptStatus: "missing",
			outputWriteChain: Promise.resolve(),
			stderr: typeof entry.stderrTail === "string" ? tail(entry.stderrTail) || "" : "",
			osCloseObserved: entry.osCloseObserved,
			forced: entry.forced,
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
			extensionReady: false,
			ownerSessionFile: entry.ownerSessionFile,
			ownerSessionId: entry.ownerSessionId,
			incarnation: entry.incarnation,
			resumedFrom: entry.resumedFrom,
		} as SubagentHandle;
		syncLifecycleCompatibility(handle);
		return handle;
	}

	function resetHandleForRun(handle: SubagentHandle): void {
		handle.agentStartedAt = undefined;
		handle.agentEndedAt = undefined;
		handle.completedAt = undefined;
		handle.stopReason = undefined;
		handle.error = undefined;
		handle.killRequestedAt = undefined;
		handle.extensionError = undefined;
		handle.osCloseObserved = undefined;
		handle.forced = undefined;
		handle.abortRequestedAt = undefined;
		handle.tentativeError = undefined;
		handle.finalError = undefined;
		handle.currentTool = undefined;
		handle.currentToolStartedAt = undefined;
		handle.lastTool = undefined;
		handle.isStreaming = false;
		handle.resultText = "";
		handle.currentAssistantText = "";
		handle.latestAssistantText = "";
		handle.activeTools.clear();
		handle.recentTools = [];
		handle.knownToolCallIds = [];
		handle.assistantMessageGeneration = 0;
		handle.finalizedAssistantIdentities = [];
		handle.finalizedAssistantMessageGeneration = undefined;
		handle.finalizedAssistantMessageKey = undefined;
		handle.finalizedAssistantFallbackKey = undefined;
		handle.finalizedAssistantResponseId = undefined;
		handle.finalizedAssistantTimestamp = undefined;
		handle.assistantTextTruncated = false;
		handle.usage = createUsage();
		handle.outputStatus = handle.outputPath ? "pending" : "not_requested";
		handle.outputError = undefined;
		deactivateAssistantMessage(handle);
		handle.assistantAssembly = undefined;
	}

	function dispatchOptions(handle: SubagentHandle) {
		return {
			now,
			assistantDisplayMax: ASSISTANT_DISPLAY_MAX,
			toolOutputTailMax: TOOL_OUTPUT_TAIL_MAX,
			maxRecentTools: MAX_RECENT_TOOLS,
			update: (streaming?: boolean) => update(handle, streaming !== true),
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
				update(handle, false);
				void persist(undefined, { important: true });
			},
		};
	}

	function handleProcessClose(
		handle: SubagentHandle,
		close: RpcProcessClose,
		runtime?: RuntimeChild,
	): void {
		if (runtime && !runtimeMatches(handle, runtime)) return;
		if (handle.processCloseHandled) {
			if (
				runtime &&
				runtimeChildren.get(runtime.id) === runtime &&
				runtime.queuedRecords.length === 0 &&
				!runtime.draining
			)
				removeRuntime(runtime);
			return;
		}
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
		const closeEvidence = close as RpcProcessClose & {
			osCloseObserved?: boolean;
			forced?: boolean;
		};
		handle.osCloseObserved =
			closeEvidence.osCloseObserved ?? !(runtime?.forced ?? false);
		handle.forced = closeEvidence.forced ?? runtime?.forced ?? false;
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
		update(handle, false);
		void persist(undefined, { important: true });
		if (runtime && runtimeChildren.get(runtime.id) === runtime) {
			removeRuntime(runtime);
			handle.runtime = undefined;
			handle.rpc = undefined;
		}
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
		if (record.type === "extension_error") {
			const extensionPath =
				typeof record.extensionPath === "string" && record.extensionPath
					? record.extensionPath
					: "extension";
			const error =
				typeof record.error === "string" && record.error
					? record.error
					: "Unknown extension error";
			handle.extensionError = `${extensionPath}: ${error}`;
		}
		if (record.type === "agent_start") {
			if (handle.runState !== "running" && handle.killRequestedAt === undefined)
				resetHandleForRun(handle);
			handle.assistantAssembly = undefined;
		}
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
			(close) => handleProcessClose(handle, close, runtime),
		);
	}

	function startRuntime(
		handle: SubagentHandle,
		invocation: string[],
		env: NodeJS.ProcessEnv,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		const existing = runtimeChildren.get(handle.id);
		if (existing && !existing.transport.isClosed)
			throw new Error(`Subagent #${handle.id} already has a live RPC runtime.`);
		if (existing) removeRuntime(existing);
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
			queueState: { overflowed: false },
			diagnostics: [],
			fenced: false,
			draining: false,
			drainFailures: 0,
		} as RuntimeChild;
		const transport = new RpcChildTransport(child, {
			onRecord: (record) => {
				routeRuntimeRecord(runtime, record);
			},
			onDiagnostic: (message) => {
				if (runtime.handle && runtimeMatches(runtime.handle, runtime))
					addDiagnostic(runtime.handle, message);
				else if (!runtime.handle) addRuntimeDiagnostic(runtime, message);
			},
			onClose: (close) => {
				try {
					noteRuntimeClose(runtime, close);
				} catch (error) {
					addRuntimeDiagnostic(
						runtime,
						`RPC close handling failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					if (runtime.handle && runtimeMatches(runtime.handle, runtime))
						handleProcessClose(runtime.handle, close, runtime);
				}
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
				cleanup();
				reject(new Error(`Timed out waiting for RPC child #${handle.id} to spawn.`));
			}, STARTUP_TIMEOUT_MS);
			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(abortError(signal?.reason));
			};
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				child.off("spawn", onSpawn);
				child.off("error", onError);
			};
			timer.unref?.();
			signal?.addEventListener("abort", onAbort, { once: true });
			const onSpawn = () => {
				if (settled) return;
				settled = true;
				cleanup();
				handle.pid = child.pid;
				handle.rpcReady = true;
				handle.rpcReadyAt = now();
				notifyWaiters(handle);
				resolve();
			};
			const onError = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
			if (child.pid !== undefined) onSpawn();
			if (signal?.aborted) onAbort();
		});
	}

	function awaitReady(
		handle: SubagentHandle,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		if (handle.rpcReady && handle.rpc) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				handle.waiters.delete(check);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(() => {
				finish(new Error(`Timed out waiting for RPC child #${handle.id} to become ready.`));
			}, STARTUP_TIMEOUT_MS);
			timer.unref?.();
			const onAbort = () => finish(abortError(signal?.reason));
			const check = () => {
				if (handle.rpcReady && handle.rpc) finish();
				else if (handle.processState === "stopped")
					finish(new Error(`RPC child #${handle.id} closed before it became ready.`));
			};
			handle.waiters.add(check);
			signal?.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}

	async function awaitExtensionHealth(
		handle: SubagentHandle,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		if (handle.extensionReady) return;
		const path = childExtensionHealthPath(handle.sessionDir, handle.incarnation);
		const deadline = now() + STARTUP_TIMEOUT_MS;
		for (;;) {
			throwIfAborted(signal);
			if (handle.extensionError)
				throw new Error(
					`Child extension health confirmation failed: ${handle.extensionError}`,
				);
			if (await verifyChildExtensionHealth(path, signal)) {
				handle.extensionReady = true;
				return;
			}
			if (handle.processState === "stopped")
				throw new Error(
					`RPC child #${handle.id} closed before child extension health confirmation.`,
				);
			const remaining = deadline - now();
			if (remaining <= 0)
				throw new Error(
					`Timed out waiting for child extension #${handle.id} health confirmation.`,
				);
			await bounded(
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.min(25, remaining));
					timer.unref?.();
				}),
				Math.min(25, remaining),
				signal,
				`Timed out waiting for child extension #${handle.id} health confirmation.`,
			);
		}
	}

	type RpcSendWithSignal = (
		body: RpcRecord,
		timeoutMs?: number,
		signal?: AbortSignal,
	) => Promise<RpcResponseRecord>;

	async function sendRpc(
		handle: SubagentHandle,
		body: RpcRecord,
		timeoutMs = REQUEST_TIMEOUT_MS,
		signal?: AbortSignal,
	): Promise<RpcResponseRecord> {
		throwIfAborted(signal);
		if (!(await requireCurrentAuthority(signal)))
			throw new Error(await leaseConflictMessage(signal));
		if (handle.processState !== "alive")
			throw new Error(`Subagent #${handle.id} is no longer running.`);
		if (!handle.rpc || !handle.rpcReady)
			throw new Error(`Subagent #${handle.id} RPC process is not ready.`);
		// The runtime branch accepts the third signal argument. Keep this cast for
		// compatibility with the older local transport until both branches merge.
		const send = handle.rpc.send as unknown as RpcSendWithSignal;
		const transportOperation = send.call(handle.rpc, body, timeoutMs, signal);
		handle.rpcOperationPromise = transportOperation.then(
			() => undefined,
			() => undefined,
		);
		const response = await bounded(
			transportOperation,
			timeoutMs,
			signal,
			`Timed out waiting for RPC response to ${String(body.type)}.`,
		);
		throwIfAborted(signal);
		applyResponseState(handle, response);
		update(handle);
		return response;
	}

	async function terminate(
		handle: SubagentHandle,
		checkAuthority = true,
		signal?: AbortSignal,
		deadline?: number,
	): Promise<SubagentHandle> {
		throwIfAborted(signal);
		if (checkAuthority && !(await requireCurrentAuthority(signal)))
			throw new Error(await leaseConflictMessage(signal));
		if (handle.processState === "stopped") return handle;
		if (handle.terminationPromise)
			return bounded(
				handle.terminationPromise,
				deadlineTimeout(deadline, SHUTDOWN_TIMEOUT_MS),
				signal,
				`Timed out terminating subagent #${handle.id}.`,
			);
		const termination = (async () => {
			settlementNotifications.suppressChild(handle.id);
			requestKill(handle, now());
			update(handle, false);
			const transport = handle.rpc;
			if (transport) {
				try {
					await bounded(
						transport.terminate({
							abort: true,
							abortTimeoutMs: ABORT_TIMEOUT_MS,
							closeAfterAbortMs: 250,
							termTimeoutMs: 1_500,
							killTimeoutMs: 2_500,
						}),
						deadlineTimeout(deadline, SHUTDOWN_TIMEOUT_MS),
						undefined,
						`Timed out terminating subagent #${handle.id}.`,
					);
				} catch (error) {
					addDiagnostic(handle, `RPC termination failed: ${String(error)}`);
				}
				if (handle.processState !== "stopped" && !transport.isClosed) {
					if (handle.runtime) handle.runtime.forced = true;
					transport.forceClose({
						code: null,
						signal: "SIGKILL",
						error: new Error("RPC child termination was forced."),
					});
				}
			} else {
				handleProcessClose(handle, {
					code: null,
					signal: "SIGKILL",
					error: new Error("RPC child did not expose a process."),
				});
			}
			handle.completedAt ||= now();
			const persisted = await bounded(
				persist(undefined, { important: true }),
				deadlineTimeout(deadline, PERSISTENCE_TIMEOUT_MS),
				undefined,
				`Timed out saving the stopped state for #${handle.id}.`,
			);
			if (!persisted)
				addDiagnostic(handle, "The stopped subagent state was not persisted.");
			return handle;
		})().catch((error) => {
			addDiagnostic(handle, `RPC termination cleanup failed: ${String(error)}`);
			return handle;
		});
		handle.terminationPromise = termination;
		return bounded(
			termination,
			deadlineTimeout(deadline, SHUTDOWN_TIMEOUT_MS),
			signal,
			`Timed out terminating subagent #${handle.id}.`,
		);
	}

	async function forceCleanupRuntime(
		runtime: RuntimeChild,
		deadline?: number,
	): Promise<void> {
		if (!runtime.transport.isClosed) {
			await bounded(
				runtime.transport.terminate({
					abort: false,
					termTimeoutMs: 500,
					killTimeoutMs: 1_000,
				}),
				deadlineTimeout(deadline, SHUTDOWN_TIMEOUT_MS),
				undefined,
				`Timed out closing RPC runtime for #${runtime.id}.`,
			).catch((error) => addRuntimeDiagnostic(runtime, String(error)));
		}
		if (!runtime.transport.isClosed) {
			runtime.forced = true;
			runtime.transport.forceClose({
				code: null,
				signal: "SIGKILL",
				error: new Error("RPC runtime cleanup was forced."),
			});
		}
		if (runtimeChildren.get(runtime.id) === runtime) removeRuntime(runtime);
	}

	async function forceCleanupRuntimes(deadline?: number): Promise<void> {
		await Promise.all(
			[...runtimeChildren.values()].map((runtime) =>
				forceCleanupRuntime(runtime, deadline),
			),
		);
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
			children.map((handle) =>
				withChildOperation(handle, undefined, () => terminate(handle, false)),
			),
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
		signal?: AbortSignal,
	): Promise<"prompt" | "steer" | "follow_up"> {
		throwIfAborted(signal);
		const command = handle.runState === "idle" ? "prompt" : requestedCommand;
		const before = handle.runSequence;
		await sendRpc(handle, { type: command, message }, REQUEST_TIMEOUT_MS, signal);
		if (command === "prompt")
			await waitUntil(
				() => handle.runSequence > before || handle.processState === "stopped",
				1_000,
				signal,
			);
		return command;
	}

	async function interrupt(
		handle: SubagentHandle,
		signal?: AbortSignal,
	): Promise<boolean> {
		throwIfAborted(signal);
		if (handle.processState !== "alive")
			throw new Error(`Subagent #${handle.id} is no longer running.`);
		if (!(await requireCurrentAuthority(signal)))
			throw new Error(await leaseConflictMessage(signal));
		if (handle.runState === "idle") return true;
		handle.abortRequestedAt = now();
		try {
			await sendRpc(handle, { type: "abort" }, ABORT_TIMEOUT_MS, signal);
			return true;
		} catch (error) {
			// Keep the abort fence until native agent_settled arrives. Production Pi
			// can send the abort response after that settlement edge.
			if (isAbortError(error)) throw error;
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
		signal?: AbortSignal,
	): Promise<SubagentHandle> {
		assertCallerTask(spec.task);
		if (activeCount() + pendingLaunches >= MAX_ACTIVE_CHILDREN)
			throw new Error(`The active subagent limit of ${MAX_ACTIVE_CHILDREN} has been reached.`);
		pendingLaunches++;
		try {
			return await launchReserved(
				spec,
				cwd,
				requestedModel,
				requestedThinking,
				outputPath,
				signal,
			);
		} finally {
			pendingLaunches--;
		}
	}

	async function launchReserved(
		spec: TaskSpec,
		cwd: string,
		requestedModel: string,
		requestedThinking: ThinkingLevel,
		outputPath?: string,
		signal?: AbortSignal,
	): Promise<SubagentHandle> {
		throwIfAborted(signal);
		if (!(await requireCurrentAuthority(signal)))
			throw new Error(await leaseConflictMessage());
		const resolvedOwner = owner;
		if (!resolvedOwner)
			throw new Error("Controller owner identity is not established.");
		const stat = await bounded(
			fs.stat(cwd),
			FILE_OPERATION_TIMEOUT_MS,
			signal,
			`Timed out checking the subagent cwd: ${cwd}`,
		).catch((error) => {
			if (isAbortError(error)) throw error;
			return undefined;
		});
		if (!stat?.isDirectory())
			throw new Error(`Subagent cwd does not exist or is not a directory: ${cwd}`);
		const id = createId();
		const incarnation = createId();
		const sessionDir = join(getAgentDir(), "sessions", "subagents", id);
		await bounded(
			fs.mkdir(sessionDir, { recursive: true, mode: 0o700 }),
			FILE_OPERATION_TIMEOUT_MS,
			signal,
			`Timed out creating the subagent session directory for #${id}.`,
		);
		await bounded(
			fs.chmod(sessionDir, 0o700),
			FILE_OPERATION_TIMEOUT_MS,
			signal,
			`Timed out securing the subagent session directory for #${id}.`,
		).catch((error) => {
			if (isAbortError(error)) throw error;
		});
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
		return await withChildOperation(handle, signal, async () => {
		try {
			const initiallyPersisted = await bounded(
				persist(undefined, { important: true }),
				PERSISTENCE_TIMEOUT_MS,
				signal,
				`Timed out saving the initial registry entry for #${id}.`,
			);
			if (!initiallyPersisted)
				throw new Error(`Could not persist the initial state for subagent #${id}.`);
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
					systemPrompt: spec.systemPrompt || "",
					promptPath: handle.promptPath,
					sessionDir,
					healthPath: childExtensionHealthPath(sessionDir, incarnation),
					leasePath: leasePath(getAgentDir(), resolvedOwner),
					ownerSessionFile: resolvedOwner.ownerSessionFile,
					ownerSessionId: resolvedOwner.ownerSessionId,
					controllerInstanceId,
				}),
				signal,
			);
			await awaitReady(handle, signal);
			await sendRpc(handle, { type: "get_state" }, STARTUP_TIMEOUT_MS, signal);
			await awaitExtensionHealth(handle, signal);
			const before = handle.runSequence;
			await sendRpc(handle, { type: "prompt", message: spec.task }, REQUEST_TIMEOUT_MS, signal);
			await waitUntil(
				() => handle.runSequence > before || handle.processState === "stopped",
				1_000,
				signal,
			);
			throwIfAborted(signal);
			return handle;
		} catch (error) {
			addDiagnostic(
				handle,
				`Child startup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			await terminate(handle, false).catch(() => {});
			handles.delete(id);
			await bounded(
				persist(undefined, { important: true }),
				PERSISTENCE_TIMEOUT_MS,
				undefined,
				`Timed out removing failed subagent #${id} from the registry.`,
			).catch((persistError) =>
				console.error(`Failed to remove failed subagent #${id}: ${String(persistError)}`),
			);
			throw error;
		}
		});
	}

	async function resumeChild(
		handle: SubagentHandle,
		task?: string,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		if (task !== undefined) assertCallerTask(task);
		if (!(await requireCurrentAuthority(signal)))
			throw new Error(await leaseConflictMessage(signal));
		const resolvedOwner = owner;
		if (!resolvedOwner)
			throw new Error("Controller owner identity is not established.");
		const sessionFile = handle.sessionPath;
		if (!sessionFile)
			throw new Error(`No usable child session file exists for #${handle.id}; resume is not possible.`);
		const usable = await bounded(
			fs.stat(sessionFile),
			FILE_OPERATION_TIMEOUT_MS,
			signal,
			`Timed out checking the child session file for #${handle.id}.`,
		)
			.then((s) => s.isFile() && s.size > 0)
			.catch((error) => {
				if (isAbortError(error)) throw error;
				return false;
			});
		if (!usable)
			throw new Error(`No usable child session file exists for #${handle.id}; resume is not possible.`);
		// Complete older output publication before persisting the new incarnation.
		await bounded(
			handle.outputWriteChain,
			OUTPUT_WRITE_TIMEOUT_MS,
			signal,
			`Timed out waiting for prior caller output for #${handle.id}.`,
		);
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
						killRequestedAt: undefined,
						outputStatus: entry.outputPath
							? ("pending" as const)
							: ("not_requested" as const),
						outputError: undefined,
						incarnation,
						resumedFrom: oldIncarnation,
					}
				: entry,
		);
		if (
			!(await bounded(
				persist(nextRegistry, { important: true }),
				PERSISTENCE_TIMEOUT_MS,
				signal,
				`Timed out saving the resumed state for #${handle.id}.`,
			))
		)
			throw new Error(`Could not persist the resumed state for #${handle.id}.`);
		handle.runSequence = runIdBase;
		handle.incarnation = incarnation;
		handle.resumedFrom = oldIncarnation;
		reviveForResume(handle);
		resetHandleForRun(handle);
		handle.terminationPromise = undefined;
		handle.rpcReady = false;
		handle.extensionReady = false;
		handle.rpcReadyAt = undefined;
		handle.rpc = undefined;
		handle.runtime = undefined;
		handle.rpcOperationPromise = undefined;
		handle.processCloseHandled = false;
		handle.exitCode = undefined;
		handle.exitSignal = undefined;
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
					systemPrompt: "",
					promptPath: handle.promptPath,
					sessionDir: handle.sessionDir,
					healthPath: childExtensionHealthPath(handle.sessionDir, incarnation),
					leasePath: leasePath(getAgentDir(), resolvedOwner),
					ownerSessionFile: resolvedOwner.ownerSessionFile,
					ownerSessionId: resolvedOwner.ownerSessionId,
					controllerInstanceId,
				}),
				signal,
			);
			await awaitReady(handle, signal);
			await sendRpc(handle, { type: "get_state" }, STARTUP_TIMEOUT_MS, signal);
			await awaitExtensionHealth(handle, signal);
			if (task) {
				const before = handle.runSequence;
				await sendRpc(handle, { type: "prompt", message: task }, REQUEST_TIMEOUT_MS, signal);
				await waitUntil(
					() => handle.runSequence > before || handle.processState === "stopped",
					1_000,
					signal,
				);
			}
			throwIfAborted(signal);
		} catch (error) {
			addDiagnostic(
				handle,
				`Child resume failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			await terminate(handle, false).catch(() => {});
			throw error;
		}
	}

	function waitUntil(
		predicate: () => boolean,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		return new Promise((resolve, reject) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let deadlineTimer: NodeJS.Timeout | undefined;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (timer) clearInterval(timer);
				if (deadlineTimer) clearTimeout(deadlineTimer);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve();
			};
			const onAbort = () => finish(abortError(signal?.reason));
			if (predicate()) return finish();
			deadlineTimer = setTimeout(() => finish(), timeoutMs);
			deadlineTimer.unref?.();
			timer = setInterval(() => {
				if (predicate()) finish();
			}, 20);
			timer.unref?.();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
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
		const loaded = await bounded(
			loadRegistry(path),
			FILE_OPERATION_TIMEOUT_MS,
			undefined,
			"Timed out loading the subagent registry.",
		);
		const saved = registryEntriesForOwner(loaded, owner);
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
		}
		await bounded(
			persist(undefined, { important: true }),
			PERSISTENCE_TIMEOUT_MS,
			undefined,
			"Timed out saving the reconciled subagent registry.",
		).catch((error) =>
			console.error(`Subagent registry reconcile persistence failed: ${String(error)}`),
		);
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
		try {
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
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			for (const handle of handles.values())
				addDiagnostic(handle, `Subagent UI refresh failed: ${message}`);
		}
	}

	function stopTimers() {
		leaseRenewGeneration++;
		if (leaseRenewTimer) {
			clearInterval(leaseRenewTimer);
			leaseRenewTimer = undefined;
		}
	}

	function startLeaseRenewal() {
		stopTimers();
		const generation = leaseRenewGeneration;
		leaseRenewTimer = setInterval(() => {
			const authorityOwner = owner;
			if (
				!authorityOwner ||
				!leaseHeld ||
				generation !== leaseRenewGeneration ||
				leaseRenewPromise
			)
				return;
			const renewal = (async () => {
				const ok = await bounded(
					renewLease(getAgentDir(), authorityOwner, controllerInstanceId, now()),
					FILE_OPERATION_TIMEOUT_MS,
					undefined,
					"Timed out renewing the subagent controller lease.",
				);
				if (
					generation !== leaseRenewGeneration ||
					owner !== authorityOwner ||
					!leaseHeld
				)
					return;
				if (!ok)
					void loseAuthority(
						"Controller lease lost during renewal. Run /reload to re-establish it.",
					);
			})().catch((error) => {
				if (
					generation === leaseRenewGeneration &&
					owner === authorityOwner &&
					leaseHeld
				)
					void loseAuthority(`Controller lease renewal failed: ${String(error)}`);
			});
			leaseRenewPromise = renewal;
			void renewal.then(() => {
				if (leaseRenewPromise === renewal) leaseRenewPromise = undefined;
			});
		}, LEASE_RENEW_INTERVAL_MS);
		leaseRenewTimer.unref();
	}

	async function establishController(ctx: ExtensionContext): Promise<void> {
		const sessionFile = ctx.sessionManager?.getSessionFile();
		const sessionId = ctx.sessionManager?.getSessionId();
		const ephemeralSessionId =
			typeof sessionId === "string" && sessionId
				? sessionId
				: `ephemeral-${processControllerInstanceId}`;
		let ownerSessionFile: string;
		try {
			ownerSessionFile = sessionFile
				? await bounded(
						canonicalOwnerSessionFile(sessionFile),
						FILE_OPERATION_TIMEOUT_MS,
						undefined,
						"Timed out resolving the parent session identity.",
					)
				: `memory:${ephemeralSessionId}`;
		} catch (error) {
			owner = null;
			leaseHeld = false;
			stopTimers();
			setControllerStatus(ctx, undefined);
			console.error(`Subagent controller identity failed: ${String(error)}`);
			return;
		}
		const resolved: OwnerIdentity = {
			ownerSessionFile,
			ownerSessionId: ephemeralSessionId,
		};
		let result;
		try {
			result = await bounded(
				acquireLease(
					getAgentDir(),
					resolved,
					controllerInstanceId,
					now(),
				),
				FILE_OPERATION_TIMEOUT_MS,
				undefined,
				"Timed out acquiring the subagent controller lease.",
			);
		} catch (error) {
			owner = null;
			leaseHeld = false;
			stopTimers();
			setControllerStatus(ctx, undefined);
			console.error(`Subagent controller lease acquisition failed: ${String(error)}`);
			return;
		}
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

	async function leaseConflictMessage(signal?: AbortSignal): Promise<string> {
		throwIfAborted(signal);
		const base = "Subagent controller lease is not held.";
		if (!owner)
			return `${base} This Pi session uses an in-memory controller identity. Run /reload to re-establish it.`;
		const currentOwner = owner;
		const path = leasePath(getAgentDir(), currentOwner);
		let existing;
		try {
			existing = await bounded(
				readLeaseRecord(getAgentDir(), currentOwner),
				FILE_OPERATION_TIMEOUT_MS,
				signal,
				"Timed out reading the subagent controller lease.",
			);
		} catch (error) {
			if (isAbortError(error)) throw error;
			return `${base} The lease record at ${path} could not be read. Run /reload to re-establish it.`;
		}
		if (!existing)
			return `${base} No lease record exists at ${path}. Run /reload to re-establish this controller.`;
		if (existing.controllerInstanceId === controllerInstanceId)
			return `${base} The record at ${path} still belongs to this process (pid ${existing.pid}), but this controller stopped holding it. Run /reload to reclaim it.`;
		return isProcessAlive(existing.pid)
			? `${base} Another live Pi process (pid ${existing.pid}) owns session ${existing.ownerSessionId} and holds ${path}. Quit that process, then run /reload here.`
			: `${base} The record at ${path} names pid ${existing.pid}, which is no longer running. Run /reload to take it over.`;
	}

	async function releaseLeaseIfHeld(): Promise<void> {
		if (!owner || !leaseHeld) return;
		const currentOwner = owner;
		await bounded(
			releaseLease(getAgentDir(), currentOwner, controllerInstanceId),
			FILE_OPERATION_TIMEOUT_MS,
			undefined,
			"Timed out releasing the subagent controller lease.",
		).catch((error) =>
			console.error(`Subagent controller lease release failed: ${String(error)}`),
		);
	}

	async function waitForOutputWrites(deadline?: number): Promise<boolean> {
		let complete = true;
		await Promise.all(
			[...handles.values()].map(async (handle) => {
				try {
					await bounded(
						handle.outputWriteChain,
						deadlineTimeout(deadline, OUTPUT_WRITE_TIMEOUT_MS),
						undefined,
						`Timed out waiting for caller output for #${handle.id}.`,
					);
				} catch (error) {
					complete = false;
					addDiagnostic(handle, `Caller output cleanup failed: ${String(error)}`);
				}
			}),
		);
		return complete;
	}

	async function waitForPersistence(deadline?: number): Promise<boolean> {
		try {
			await bounded(
				persistenceChain,
				deadlineTimeout(deadline, PERSISTENCE_TIMEOUT_MS),
				undefined,
				"Timed out waiting for subagent registry persistence.",
			);
			return true;
		} catch (error) {
			// Fence late completions instead of resetting the active chain underneath them.
			fencePersistence(true);
			for (const handle of handles.values())
				addDiagnostic(handle, `Registry cleanup was forced: ${String(error)}`);
			return false;
		}
	}

	async function stopAllChildren(
		deadline = now() + SHUTDOWN_TIMEOUT_MS,
	): Promise<void> {
		const termination = Promise.allSettled(
			sorted()
				.filter(active)
				.map((handle) =>
					withChildOperation(handle, undefined, () =>
						terminate(handle, false, undefined, deadline),
					),
				),
		);
		try {
			await bounded(
				termination,
				deadlineTimeout(deadline, SHUTDOWN_TIMEOUT_MS),
				undefined,
				"Timed out stopping subagent children.",
			);
		} catch (error) {
			const live = sorted().filter(active);
			await Promise.all(
				live.map(async (handle) => {
					addDiagnostic(handle, `Forced child cleanup: ${String(error)}`);
					if (handle.runtime)
						await forceCleanupRuntime(handle.runtime, deadline);
				}),
			);
		}
		await waitForOutputWrites(deadline);
		await waitForPersistence(deadline);
		await forceCleanupRuntimes(deadline);
	}

	pi.on("session_start", async (_event, ctx) => {
		// A reload starts a new persistence generation after any fenced old work.
		persistenceGeneration++;
		persistenceClosed = false;
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
		const deadline = now() + SHUTDOWN_TIMEOUT_MS;
		const reason = event?.reason || "quit";
		if (reason === "reload") {
			stopTimers();
			for (const handle of handles.values()) {
				if (!handle.runtime) continue;
				handle.runtime.handle = handle;
				detachRuntime(handle.runtime);
			}
			await waitForOutputWrites(deadline);
			await waitForPersistence(deadline);
			fencePersistence(true);
			if (ctx.mode === "tui") ctx.ui.setWidget("subagent", undefined);
			latestCtx = null;
			return;
		}
		await stopAllChildren(deadline);
		const persisted = await bounded(
			persist(undefined, { important: true }),
			deadlineTimeout(deadline, PERSISTENCE_TIMEOUT_MS),
			undefined,
			"Timed out saving the final subagent registry.",
		);
		if (!persisted)
			console.error("Final subagent registry persistence did not complete.");
		await waitForPersistence(deadline);
		fencePersistence(true);
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
		async execute(_id, params, signal, _update, ctx) {
			throwIfAborted(signal);
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
			let startedHandle: SubagentHandle | undefined;
			try {
				const callerCwd = ctx.cwd;
				const childCwd = spec.cwd ? resolve(callerCwd, spec.cwd) : callerCwd;
				const outputPath = spec.outputPath
					? resolve(callerCwd, spec.outputPath)
					: undefined;
				const handle = await withLaunchReservation(signal, () =>
					launch(
						spec,
						childCwd,
						choice.model,
						choice.thinking,
						outputPath,
						signal,
					),
				);
				startedHandle = handle;
				return {
					content: [
						{
							type: "text" as const,
							text: `Started persistent subagent #${handle.id} as a Pi RPC child process.`,
						},
					],
					details: { handle: await serialize(handle, {}, signal) },
				};
			} catch (error) {
				if (isAbortError(error)) {
					if (startedHandle)
						await terminate(startedHandle, false).catch(() => {});
					throw error;
				}
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
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const chosen = sorted().filter(
				(handle) => (params.includeFinished ?? true) || active(handle),
			);
			const details = await Promise.all(
				chosen.map(async (handle) => {
					const serial = await serialize(handle, {}, signal);
					return { serial, text: await summary(handle, serial) };
				}),
			);
			return {
				content: [
					{
						type: "text" as const,
						text: details.length
							? details.map(({ text }) => text).join("\n\n")
							: "No subagents tracked yet.",
					},
				],
				details: { handles: details.map(({ serial }) => serial) },
			};
		},
	});
	pi.registerTool<typeof StatusSchema, unknown>({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Return bounded process/run diagnostics, settlement evidence, transcript text, and caller output status. Use this tool for diagnosis only. Do not infer completion from polling, silence, transcript text, or output files.",
		parameters: StatusSchema,
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			const serial = await serialize(
				handle,
				{
					messageOffset: params.messageOffset,
					numMessages: params.numMessages,
				},
				signal,
			);
			return {
				content: [{ type: "text" as const, text: await summary(handle, serial) }],
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
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			try {
				const command = await withChildOperation(handle, signal, () =>
					deliverMessage(
						handle,
						"steer",
						params.message.trim(),
						signal,
					),
				);
				return {
					content: [{ type: "text" as const, text: `Steering accepted by #${handle.id}.` }],
					details: {
						handle: await serialize(handle, {}, signal),
						accepted: true,
						queued: command !== "prompt",
						command,
					},
				};
			} catch (error) {
				if (isAbortError(error)) throw error;
				return { content: [{ type: "text" as const, text: String(error) }], details: { accepted: false } };
			}
		},
	});
	pi.registerTool<typeof MessageSchema, unknown>({
		name: "subagent_follow_up",
		label: "Subagent Follow Up",
		description: "Accept or queue another user turn for a live persistent child. The response does not mean completion.",
		parameters: MessageSchema,
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			try {
				const command = await withChildOperation(handle, signal, () =>
					deliverMessage(
						handle,
						"follow_up",
						params.message.trim(),
						signal,
					),
				);
				return {
					content: [{ type: "text" as const, text: `Follow-up accepted by #${handle.id}.` }],
					details: {
						handle: await serialize(handle, {}, signal),
						accepted: true,
						queued: command !== "prompt",
						command,
					},
				};
			} catch (error) {
				if (isAbortError(error)) throw error;
				return { content: [{ type: "text" as const, text: String(error) }], details: { accepted: false } };
			}
		},
	});
	pi.registerTool<typeof IdSchema, unknown>({
		name: "subagent_interrupt",
		label: "Subagent Interrupt",
		description: "Accept a cooperative abort while keeping the child process alive. Native settlement reports the eventual aborted outcome.",
		parameters: IdSchema,
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			try {
				const interrupted = await withChildOperation(handle, signal, () =>
					interrupt(handle, signal),
				);
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
						handle: await serialize(handle, {}, signal),
						interrupted,
						accepted: interrupted,
						settlementPending: interrupted && handle.runState !== "idle",
					},
				};
			} catch (error) {
				if (isAbortError(error)) throw error;
				return { content: [{ type: "text" as const, text: String(error) }], details: { interrupted: false } };
			}
		},
	});
	pi.registerTool<typeof IdSchema, unknown>({
		name: "subagent_kill",
		label: "Subagent Kill",
		description: "Terminate the child process after cooperative abort and bounded escalation. Use this cleanup action for completed or abandoned children.",
		parameters: IdSchema,
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			const stopped = await withChildOperation(handle, signal, async () => {
				if (!active(handle)) return true;
				await terminate(handle, true, signal);
				return handle.processState === "stopped";
			});
			return {
				content: [
					{
						type: "text" as const,
						text: stopped
							? `Terminated subagent #${handle.id}; artifacts were retained.`
							: `Could not confirm termination of subagent #${handle.id}; the tracked process still appears live.`,
					},
				],
				details: {
					handle: await serialize(handle, {}, signal),
					terminated: stopped,
				},
			};
		},
	});
	pi.registerTool<typeof ResumeSchema, unknown>({
		name: "subagent_resume",
		label: "Subagent Resume",
		description: "Resume a stopped child from its saved Pi session file in a new RPC process incarnation.",
		parameters: ResumeSchema,
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const handle = handles.get(params.id);
			if (!handle)
				return {
					content: [{ type: "text" as const, text: `Unknown subagent id: ${params.id}` }],
					details: {},
				};
			try {
				const action = await withChildOperation(handle, signal, async () => {
					if (active(handle)) return { kind: "active" as const };
					if (!requireLease())
						return {
							kind: "conflict" as const,
							text: await leaseConflictMessage(signal),
						};
					await resumeChild(handle, params.task, signal);
					return { kind: "resumed" as const };
				});
				if (action.kind === "active")
					return {
						content: [{ type: "text" as const, text: `Subagent #${handle.id} is still alive; resume is for stopped children.` }],
						details: { handle: await serialize(handle, {}, signal) },
					};
				if (action.kind === "conflict")
					return { content: [{ type: "text" as const, text: action.text }], details: {} };
				return {
					content: [{ type: "text" as const, text: `Resumed subagent #${handle.id} from ${handle.sessionPath} in a new RPC process incarnation.` }],
					details: { handle: await serialize(handle, {}, signal) },
				};
			} catch (error) {
				if (isAbortError(error)) throw error;
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: { handle: await serialize(handle, {}, signal) },
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
							const command = await withChildOperation(handle, undefined, () =>
								deliverMessage(handle, "steer", message),
							);
							return `Accepted via ${command}.`;
						},
						kill: async (id) => {
							const handle = handles.get(id);
							if (!handle) return "Subagent no longer exists.";
							await withChildOperation(handle, undefined, () => terminate(handle));
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
			await Promise.allSettled(
				sorted()
					.filter(active)
					.map((handle) =>
						withChildOperation(handle, undefined, () => terminate(handle)),
					),
			);
		},
	});
}
