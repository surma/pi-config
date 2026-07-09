import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { SubagentInspector, sanitizeTerminalText, type InspectorHandle } from "./ui.js";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const childExtensionPath = join(__dirname, "child.ts");

const MAX_RETAINED_HANDLES = 24;
const MAX_WIDGET_ITEMS = 12;
const STARTUP_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 10_000;
const ABORT_ACK_TIMEOUT_MS = 1_000;
const TERM_DEADLINE_MS = 1_500;
const KILL_DEADLINE_MS = 4_000;
const SETTLEMENT_DEADLINE_MS = 6_000;
const RESULT_PREVIEW_MAX = 1_200;
const SERIALIZED_RESULT_PREVIEW_MAX = 240;

type SubagentState = "starting" | "running" | "done" | "error" | "killed";
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

interface RpcPendingRequest {
	command: string;
	resolve: (response: Record<string, any>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface SubagentHandle {
	id: string;
	name?: string;
	task: string;
	cwd: string;
	state: SubagentState;
	requestedModel: string;
	requestedThinking: ThinkingLevel;
	configuredTools: string[];
	sessionDir: string;
	promptPath: string;
	actualModel?: ActualModel;
	actualThinking?: ThinkingLevel;
	sessionPath?: string;
	transcriptPersisted?: boolean;
	resultText: string;
	resultPath?: string;
	persistedResultHash?: string;
	stderr: string;
	diagnostics: string[];
	error?: string;
	stopReason?: string;
	pid?: number;
	exitCode?: number;
	createdAt: number;
	rpcReadyAt?: number;
	agentStartedAt?: number;
	lastActivityAt: number;
	completedAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	lastTool?: string;
	activeTools: Map<string, { name: string; startedAt: number }>;
	isStreaming: boolean;
	usage: UsageStats;
	process?: ChildProcessWithoutNullStreams;
	requestSequence: number;
	pendingRequests: Map<string, RpcPendingRequest>;
	completionSettled: boolean;
	completionPromise?: Promise<SubagentHandle>;
	waiters: Set<() => void>;
	killRequestedAt?: number;
	terminationPromise?: Promise<SubagentHandle>;
	terminationTimers: Set<NodeJS.Timeout>;
	agentEndedAt?: number;
}

interface SerializableHandle {
	id: string;
	name?: string;
	state: SubagentState;
	killing: boolean;
	task: string;
	cwd: string;
	pid?: number;
	exitCode?: number;
	requestedModel: string;
	requestedThinking: ThinkingLevel;
	actualModel: ActualModel;
	actualThinking: ThinkingLevel;
	configuredTools: string[];
	sessionPath: string;
	promptPath: string;
	resultPath?: string;
	resultKind: ResultKind;
	transcriptPersisted: boolean;
	transcriptNote: string;
	createdAt: number;
	rpcReadyAt?: number;
	agentStartedAt?: number;
	lastActivityAt: number;
	completedAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	lastTool?: string;
	isStreaming: boolean;
	usage: UsageStats;
	stopReason?: string;
	error?: string;
	stderrPreview?: string;
	resultPreview?: string;
	diagnostics?: string[];
}

interface TaskSpec {
	name?: string;
	task: string;
	cwd?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	systemPrompt?: string;
}

interface SubagentModelInfo {
	ref: string;
	provider: string;
	id: string;
	name: string;
	available: boolean;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
}

function now(): number {
	return Date.now();
}

function createId(): string {
	return randomBytes(4).toString("hex");
}

function formatModelRef(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

function formatActualModel(model: ActualModel): string {
	return sanitizeTerminalText(`${model.provider}/${model.id}`);
}

function createUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function hashText(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

function truncate(text: string | undefined, max = 120): string {
	const normalized = (text || "").replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function previewResult(text: string, max = RESULT_PREVIEW_MAX): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max).trimEnd()}\n…`;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as Record<string, unknown>;
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * RPC message updates are snapshots. Keep the longest non-empty snapshot so a
 * late empty or stale-shorter update cannot erase already captured output.
 */
function retainAssistantText(handle: SubagentHandle, candidate: string): void {
	if (!candidate || candidate.length < handle.resultText.length) return;
	if (candidate.length === handle.resultText.length && candidate === handle.resultText) return;
	handle.resultText = candidate;
}

function isHandleActive(handle: SubagentHandle): boolean {
	return !handle.completionSettled && (handle.state === "starting" || handle.state === "running");
}

function isTerminal(handle: SubagentHandle): boolean {
	return handle.state === "done" || handle.state === "error" || handle.state === "killed";
}

function resultKind(handle: SubagentHandle): ResultKind {
	if (!handle.resultText) return "none";
	return handle.state === "done" && !handle.killRequestedAt ? "final" : "partial";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const configuredBinary = process.env.PI_SUBAGENT_PI_BIN;
	if (configuredBinary) return { command: configuredBinary, args };
	const currentScript = process.argv[1];
	const looksLikeScriptPath =
		typeof currentScript === "string" &&
		!currentScript.startsWith("-") &&
		(currentScript.includes("/") || currentScript.endsWith(".js") || currentScript.endsWith(".mjs"));
	if (looksLikeScriptPath) return { command: process.execPath, args: [currentScript, ...args] };

	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function getKnownModels(ctx: ExtensionContext): SubagentModelInfo[] {
	const available = new Set(ctx.modelRegistry.getAvailable().map((model) => formatModelRef(model.provider, model.id).toLowerCase()));
	return [...ctx.modelRegistry.getAll()]
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
		.map((model) => ({
			ref: formatModelRef(model.provider, model.id),
			provider: model.provider,
			id: model.id,
			name: model.name,
			available: available.has(formatModelRef(model.provider, model.id).toLowerCase()),
			reasoning: !!model.reasoning,
			input: [...model.input],
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
}

function resolveKnownModel(ctx: ExtensionContext, rawModel: string): { ref?: string; error?: string } {
	const model = rawModel.trim();
	const known = getKnownModels(ctx);
	if (!model) return { error: "A child model is required, but the selected model is empty." };
	if (known.length === 0) return { error: "No models are configured. Use list_models to inspect configured models." };

	const lower = model.toLowerCase();
	const exact = known.find((candidate) => candidate.ref.toLowerCase() === lower);
	if (exact) {
		if (!exact.available) return { error: `Model \"${exact.ref}\" is known but unavailable. Use list_models to choose an available model.` };
		return { ref: exact.ref };
	}

	const slashIndex = model.indexOf("/");
	if (slashIndex !== -1) {
		const provider = model.slice(0, slashIndex);
		if (!known.some((candidate) => candidate.provider.toLowerCase() === provider.toLowerCase())) {
			return { error: `Unknown provider \"${provider}\". Use list_models to inspect valid models.` };
		}
		return { error: `Unknown model \"${model}\". Use list_models to inspect valid models.` };
	}

	const byId = known.filter((candidate) => candidate.id.toLowerCase() === lower);
	if (byId.length === 1) {
		if (!byId[0]!.available) return { error: `Model \"${byId[0]!.ref}\" is known but unavailable. Use list_models to choose an available model.` };
		return { ref: byId[0]!.ref };
	}
	if (byId.length > 1) return { error: `Model \"${model}\" is ambiguous. Use a full provider/model ID from list_models.` };
	return { error: `Unknown model \"${model}\". Use list_models to inspect valid models.` };
}

function getParentModel(ctx: ExtensionContext): string | undefined {
	return ctx.model ? formatModelRef(ctx.model.provider, ctx.model.id) : undefined;
}

function asActualModel(value: unknown): ActualModel | undefined {
	if (!value || typeof value !== "object") return undefined;
	const model = value as { provider?: unknown; id?: unknown; name?: unknown };
	if (typeof model.provider !== "string" || typeof model.id !== "string") return undefined;
	return { provider: model.provider, id: model.id, name: typeof model.name === "string" ? model.name : undefined };
}

function isRpcResponse(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && (value as { type?: unknown }).type === "response";
}

const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const);

const TaskSpecSchema = Type.Object({
	name: Type.Optional(Type.String({ description: "Optional display name for the child" })),
	task: Type.String({ minLength: 1, description: "Focused task to delegate" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child process" })),
	model: Type.Optional(Type.String({ description: "Optional child model override in provider/model form" })),
	thinking: Type.Optional(ThinkingSchema),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional active-tool narrowing for the child" })),
	systemPrompt: Type.Optional(Type.String({ description: "Optional direct delegated guidance for the child" })),
});

const ListSchema = Type.Object({
	includeFinished: Type.Optional(Type.Boolean({ default: true, description: "Include completed, errored, and killed handles" })),
});

const StatusSchema = Type.Object({
	id: Type.String({ description: "Subagent handle ID" }),
});

const WaitSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Specific subagent ID to wait for" })),
	all: Type.Optional(Type.Boolean({ description: "Wait for the current snapshot of all active subagents" })),
	timeoutSeconds: Type.Number({ minimum: 1, description: "Required finite timeout in seconds" }),
});

const SteerSchema = Type.Object({
	id: Type.String({ description: "Running subagent handle ID" }),
	message: Type.String({ minLength: 1, description: "Direction to queue through Pi native steering" }),
});

const KillSchema = Type.Object({
	id: Type.String({ description: "Subagent handle ID to terminate" }),
});

export default function subagentExtension(pi: ExtensionAPI) {
	const handles = new Map<string, SubagentHandle>();
	let latestCtx: ExtensionContext | null = null;
	let widgetVisible = true;
	let activeInspector: SubagentInspector | undefined;

	function rememberContext(ctx: ExtensionContext): void {
		latestCtx = ctx;
	}

	function sortHandles(values: Iterable<SubagentHandle>): SubagentHandle[] {
		return [...values].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
	}

	function readyHandles(): SubagentHandle[] {
		return sortHandles(handles.values()).filter((handle) => !!handle.actualModel && !!handle.actualThinking && !!handle.sessionPath);
	}

	function trimRetainedHandles(): void {
		if (handles.size <= MAX_RETAINED_HANDLES) return;
		const terminal = sortHandles(handles.values())
			.filter(isTerminal)
			.sort((a, b) => (a.completedAt ?? a.lastActivityAt) - (b.completedAt ?? b.lastActivityAt));
		while (handles.size > MAX_RETAINED_HANDLES && terminal.length > 0) {
			const handle = terminal.shift();
			if (handle) handles.delete(handle.id);
		}
	}

	function activityLabel(handle: SubagentHandle): string {
		if (handle.killRequestedAt) return "killing";
		if (handle.currentTool) return handle.currentTool;
		if (handle.isStreaming) return "responding";
		if (handle.agentEndedAt && !handle.completionSettled) return "finishing";
		return handle.lastTool || "idle";
	}

	function refreshUi(): void {
		activeInspector?.refresh();
		const ctx = latestCtx;
		if (!ctx || ctx.mode !== "tui") return;
		const active = readyHandles().filter(isHandleActive);
		if (!widgetVisible || active.length === 0) {
			ctx.ui.setWidget("subagent", undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const lines = active.slice(0, MAX_WIDGET_ITEMS).map((handle) => {
			const icon = handle.killRequestedAt ? "◐" : handle.state === "starting" ? "○" : "●";
			const model = formatActualModel(handle.actualModel!);
			const elapsedSeconds = Math.max(0, Math.floor((now() - handle.createdAt) / 1000));
			const elapsed = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
			const label = handle.name ? ` ${theme.bold(sanitizeTerminalText(handle.name))}` : "";
			return `${theme.fg("warning", icon)} ${handle.id}${label}  ${elapsed}  ${theme.fg("muted", `${model} · thinking:${handle.actualThinking}`)}  ${sanitizeTerminalText(activityLabel(handle))}`;
		});
		if (active.length > MAX_WIDGET_ITEMS) lines.push(theme.fg("dim", `… ${active.length - MAX_WIDGET_ITEMS} more active subagents`));
		ctx.ui.setWidget("subagent", lines);
	}

	function updateHandle(handle: SubagentHandle, patch: Partial<SubagentHandle> = {}): void {
		Object.assign(handle, patch);
		handle.lastActivityAt = now();
		trimRetainedHandles();
		refreshUi();
	}

	function clearTerminationTimers(handle: SubagentHandle): void {
		for (const timer of handle.terminationTimers) clearTimeout(timer);
		handle.terminationTimers.clear();
	}

	function clearPendingRequest(handle: SubagentHandle, requestId: string): RpcPendingRequest | undefined {
		const pending = handle.pendingRequests.get(requestId);
		if (!pending) return undefined;
		clearTimeout(pending.timer);
		handle.pendingRequests.delete(requestId);
		return pending;
	}

	function rejectPendingRequests(handle: SubagentHandle, error: Error): void {
		for (const [requestId, pending] of handle.pendingRequests) {
			clearTimeout(pending.timer);
			handle.pendingRequests.delete(requestId);
			pending.reject(error);
		}
	}

	function addDiagnostic(handle: SubagentHandle, message: string): void {
		handle.diagnostics.push(message);
		if (handle.diagnostics.length > 20) handle.diagnostics.splice(0, handle.diagnostics.length - 20);
	}

	async function ensureResultPersisted(handle: SubagentHandle): Promise<string | undefined> {
		if (!handle.resultText) return undefined;
		const nextHash = hashText(handle.resultText);
		if (handle.resultPath && handle.persistedResultHash === nextHash) return handle.resultPath;
		try {
			const resultPath = join(handle.sessionDir, "result.md");
			await fs.writeFile(resultPath, handle.resultText, { encoding: "utf8", mode: 0o600 });
			await fs.chmod(resultPath, 0o600).catch(() => {});
			handle.resultPath = resultPath;
			handle.persistedResultHash = nextHash;
			return resultPath;
		} catch (error) {
			const message = `Failed to persist subagent result: ${error instanceof Error ? error.message : String(error)}`;
			handle.stderr += `${message}\n`;
			addDiagnostic(handle, message);
			return undefined;
		}
	}

	function settleHandle(handle: SubagentHandle): Promise<SubagentHandle> {
		if (handle.completionPromise) return handle.completionPromise;
		handle.completionSettled = true;
		handle.completedAt ||= now();
		clearTerminationTimers(handle);
		rejectPendingRequests(handle, new Error(`Subagent #${handle.id} settled before RPC request completed.`));
		handle.completionPromise = (async () => {
			await ensureResultPersisted(handle);
			for (const resolve of handle.waiters) resolve();
			handle.waiters.clear();
			trimRetainedHandles();
			refreshUi();
			return handle;
		})();
		return handle.completionPromise;
	}

	function writeRpc(handle: SubagentHandle, payload: Record<string, unknown>): void {
		if (!handle.process?.stdin.writable) throw new Error(`Subagent #${handle.id} RPC stdin is unavailable.`);
		handle.process.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	function requestRpc(handle: SubagentHandle, command: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
		if (!handle.process || handle.completionSettled) return Promise.reject(new Error(`Subagent #${handle.id} is no longer running.`));
		const requestId = `${handle.id}:${++handle.requestSequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = clearPendingRequest(handle, requestId);
				if (pending) pending.reject(new Error(`Timed out waiting for ${command} acknowledgement from subagent #${handle.id}.`));
			}, timeoutMs);
			handle.pendingRequests.set(requestId, { command, resolve, reject, timer });
			try {
				writeRpc(handle, { id: requestId, type: command, ...payload });
			} catch (error) {
				const pending = clearPendingRequest(handle, requestId);
				if (pending) pending.reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	function updateUsage(handle: SubagentHandle, message: Record<string, any>): void {
		const usage = message.usage || {};
		handle.usage.input += Number(usage.input) || 0;
		handle.usage.output += Number(usage.output) || 0;
		handle.usage.cacheRead += Number(usage.cacheRead) || 0;
		handle.usage.cacheWrite += Number(usage.cacheWrite) || 0;
		handle.usage.cost += Number(usage.cost?.total) || 0;
		handle.usage.turns += 1;
	}

	function updateCurrentTool(handle: SubagentHandle): void {
		const latest = [...handle.activeTools.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
		handle.currentTool = latest?.name;
		handle.currentToolStartedAt = latest?.startedAt;
	}

	function handleRpcRecord(handle: SubagentHandle, record: Record<string, any>): void {
		if (isRpcResponse(record)) {
			const requestId = typeof record.id === "string" ? record.id : undefined;
			const pending = requestId ? clearPendingRequest(handle, requestId) : undefined;
			if (!pending) return;
			if (record.command !== pending.command) {
				pending.reject(new Error(`Expected ${pending.command} response, received ${String(record.command)}.`));
				return;
			}
			if (record.success !== true) {
				pending.reject(new Error(String(record.error || `${pending.command} was rejected by Pi.`)));
				return;
			}
			pending.resolve(record);
			return;
		}

		switch (record.type) {
			case "agent_start":
				handle.agentStartedAt ||= now();
				if (handle.state === "starting") handle.state = "running";
				updateHandle(handle);
				return;
			case "tool_execution_start": {
				const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : `${now()}:${record.toolName || "tool"}`;
				const name = typeof record.toolName === "string" ? record.toolName : "tool";
				handle.activeTools.set(toolCallId, { name, startedAt: now() });
				updateCurrentTool(handle);
				if (handle.state === "starting") handle.state = "running";
				updateHandle(handle);
				return;
			}
			case "tool_execution_end": {
				if (typeof record.toolCallId === "string") handle.activeTools.delete(record.toolCallId);
				if (typeof record.toolName === "string") handle.lastTool = record.toolName;
				updateCurrentTool(handle);
				updateHandle(handle);
				return;
			}
			case "message_update": {
				handle.isStreaming = true;
				const event = record.assistantMessageEvent as { type?: unknown } | undefined;
				if (event?.type === "done" || event?.type === "error") handle.isStreaming = false;
				const partial = record.message as Record<string, any> | undefined;
				if (partial?.role === "assistant") retainAssistantText(handle, extractText(partial.content));
				updateHandle(handle);
				return;
			}
			case "message_end": {
				const message = record.message as Record<string, any> | undefined;
				if (message?.role !== "assistant") return;
				handle.isStreaming = false;
				retainAssistantText(handle, extractText(message.content));
				void transcriptStatus(handle).then(() => refreshUi());
				updateUsage(handle, message);
				handle.stopReason = typeof message.stopReason === "string" ? message.stopReason : handle.stopReason;
				if (typeof message.errorMessage === "string" && message.errorMessage) handle.error = message.errorMessage;
				if (!handle.killRequestedAt && (message.stopReason === "error" || message.errorMessage)) handle.state = "error";
				updateHandle(handle);
				return;
			}
			case "agent_end":
				handle.isStreaming = false;
				handle.agentEndedAt = now();
				if (!handle.killRequestedAt && handle.state !== "error") handle.state = "done";
				updateHandle(handle);
				// A normal completion retains the established prompt settlement path.
				// Killed and error handles instead wait for close so late abort output
				// remains eligible for persistence.
				if (handle.state === "done") void settleHandle(handle);
				return;
			case "extension_error":
				addDiagnostic(handle, `${String(record.extensionPath || "extension")}: ${String(record.error || "Unknown extension error")}`);
				handle.stderr += `${handle.diagnostics[handle.diagnostics.length - 1]}\n`;
				updateHandle(handle);
				return;
			default:
				return;
		}
	}

	function attachProcess(handle: SubagentHandle, proc: ChildProcessWithoutNullStreams): void {
		handle.process = proc;
		handle.pid = proc.pid;
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		let stdoutBuffer = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const parsed = JSON.parse(line);
				if (!parsed || typeof parsed !== "object") {
					addDiagnostic(handle, `Ignored non-object RPC record: ${truncate(line, 200)}`);
					return;
				}
				handleRpcRecord(handle, parsed as Record<string, any>);
			} catch (error) {
				addDiagnostic(handle, `Malformed RPC JSON: ${error instanceof Error ? error.message : String(error)}: ${truncate(line, 200)}`);
			}
		};

		proc.stdout.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			while (true) {
				const newline = stdoutBuffer.indexOf("\n");
				if (newline === -1) break;
				let line = stdoutBuffer.slice(0, newline);
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				processLine(line);
			}
		});

		proc.stderr.on("data", (chunk: string) => {
			handle.stderr += chunk;
			updateHandle(handle);
		});

		proc.on("error", (error) => {
			handle.process = undefined;
			if (handle.killRequestedAt) {
				signalProcess(handle, "SIGKILL");
				handle.state = "killed";
			} else {
				handle.state = "error";
				handle.error ||= error.message;
			}
			// Node emits close after error once stdout/stderr drain. Settling only
			// there keeps any final buffered assistant output observable.
			updateHandle(handle);
		});

		proc.on("close", (code, signal) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer.trim());
			handle.process = undefined;
			handle.exitCode = code ?? (signal ? 1 : 0);
			if (!handle.completionSettled) {
				if (handle.killRequestedAt) {
					signalProcess(handle, "SIGKILL");
					handle.state = "killed";
					handle.error ||= "Killed";
				} else if (handle.state === "error" || code !== 0) {
					handle.state = "error";
					handle.error ||= signal ? `Exited via signal ${signal}` : `Exited with code ${code ?? 0}`;
				} else {
					handle.state = "done";
				}
				updateHandle(handle);
				void settleHandle(handle);
			}
		});
	}

	function signalProcess(handle: SubagentHandle, signal: NodeJS.Signals): void {
		const pid = handle.pid;
		if (!pid || pid <= 0) return;
		if (process.platform !== "win32") {
			try {
				process.kill(-pid, signal);
				return;
			} catch (error) {
				addDiagnostic(handle, `Process-group ${signal} failed: ${error instanceof Error ? error.message : String(error)}; falling back to PID.`);
			}
		}
		if (!handle.process) return;
		try {
			handle.process.kill(signal);
		} catch (error) {
			addDiagnostic(handle, `Process ${signal} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function scheduleTermination(handle: SubagentHandle, delayMs: number, callback: () => void): void {
		const timer = setTimeout(() => {
			handle.terminationTimers.delete(timer);
			callback();
		}, delayMs);
		handle.terminationTimers.add(timer);
	}

	function terminateHandle(handle: SubagentHandle, reason: string): Promise<SubagentHandle> {
		if (handle.completionPromise) return handle.completionPromise;
		if (handle.terminationPromise) return handle.terminationPromise;
		handle.killRequestedAt = now();
		handle.error ||= reason;
		updateHandle(handle);

		requestRpc(handle, "abort", {}, ABORT_ACK_TIMEOUT_MS)
			.then(() => updateHandle(handle))
			.catch((error) => addDiagnostic(handle, `Abort acknowledgement: ${error.message}`));
		scheduleTermination(handle, TERM_DEADLINE_MS, () => signalProcess(handle, "SIGTERM"));
		scheduleTermination(handle, KILL_DEADLINE_MS, () => signalProcess(handle, "SIGKILL"));
		scheduleTermination(handle, SETTLEMENT_DEADLINE_MS, () => {
			if (handle.completionSettled) return;
			handle.state = "killed";
			handle.error ||= `${reason} (forced settlement after termination deadline)`;
			updateHandle(handle);
			void settleHandle(handle);
		});
		handle.terminationPromise = (async () => {
			if (!handle.completionPromise) {
				await new Promise<void>((resolve) => handle.waiters.add(resolve));
			}
			return (await (handle.completionPromise || Promise.resolve(handle)));
		})();
		return handle.terminationPromise;
	}

	async function killAll(reason: string): Promise<void> {
		await Promise.allSettled(sortHandles(handles.values()).filter(isHandleActive).map((handle) => terminateHandle(handle, reason)));
	}

	function transcriptStatus(handle: SubagentHandle): Promise<{ persisted: boolean; note: string }> {
		if (!handle.sessionPath) return Promise.resolve({ persisted: false, note: "no persisted transcript yet" });
		return fs
			.stat(handle.sessionPath)
			.then((stat) => {
				handle.transcriptPersisted = stat.isFile();
				return { persisted: handle.transcriptPersisted, note: handle.transcriptPersisted ? "persisted transcript available" : "no persisted transcript yet" };
			})
			.catch(() => {
				handle.transcriptPersisted = false;
				return { persisted: false, note: "no persisted transcript yet" };
			});
	}

	async function serializeHandle(handle: SubagentHandle): Promise<SerializableHandle> {
		if (!handle.actualModel || !handle.actualThinking || !handle.sessionPath) {
			throw new Error(`Subagent #${handle.id} has not completed its required startup handshake.`);
		}
		if (handle.resultText) await ensureResultPersisted(handle);
		const transcript = await transcriptStatus(handle);
		return {
			id: handle.id,
			name: handle.name,
			state: handle.state,
			killing: !!handle.killRequestedAt && !handle.completionSettled,
			task: handle.task,
			cwd: handle.cwd,
			pid: handle.pid,
			exitCode: handle.exitCode,
			requestedModel: handle.requestedModel,
			requestedThinking: handle.requestedThinking,
			actualModel: { ...handle.actualModel },
			actualThinking: handle.actualThinking,
			configuredTools: [...handle.configuredTools],
			sessionPath: handle.sessionPath,
			promptPath: handle.promptPath,
			resultPath: handle.resultPath,
			resultKind: resultKind(handle),
			transcriptPersisted: transcript.persisted,
			transcriptNote: transcript.note,
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
			error: handle.error,
			stderrPreview: truncate(handle.stderr, SERIALIZED_RESULT_PREVIEW_MAX) || undefined,
			resultPreview: handle.resultText ? previewResult(handle.resultText, SERIALIZED_RESULT_PREVIEW_MAX) : undefined,
			diagnostics: handle.diagnostics.length > 0 ? [...handle.diagnostics] : undefined,
		};
	}

	async function serializeHandles(values: SubagentHandle[]): Promise<SerializableHandle[]> {
		return Promise.all(values.map((handle) => serializeHandle(handle)));
	}

	function toInspectorHandle(handle: SubagentHandle): InspectorHandle | undefined {
		if (!handle.actualModel || !handle.actualThinking || !handle.sessionPath) return undefined;
		return {
			id: handle.id,
			name: handle.name,
			state: handle.state,
			killing: !!handle.killRequestedAt && !handle.completionSettled,
			task: handle.task,
			cwd: handle.cwd,
			pid: handle.pid,
			exitCode: handle.exitCode,
			requestedModel: handle.requestedModel,
			requestedThinking: handle.requestedThinking,
			actualModel: handle.actualModel,
			actualThinking: handle.actualThinking,
			configuredTools: [...handle.configuredTools],
			sessionPath: handle.sessionPath,
			promptPath: handle.promptPath,
			resultPath: handle.resultPath,
			resultKind: resultKind(handle),
			transcriptNote: handle.transcriptPersisted ? "persisted transcript available" : "no persisted transcript yet",
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
			error: handle.error,
			stderrPreview: truncate(handle.stderr, SERIALIZED_RESULT_PREVIEW_MAX) || undefined,
			resultPreview: handle.resultText ? previewResult(handle.resultText, SERIALIZED_RESULT_PREVIEW_MAX) : undefined,
		};
	}


	async function formatHandleSummary(handle: SubagentHandle): Promise<string> {
		const serial = await serializeHandle(handle);
		const duration = Math.max(0, Math.floor(((serial.completedAt || now()) - serial.createdAt) / 1000));
		const activity = serial.killing ? "killing" : serial.currentTool || serial.lastTool || (serial.isStreaming ? "responding" : "idle");
		const label = serial.name ? ` ${serial.name}` : "";
		const lines = [
			`#${serial.id}${label} ${serial.killing ? "killing" : serial.state} (${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")})`,
			`  actual ${formatActualModel(serial.actualModel)} · thinking:${serial.actualThinking} · ${activity}`,
			`  session ${serial.sessionPath} (${serial.transcriptNote})`,
			`  prompt ${serial.promptPath}`,
		];
		if (serial.resultPath) lines.push(`  ${serial.resultKind} result ${serial.resultPath}`);
		if (serial.error) lines.push(`  error ${truncate(serial.error, 180)}`);
		if (serial.resultPreview) lines.push(`  ${serial.resultKind} preview ${truncate(serial.resultPreview, 180)}`);
		return sanitizeTerminalText(lines.join("\n"));
	}

	async function activeOrRecentSummary(includeFinished: boolean): Promise<string> {
		const selected = readyHandles().filter((handle) => includeFinished || isHandleActive(handle));
		if (selected.length === 0) return "No subagents tracked yet.";
		return (await Promise.all(selected.map((handle) => formatHandleSummary(handle)))).join("\n\n");
	}

	function getRequestedChildTools(tools: string[] | undefined): string[] {
		const parentActiveTools = new Set(pi.getActiveTools());
		const requested = tools && tools.length > 0 ? tools : Array.from(parentActiveTools);
		return requested.filter((toolName) => parentActiveTools.has(toolName));
	}

	function getSubagentDepth(): number {
		return Math.max(0, Number.parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10) || 0);
	}

	function isNestedSubagent(): boolean {
		return getSubagentDepth() > 0;
	}

	function nestedDelegationBlocked() {
		return {
			content: [{ type: "text", text: "subagent_start is disabled inside delegated subagents. Report any need for further delegation back to the parent agent instead." }],
			details: { nestedDelegationBlocked: true },
		};
	}

	async function validateCwd(cwd: string): Promise<string | undefined> {
		try {
			if (!(await fs.stat(cwd)).isDirectory()) return `Subagent cwd is not a directory: ${cwd}`;
			return undefined;
		} catch {
			return `Subagent cwd does not exist or cannot be read: ${cwd}`;
		}
	}

	function validateSubagentSpec(
		ctx: ExtensionContext,
		spec: TaskSpec,
	): { requestedModel?: string; requestedThinking?: ThinkingLevel; error?: string } {
		const requestedModel = spec.model || getParentModel(ctx);
		if (!requestedModel) return { error: "No parent model is selected, and this subagent did not specify model." };
		const resolvedModel = resolveKnownModel(ctx, requestedModel);
		if (!resolvedModel.ref) return { error: resolvedModel.error || "Invalid subagent model." };
		const requestedThinking = spec.thinking || pi.getThinkingLevel();
		if (!isThinkingLevel(requestedThinking)) return { error: `Invalid requested thinking level: ${String(requestedThinking)}` };
		return { requestedModel: resolvedModel.ref, requestedThinking };
	}

	async function spawnSubagent(spec: TaskSpec, cwd: string, requestedModel: string, requestedThinking: ThinkingLevel): Promise<SubagentHandle> {
		const cwdError = await validateCwd(cwd);
		if (cwdError) throw new Error(cwdError);
		const id = createId();
		const sessionDir = join(getAgentDir(), "sessions", "subagents", id);
		const promptPath = join(sessionDir, "pi-effective-system-prompt.txt");
		await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
		await fs.chmod(sessionDir, 0o700).catch(() => {});

		const handle: SubagentHandle = {
			id,
			name: spec.name?.trim() || undefined,
			task: spec.task,
			cwd,
			state: "starting",
			requestedModel,
			requestedThinking,
			configuredTools: getRequestedChildTools(spec.tools),
			sessionDir,
			promptPath,
			resultText: "",
			stderr: "",
			diagnostics: [],
			createdAt: now(),
			lastActivityAt: now(),
			activeTools: new Map(),
			isStreaming: false,
			usage: createUsage(),
			requestSequence: 0,
			pendingRequests: new Map(),
			completionSettled: false,
			waiters: new Set(),
			terminationTimers: new Set(),
		};
		handles.set(id, handle);
		refreshUi();

		try {
			const args = [
				"--mode",
				"rpc",
				"--session-dir",
				sessionDir,
				"--extension",
				childExtensionPath,
				"--model",
				requestedModel,
				"--thinking",
				requestedThinking,
			];
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: true,
				shell: false,
				env: {
					...process.env,
					PI_SUBAGENT_CHILD: "1",
					PI_SUBAGENT_SYSTEM_PROMPT: spec.systemPrompt || "",
					PI_SUBAGENT_ACTIVE_TOOLS: handle.configuredTools.join(","),
					PI_SUBAGENT_DEPTH: String(getSubagentDepth() + 1),
					PI_SUBAGENT_PROMPT_PATH: promptPath,
				},
			});
			attachProcess(handle, proc);
			const stateResponse = await requestRpc(handle, "get_state", {}, STARTUP_TIMEOUT_MS);
			const state = stateResponse.data as Record<string, unknown> | undefined;
			const actualModel = asActualModel(state?.model);
			const actualThinking = state?.thinkingLevel;
			const sessionPath = state?.sessionFile;
			if (!actualModel || !isThinkingLevel(actualThinking) || typeof sessionPath !== "string" || !sessionPath) {
				throw new Error("Child startup failed: Pi get_state did not provide model, thinkingLevel, and sessionFile.");
			}
			handle.actualModel = actualModel;
			handle.actualThinking = actualThinking;
			handle.sessionPath = sessionPath;
			handle.rpcReadyAt = now();
			updateHandle(handle);
			await requestRpc(handle, "prompt", { message: spec.task }, STARTUP_TIMEOUT_MS);
			if (handle.state === "starting") handle.state = "running";
			updateHandle(handle);
			return handle;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			handle.error = `Child startup failed: ${message}`;
			addDiagnostic(handle, handle.error);
			await terminateHandle(handle, handle.error);
			handles.delete(handle.id);
			refreshUi();
			throw new Error(handle.error);
		}
	}

	function waitForTargets(targets: SubagentHandle[], timeoutSeconds: number, signal: AbortSignal | undefined): Promise<"completed" | "timedOut" | "canceled"> {
		if (targets.every((handle) => handle.completionSettled)) return Promise.resolve("completed");
		return new Promise((resolve) => {
			let settled = false;
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				for (const [handle, waiter] of waiters) handle.waiters.delete(waiter);
			};
			const finish = (outcome: "completed" | "timedOut" | "canceled") => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(outcome);
			};
			const check = () => {
				if (targets.every((handle) => handle.completionSettled)) finish("completed");
			};
			const waiters = new Map<SubagentHandle, () => void>();
			for (const handle of targets) {
				if (handle.completionSettled) continue;
				const waiter = () => check();
				waiters.set(handle, waiter);
				handle.waiters.add(waiter);
			}
			const timer = setTimeout(() => finish("timedOut"), timeoutSeconds * 1000);
			const onAbort = () => finish("canceled");
			if (signal?.aborted) {
				finish("canceled");
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}

	async function steerHandle(handle: SubagentHandle, message: string): Promise<string> {
		if (!isHandleActive(handle)) throw new Error(`Subagent #${handle.id} is already ${handle.state}.`);
		if (!message.trim()) throw new Error("Steering message must not be empty.");
		await requestRpc(handle, "steer", { message: message.trim() }, RPC_TIMEOUT_MS);
		updateHandle(handle);
		const label = handle.name ? ` (${handle.name})` : "";
		return `Pi accepted steering for #${handle.id}${label}; it will be applied at Pi's next safe point.`;
	}

	function clearFinishedHandles(): number {
		let count = 0;
		for (const handle of handles.values()) {
			if (!isTerminal(handle)) continue;
			handles.delete(handle.id);
			count++;
		}
		refreshUi();
		return count;
	}

	pi.on("session_start", async (_event, ctx) => {
		rememberContext(ctx);
		refreshUi();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		rememberContext(ctx);
		await killAll("Parent session shutting down");
		if (ctx.mode === "tui") ctx.ui.setWidget("subagent", undefined);
		latestCtx = null;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		rememberContext(ctx);
		const guidance = isNestedSubagent()
			? `\n\nSubagent extension is loaded in this delegated child to preserve the parent environment.
You are already inside a subagent. Never call subagent_start from within a subagent.
If further delegation seems useful, report that back to the parent agent instead.`
			: `\n\nSubagent extension is available.
Only use subagent_start when the user explicitly asks to delegate work. It starts in the background after a bounded startup handshake.
Use subagent_list and subagent_status to inspect children. Use subagent_wait with a required finite timeoutSeconds when waiting; timeout or cancellation never kills a child. Use subagent_steer to redirect running work and subagent_kill only to terminate it.
Use list_models to inspect exact accepted child model IDs before setting model when needed.
A subagent call requires task. Its optional name is only a display label; cwd, systemPrompt, tools, model, and thinking are direct per-call controls. Model and thinking default to the parent session. Nested delegation is blocked.`;
		return { systemPrompt: event.systemPrompt + guidance };
	});

	pi.registerTool({
		name: "subagent_start",
		label: "Subagent Start",
		description: "Start one isolated background subagent after a bounded Pi RPC startup handshake. Returns actual runtime model/thinking and the authoritative allocated session path.",
		promptSnippet: "Start an explicitly requested background subagent and receive its ID, actual runtime metadata, and session path.",
		promptGuidelines: [
			"Use subagent_start only when the user explicitly asks for delegation or a subagent.",
			"Never call subagent_start from within a delegated subagent; nested delegation is disabled.",
			"Inspect background work with subagent_status or subagent_list, wait only with finite timeoutSeconds, steer with subagent_steer, and terminate only with subagent_kill.",
		],
		parameters: TaskSpecSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberContext(ctx);
			if (isNestedSubagent()) return nestedDelegationBlocked();
			const spec = params as TaskSpec;
			const validated = validateSubagentSpec(ctx, spec);
			if (!validated.requestedModel || !validated.requestedThinking) {
				return { content: [{ type: "text", text: validated.error || "Invalid subagent spec" }], details: {} };
			}
			try {
				const handle = await spawnSubagent(spec, spec.cwd || ctx.cwd, validated.requestedModel, validated.requestedThinking);
				const serial = await serializeHandle(handle);
				const label = serial.name ? ` (${serial.name})` : "";
				return {
					content: [{ type: "text", text: sanitizeTerminalText(`Started subagent #${serial.id}${label} in the background. Actual ${formatActualModel(serial.actualModel)} · thinking:${serial.actualThinking}. Session: ${serial.sessionPath} (${serial.transcriptNote}). Use subagent_status, subagent_wait with timeoutSeconds, subagent_steer, or subagent_kill to control it.`) }],
					details: { handle: serial },
				};
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {} };
			}
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: "List current and retained subagent handles with actual model/thinking and artifact paths.",
		parameters: ListSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberContext(ctx);
			const selected = readyHandles().filter((handle) => (params.includeFinished ?? true) || isHandleActive(handle));
			return {
				content: [{ type: "text", text: await activeOrRecentSummary(params.includeFinished ?? true) }],
				details: { handles: await serializeHandles(selected) },
			};
		},
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Return detailed machine-facing lifecycle, activity, usage, actual runtime metadata, and artifact paths for one subagent.",
		parameters: StatusSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberContext(ctx);
			const handle = handles.get(params.id);
			if (!handle || !handle.actualModel || !handle.actualThinking || !handle.sessionPath) {
				return { content: [{ type: "text", text: `Unknown subagent id: ${params.id}` }], details: {} };
			}
			const serial = await serializeHandle(handle);
			return {
				content: [{ type: "text", text: await formatHandleSummary(handle) }],
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
						currentToolStartedAt: serial.currentToolStartedAt,
						lastTool: serial.lastTool,
						streaming: serial.isStreaming,
					},
				},
			};
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description: "Wait for one handle or a snapshot of all active handles. timeoutSeconds is required and never terminates a child.",
		parameters: WaitSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			rememberContext(ctx);
			if (!Number.isFinite(params.timeoutSeconds) || params.timeoutSeconds < 1) {
				return { content: [{ type: "text", text: "timeoutSeconds must be a finite number of at least 1." }], details: { outcome: "completed", handles: [] } };
			}
			const hasId = typeof params.id === "string" && params.id.length > 0;
			const hasAll = params.all === true;
			if (hasId === hasAll) {
				return { content: [{ type: "text", text: "Provide exactly one target: {id, timeoutSeconds} or {all:true, timeoutSeconds}." }], details: { outcome: "completed", handles: [] } };
			}
			let targets: SubagentHandle[];
			if (hasId) {
				const handle = handles.get(params.id!);
				if (!handle || !handle.actualModel || !handle.actualThinking || !handle.sessionPath) {
					return { content: [{ type: "text", text: `Unknown subagent id: ${params.id}` }], details: { outcome: "completed", handles: [] } };
				}
				targets = [handle];
			} else {
				targets = readyHandles().filter(isHandleActive);
			}
			const outcome = await waitForTargets(targets, params.timeoutSeconds, signal);
			const serial = await serializeHandles(targets);
			const summary = targets.length === 0 ? "No active subagents were present in this wait snapshot." : (await Promise.all(targets.map((handle) => formatHandleSummary(handle)))).join("\n\n");
			const hint = outcome === "completed" ? "" : " Use subagent_status, another bounded subagent_wait, subagent_steer, or subagent_kill; the child was not terminated.";
			return {
				content: [{ type: "text", text: `${outcome === "completed" ? "Wait completed." : outcome === "timedOut" ? "Wait timed out." : "Wait canceled."}${hint}\n\n${summary}` }],
				details: { outcome, handles: serial },
			};
		},
	});

	pi.registerTool({
		name: "subagent_steer",
		label: "Subagent Steer",
		description: "Queue a correlated Pi native steering message for a running subagent without waiting for completion.",
		parameters: SteerSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberContext(ctx);
			const handle = handles.get(params.id);
			if (!handle) return { content: [{ type: "text", text: `Unknown subagent id: ${params.id}` }], details: {} };
			try {
				const acknowledgement = await steerHandle(handle, params.message);
				return { content: [{ type: "text", text: acknowledgement }], details: { handle: await serializeHandle(handle), accepted: true } };
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: { handle: handle.actualModel ? await serializeHandle(handle) : undefined, accepted: false } };
			}
		},
	});

	pi.registerTool({
		name: "subagent_kill",
		label: "Subagent Kill",
		description: "Idempotently terminate a child with Pi abort, POSIX process-group TERM/KILL escalation, and forced settlement deadlines.",
		parameters: KillSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberContext(ctx);
			const handle = handles.get(params.id);
			if (!handle) return { content: [{ type: "text", text: `Unknown subagent id: ${params.id}` }], details: {} };
			if (!isHandleActive(handle)) {
				const label = handle.name ? ` (${handle.name})` : "";
				return { content: [{ type: "text", text: `Subagent #${handle.id}${label} is already ${handle.state}.` }], details: { handle: handle.actualModel ? await serializeHandle(handle) : undefined } };
			}
			const result = await terminateHandle(handle, "Killed via subagent_kill");
			const label = result.name ? ` (${result.name})` : "";
			return {
				content: [{ type: "text", text: sanitizeTerminalText(`Terminated subagent #${result.id}${label}; ${resultKind(result) === "partial" ? "partial result was preserved" : "no assistant result was captured"}.\n\n${await formatHandleSummary(result)}`) }],
				details: { handle: await serializeHandle(result) },
			};
		},
	});

	pi.registerCommand("subagents", {
		description: "Inspect tracked subagents, prompts, transcripts, and controls",
		handler: async (_args, ctx) => {
			rememberContext(ctx);
			if (ctx.mode !== "tui") {
				console.log(await activeOrRecentSummary(true));
				return;
			}
			try {
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) => {
						const inspector = new SubagentInspector(tui, theme, keybindings, {
						getHandles: () =>
							readyHandles()
								.map(toInspectorHandle)
								.filter((handle): handle is InspectorHandle => !!handle),
						steer: async (id) => {
							const handle = handles.get(id);
							if (!handle || !isHandleActive(handle)) return `Steering unavailable: #${id} is not active.`;
							const message = await ctx.ui.editor(`Steer #${id}`, "");
							if (!message?.trim()) return "Steering canceled.";
							return steerHandle(handle, message);
						},
						kill: async (id) => {
							const handle = handles.get(id);
							if (!handle || !isHandleActive(handle)) return `Kill unavailable: #${id} is not active.`;
							const label = handle.name ? ` (${handle.name})` : "";
							const confirmed = await ctx.ui.confirm("Kill subagent?", sanitizeTerminalText(`Abort and force-terminate #${id}${label} if needed. Persisted artifacts are kept.`));
							if (!confirmed) return "Kill canceled.";
							await terminateHandle(handle, "Killed from /subagents");
							return `Killed #${id}; artifacts were kept.`;
						},
						clearFinished: clearFinishedHandles,
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
						overlayOptions: { anchor: "right-center", width: "70%", minWidth: 72, maxWidth: 130, maxHeight: "85%", margin: 1 },
					},
				);
			} finally {
				activeInspector?.dispose();
				activeInspector = undefined;
			}
		},
	});

	pi.registerCommand("subagents-toggle", {
		description: "Toggle the compact active-subagent widget",
		handler: async (_args, ctx) => {
			rememberContext(ctx);
			widgetVisible = !widgetVisible;
			refreshUi();
			if (ctx.mode === "tui") ctx.ui.notify(`Subagent widget ${widgetVisible ? "enabled" : "disabled"}.`, "info");
		},
	});

	pi.registerCommand("subagents-kill-all", {
		description: "Kill all active subagents",
		handler: async (_args, ctx) => {
			rememberContext(ctx);
			await killAll("Killed via /subagents-kill-all");
			if (ctx.mode === "tui") ctx.ui.notify("Killed all active subagents; artifacts were kept.", "warning");
		},
	});
}
