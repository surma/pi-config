import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAgents, formatAgentList, type AgentConfig } from "./agents.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const childExtensionPath = join(__dirname, "child.ts");

const MAX_PARALLEL_TASKS = 64;
const MAX_CONCURRENCY = 4;
const MAX_WIDGET_ITEMS = 12;
const MAX_RETAINED_HANDLES = 24;

type SubagentState = "starting" | "running" | "done" | "error" | "killed";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface SubagentHandle {
	id: string;
	agent: AgentConfig;
	task: string;
	cwd: string;
	state: SubagentState;
	statusText: string;
	lastTool?: string;
	resultText: string;
	stderr: string;
	error?: string;
	stopReason?: string;
	model?: string;
	exitCode?: number;
	startedAt: number;
	updatedAt: number;
	usage: UsageStats;
	process?: ChildProcessWithoutNullStreams;
	completionSettled?: boolean;
	waiters: Array<{ resolve: (handle: SubagentHandle) => void; timer?: NodeJS.Timeout }>;
}

interface SerializableHandle {
	id: string;
	agent: string;
	source: string;
	state: SubagentState;
	task: string;
	statusText: string;
	lastTool?: string;
	resultText: string;
	error?: string;
	stopReason?: string;
	model?: string;
	exitCode?: number;
	startedAt: number;
	updatedAt: number;
	usage: UsageStats;
}

interface TaskSpec {
	agent?: string;
	name?: string;
	task: string;
	cwd?: string;
	model?: string;
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
	return randomBytes(3).toString("hex");
}

function formatModelRef(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
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
	if (known.length === 0) {
		return { error: "No models are configured. Use pi model configuration or --list-models first." };
	}

	const lower = model.toLowerCase();
	const exact = known.find((candidate) => candidate.ref.toLowerCase() === lower);
	if (exact) {
		if (!exact.available) {
			return { error: `Model \"${exact.ref}\" is known but unavailable in this session. Choose an available model from subagent_models.` };
		}
		return { ref: exact.ref };
	}

	const slashIndex = model.indexOf("/");
	if (slashIndex !== -1) {
		const provider = model.slice(0, slashIndex);
		const knownProvider = known.find((candidate) => candidate.provider.toLowerCase() === provider.toLowerCase());
		if (!knownProvider) {
			return { error: `Unknown provider \"${provider}\". Use subagent_models to inspect valid models.` };
		}
		return { error: `Unknown model \"${model}\". Use subagent_models to inspect valid models.` };
	}

	const byId = known.filter((candidate) => candidate.id.toLowerCase() === lower);
	if (byId.length === 1) {
		if (!byId[0]!.available) {
			return { error: `Model \"${byId[0]!.ref}\" is known but unavailable in this session. Choose an available model from subagent_models.` };
		}
		return { ref: byId[0]!.ref };
	}
	if (byId.length > 1) {
		return { error: `Model \"${model}\" is ambiguous. Use a full provider/model id from subagent_models.` };
	}

	return { error: `Unknown model \"${model}\". Use subagent_models to inspect valid models.` };
}

function truncate(text: string | undefined, max = 80): string {
	const value = (text || "").replace(/\s+/g, " ").trim();
	if (!value) return "";
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isAbortedAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const value = message as { role?: unknown; stopReason?: unknown };
	return value.role === "assistant" && value.stopReason === "aborted";
}

function isHandleActive(handle: SubagentHandle): boolean {
	return handle.state === "starting" || handle.state === "running" || (handle.state === "killed" && !handle.completionSettled);
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const looksLikeScriptPath =
		typeof currentScript === "string" &&
		!currentScript.startsWith("-") &&
		(currentScript.includes("/") || currentScript.endsWith(".js") || currentScript.endsWith(".mjs"));
	if (looksLikeScriptPath) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: process.env.PI_SUBAGENT_PI_BIN || "pi", args };
}

function createUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function getModelCliArg(ctx: ExtensionContext): string | undefined {
	if (!ctx.model) return undefined;
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function formatUsage(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns}t`);
	if (usage.input) parts.push(`↑${usage.input}`);
	if (usage.output) parts.push(`↓${usage.output}`);
	if (usage.cacheRead) parts.push(`R${usage.cacheRead}`);
	if (usage.cacheWrite) parts.push(`W${usage.cacheWrite}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function serializeHandle(handle: SubagentHandle): SerializableHandle {
	return {
		id: handle.id,
		agent: handle.agent.name,
		source: handle.agent.source,
		state: handle.state,
		task: handle.task,
		statusText: handle.statusText,
		lastTool: handle.lastTool,
		resultText: handle.resultText,
		error: handle.error,
		stopReason: handle.stopReason,
		model: handle.model,
		exitCode: handle.exitCode,
		startedAt: handle.startedAt,
		updatedAt: handle.updatedAt,
		usage: { ...handle.usage },
	};
}

function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return Promise.resolve([]);
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	return Promise.all(workers).then(() => results);
}

const TaskSpecSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Optional predefined subagent name to use as a base" })),
	name: Type.Optional(Type.String({ description: "Optional display name for an ad hoc subagent" })),
	task: Type.String({ description: "Focused task to delegate" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process" })),
	model: Type.Optional(Type.String({ description: "Optional child model override, e.g. openai/gpt-4.1-nano or anthropic/claude-haiku-4-5" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional built-in tool override for the child, e.g. [read,grep,find,ls]" })),
	systemPrompt: Type.Optional(Type.String({ description: "Optional ad hoc subagent prompt or extra instructions. If agent is provided, this is appended to the predefined prompt." })),
});

const SingleSchema = TaskSpecSchema;

const ParallelSchema = Type.Object({
	tasks: Type.Array(TaskSpecSchema, { description: "Parallel tasks to run as a small swarm" }),
});

const ChainSchema = Type.Object({
	chain: Type.Array(
		Type.Object({
			agent: Type.Optional(Type.String({ description: "Optional predefined subagent name to use as a base" })),
			name: Type.Optional(Type.String({ description: "Optional display name for an ad hoc subagent" })),
			task: Type.String({ description: "Task for that step. May include {previous} to include the previous step's final answer." }),
			cwd: Type.Optional(Type.String({ description: "Optional working directory override" })),
			model: Type.Optional(Type.String({ description: "Optional child model override" })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Optional built-in tool override for the child" })),
			systemPrompt: Type.Optional(Type.String({ description: "Optional ad hoc subagent prompt or extra instructions" })),
		}),
		{ description: "Sequential subagent steps" },
	),
});

const RunSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single subagent to run" })),
	name: Type.Optional(Type.String({ description: "Optional display name for an ad hoc single subagent" })),
	task: Type.Optional(Type.String({ description: "Single delegated task" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for single-agent mode" })),
	model: Type.Optional(Type.String({ description: "Optional child model override for single-agent mode" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional built-in tool override for single-agent mode" })),
	systemPrompt: Type.Optional(Type.String({ description: "Optional ad hoc system prompt override for single-agent mode" })),
	tasks: Type.Optional(ParallelSchema.properties.tasks),
	chain: Type.Optional(ChainSchema.properties.chain),
});

const ModelsSchema = Type.Object({
	includeUnavailable: Type.Optional(Type.Boolean({ default: true, description: "Include known but unavailable models in the listing" })),
	search: Type.Optional(Type.String({ description: "Optional case-insensitive substring filter over provider/model and name" })),
});

const WaitSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Specific subagent id to wait for" })),
	all: Type.Optional(Type.Boolean({ default: true, description: "Wait for all active subagents when id is omitted" })),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1, description: "Optional timeout in milliseconds" })),
});

const ListSchema = Type.Object({
	includeCompleted: Type.Optional(Type.Boolean({ default: true, description: "Include completed, errored, and killed subagents" })),
});

const KillSchema = Type.Object({
	id: Type.String({ description: "Subagent id to kill" }),
});

export default function subagentExtension(pi: ExtensionAPI) {
	const handles = new Map<string, SubagentHandle>();
	let latestCtx: ExtensionContext | null = null;
	let widgetVisible = true;

	function rememberContext(ctx: ExtensionContext): void {
		latestCtx = ctx;
	}

	function sortHandles(values: SubagentHandle[]): SubagentHandle[] {
		return [...values].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	}

	function trimRetainedHandles(): void {
		const all = [...handles.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt || a.id.localeCompare(b.id));
		for (const handle of all.slice(MAX_RETAINED_HANDLES)) {
			if (isHandleActive(handle)) continue;
			handles.delete(handle.id);
		}
	}

	function refreshUi(): void {
		const ctx = latestCtx;
		if (!ctx || !ctx.hasUI) return;

		const all = sortHandles([...handles.values()]);
		const running = all.filter((handle) => handle.state === "running" || handle.state === "starting").length;
		const active = all.filter(isHandleActive).length;
		const done = all.filter((handle) => handle.state === "done").length;
		const failed = all.filter((handle) => handle.state === "error").length;
		const killed = all.filter((handle) => handle.state === "killed").length;

		if (all.length === 0 || active === 0) {
			ctx.ui.setWidget("subagent", undefined);
			ctx.ui.setStatus("subagent", undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const lines: string[] = [];
		lines.push(
			theme.fg(
				"accent",
				`Subagents: ${running} running, ${done} done${failed ? `, ${failed} failed` : ""}${killed ? `, ${killed} killed` : ""}`,
			),
		);

		for (const handle of all.slice(0, MAX_WIDGET_ITEMS)) {
			const icon =
				handle.state === "running" || handle.state === "starting"
					? theme.fg("warning", "●")
					: handle.state === "done"
						? theme.fg("success", "✓")
						: handle.state === "killed"
							? theme.fg("muted", "■")
							: theme.fg("error", "✗");
			const header = `${icon} ${theme.fg("accent", handle.id)} ${theme.bold(handle.agent.name)} ${theme.fg("muted", handle.state)} ${theme.fg("dim", truncate(handle.task, 56))}`;
			lines.push(header);
			const detail =
				handle.statusText ||
				(handle.state === "done" ? truncate(handle.resultText, 88) : "") ||
				(handle.lastTool ? `tool: ${handle.lastTool}` : "") ||
				truncate(handle.error, 88);
			if (detail) lines.push(`  ${theme.fg("muted", truncate(detail, 96))}`);
		}
		if (all.length > MAX_WIDGET_ITEMS) {
			lines.push(theme.fg("dim", `… ${all.length - MAX_WIDGET_ITEMS} more subagents hidden`));
		}

		ctx.ui.setWidget("subagent", widgetVisible ? lines : undefined);
		const summary = downstreamSummary(done, failed, killed, theme);
		ctx.ui.setStatus("subagent", theme.fg("accent", `subagents ${running} running`) + (summary ? ` ${summary}` : ""));
	}

	function downstreamSummary(done: number, failed: number, killed: number, theme: any): string {
		const parts: string[] = [];
		if (done) parts.push(theme.fg("success", `${done} done`));
		if (failed) parts.push(theme.fg("error", `${failed} failed`));
		if (killed) parts.push(theme.fg("muted", `${killed} killed`));
		return parts.join(" ");
	}

	function updateHandle(handle: SubagentHandle, patch: Partial<SubagentHandle>): void {
		Object.assign(handle, patch);
		handle.updatedAt = now();
		trimRetainedHandles();
		refreshUi();
	}

	function settleHandle(handle: SubagentHandle): void {
		if (handle.completionSettled) return;
		handle.completionSettled = true;
		handle.updatedAt = now();
		for (const waiter of handle.waiters.splice(0)) {
			if (waiter.timer) clearTimeout(waiter.timer);
			waiter.resolve(handle);
		}
		trimRetainedHandles();
		refreshUi();
	}

	function waitForHandle(handle: SubagentHandle, timeoutMs?: number): Promise<SubagentHandle> {
		if (handle.completionSettled) return Promise.resolve(handle);
		return new Promise((resolve) => {
			const waiter: { resolve: (handle: SubagentHandle) => void; timer?: NodeJS.Timeout } = { resolve };
			if (timeoutMs && timeoutMs > 0) {
				waiter.timer = setTimeout(() => {
					handle.waiters = handle.waiters.filter((value) => value !== waiter);
					resolve(handle);
				}, timeoutMs);
			}
			handle.waiters.push(waiter);
		});
	}

	function sendRpc(proc: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
		try {
			proc.stdin.write(`${JSON.stringify(payload)}\n`);
		} catch {
			// ignore broken pipes; close event will follow
		}
	}

	function bindAbort(signal: AbortSignal | undefined, handle: SubagentHandle, reason: string): void {
		if (!signal) return;
		const abort = () => void killHandle(handle, reason);
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
	}

	function killHandle(handle: SubagentHandle, reason = "Killed by parent"): Promise<SubagentHandle> {
		if (handle.completionSettled || handle.state === "done" || handle.state === "error") {
			return Promise.resolve(handle);
		}

		if (handle.state !== "killed") {
			updateHandle(handle, { state: "killed", error: reason, statusText: reason });
			if (handle.process) {
				sendRpc(handle.process, { type: "abort" });
				setTimeout(() => {
					try {
						handle.process?.kill("SIGTERM");
					} catch {
						// ignore
					}
				}, 1500);
				setTimeout(() => {
					try {
						handle.process?.kill("SIGKILL");
					} catch {
						// ignore
					}
				}, 4000);
			}
		}
		return waitForHandle(handle, 5000);
	}

	async function killAll(reason: string): Promise<void> {
		const active = [...handles.values()].filter(isHandleActive);
		await Promise.allSettled(active.map((handle) => killHandle(handle, reason)));
	}

	function formatHandleSummary(handle: SubagentHandle): string {
		const base = `#${handle.id} ${handle.agent.name} ${handle.state} - ${truncate(handle.task, 70)}`;
		const detail = handle.statusText || truncate(handle.resultText, 90) || truncate(handle.error, 90);
		const usage = formatUsage(handle.usage, handle.model);
		return [base, detail ? `  ${detail}` : "", usage ? `  ${usage}` : ""].filter(Boolean).join("\n");
	}

	function getActiveOrRecentSummary(includeCompleted = true): string {
		const list = sortHandles([...handles.values()]).filter((handle) => includeCompleted || isHandleActive(handle));
		if (list.length === 0) return "No subagents tracked yet.";
		return list.map(formatHandleSummary).join("\n\n");
	}

	function spawnSubagent(agent: AgentConfig, task: string, cwd: string, modelOverride?: string): SubagentHandle {
		const id = createId();
		const selectedModel = agent.model || modelOverride;
		const handle: SubagentHandle = {
			id,
			agent,
			task,
			cwd,
			state: "starting",
			statusText: "Launching…",
			resultText: "",
			stderr: "",
			startedAt: now(),
			updatedAt: now(),
			usage: createUsage(),
			model: selectedModel,
			waiters: [],
		};
		handles.set(handle.id, handle);
		refreshUi();

		const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", childExtensionPath];
		if (selectedModel) args.push("--model", selectedModel);
		if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PI_SUBAGENT_AGENT_NAME: agent.name,
				PI_SUBAGENT_SYSTEM_PROMPT: agent.systemPrompt,
			},
			shell: false,
		});

		handle.process = proc;
		if (typeof proc.pid === "number") updateHandle(handle, { statusText: "Starting RPC session…" });

		let stdoutBuffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}

			if (message.type === "response") {
				if (message.command === "prompt" && message.success === false) {
					updateHandle(handle, { state: "error", error: String(message.error || "Failed to start prompt"), statusText: String(message.error || "Prompt failed") });
				}
				return;
			}

			if (message.type === "agent_start") {
				updateHandle(handle, { state: "running", statusText: "Working…" });
				return;
			}

			if (message.type === "tool_execution_start") {
				const toolName = String(message.toolName || "");
				if (toolName === "update_status") {
					const status = typeof message.args?.message === "string" ? message.args.message : "Working…";
					updateHandle(handle, { state: "running", statusText: status, lastTool: undefined });
				} else {
					updateHandle(handle, { state: "running", lastTool: toolName, statusText: handle.statusText || `Using ${toolName}` });
				}
				return;
			}

			if (message.type === "message_end" && message.message?.role === "assistant") {
				const assistantText = extractText(message.message.content);
				const usage = message.message.usage || {};
				handle.usage.input += usage.input || 0;
				handle.usage.output += usage.output || 0;
				handle.usage.cacheRead += usage.cacheRead || 0;
				handle.usage.cacheWrite += usage.cacheWrite || 0;
				handle.usage.cost += usage.cost?.total || 0;
				handle.usage.turns += 1;
				updateHandle(handle, {
					resultText: assistantText || handle.resultText,
					stopReason: message.message.stopReason || handle.stopReason,
					error: message.message.errorMessage || handle.error,
					model: handle.model || message.message.model,
				});
				return;
			}

			if (message.type === "agent_end") {
				const finalState: SubagentState = handle.state === "error" ? "error" : handle.state === "killed" ? "killed" : "done";
				const finalStatus =
					finalState === "done"
						? truncate(handle.resultText, 96) || "Done"
						: finalState === "killed"
							? handle.error || handle.statusText || "Killed"
							: truncate(handle.error || handle.statusText, 96) || "Finished";
				updateHandle(handle, { state: finalState, statusText: finalStatus });
				settleHandle(handle);
				setTimeout(() => {
					try {
						handle.process?.kill("SIGTERM");
					} catch {
						// ignore
					}
				}, 50);
				setTimeout(() => {
					try {
						handle.process?.kill("SIGKILL");
					} catch {
						// ignore
					}
				}, 1500);
				return;
			}

			if (message.type === "extension_error") {
				handle.stderr += `${message.extensionPath || "extension"}: ${message.error || "Unknown extension error"}\n`;
				updateHandle(handle, { statusText: truncate(String(message.error || "Extension error"), 96) });
			}
		};

		proc.stdout.on("data", (chunk) => {
			stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			while (true) {
				const newlineIndex = stdoutBuffer.indexOf("\n");
				if (newlineIndex === -1) break;
				let line = stdoutBuffer.slice(0, newlineIndex);
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				processLine(line);
			}
		});

		proc.stderr.on("data", (chunk) => {
			handle.stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		});

		proc.on("error", (error) => {
			updateHandle(handle, { state: "error", error: error.message, statusText: error.message });
			settleHandle(handle);
		});

		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer.trim());
			handle.process = undefined;
			handle.exitCode = code ?? 0;
			if (!handle.completionSettled) {
				if (handle.state !== "killed") {
					if ((code ?? 0) === 0 && handle.state !== "error") {
						updateHandle(handle, { state: "done", statusText: truncate(handle.resultText, 96) || "Done" });
					} else {
						const errorText = truncate(handle.error || handle.stderr || `Exited with code ${code ?? 0}`, 120);
						updateHandle(handle, { state: "error", error: errorText, statusText: errorText });
					}
				}
				settleHandle(handle);
			}
		});

		sendRpc(proc, { id: `${id}:prompt`, type: "prompt", message: task });
		return handle;
	}

	function getAgents(ctx: ExtensionContext): ReturnType<typeof discoverAgents> {
		return discoverAgents(ctx.cwd, __dirname);
	}

	function findAgent(ctx: ExtensionContext, agentName: string): { discovery: ReturnType<typeof discoverAgents>; agent?: AgentConfig } {
		const discovery = getAgents(ctx);
		return { discovery, agent: discovery.agents.find((candidate) => candidate.name === agentName) };
	}

	function materializeAgent(
		ctx: ExtensionContext,
		spec: TaskSpec,
	): { discovery: ReturnType<typeof discoverAgents>; agent?: AgentConfig; error?: string } {
		const discovery = getAgents(ctx);
		const base = spec.agent ? discovery.agents.find((candidate) => candidate.name === spec.agent) : undefined;
		if (spec.agent && !base) {
			return {
				discovery,
				error: `Unknown subagent: ${spec.agent}`,
			};
		}

		const defaultPrompt = `You are an ad hoc delegated subagent working in an isolated context.
- Stay tightly scoped to the assigned task.
- Be concise and high-signal.
- Use tools as needed, but avoid unnecessary work.
- Return a definitive answer useful to the parent agent.`;
		const mergedPrompt = [base?.systemPrompt || defaultPrompt, spec.systemPrompt || ""].filter(Boolean).join("\n\n");
		const agent: AgentConfig = {
			name: spec.name || base?.name || "adhoc",
			description: base?.description || "Ad hoc delegated subagent",
			tools: spec.tools && spec.tools.length > 0 ? spec.tools : base?.tools,
			model: spec.model || base?.model,
			systemPrompt: mergedPrompt,
			source: base?.source || "builtin",
			filePath: base?.filePath || "(ad hoc)",
		};
		return { discovery, agent };
	}

	function materializeValidatedAgent(
		ctx: ExtensionContext,
		spec: TaskSpec,
	): { discovery: ReturnType<typeof discoverAgents>; agent?: AgentConfig; error?: string } {
		const result = materializeAgent(ctx, spec);
		if (!result.agent?.model) return result;
		const resolvedModel = resolveKnownModel(ctx, result.agent.model);
		if (!resolvedModel.ref) {
			return { discovery: result.discovery, error: resolvedModel.error || "Invalid model override" };
		}
		return { discovery: result.discovery, agent: { ...result.agent, model: resolvedModel.ref } };
	}

	async function waitForAll(handlesToWait: SubagentHandle[], timeoutMs?: number): Promise<SubagentHandle[]> {
		return Promise.all(handlesToWait.map((handle) => waitForHandle(handle, timeoutMs)));
	}

	pi.on("session_start", async (_event, ctx) => {
		rememberContext(ctx);
		refreshUi();
	});

	pi.on("session_switch", async (_event, ctx) => {
		rememberContext(ctx);
		await killAll("Session switched");
		handles.clear();
		refreshUi();
	});

	pi.on("session_fork", async (_event, ctx) => {
		rememberContext(ctx);
		await killAll("Session forked");
		handles.clear();
		refreshUi();
	});

	pi.on("session_shutdown", async () => {
		await killAll("Parent session shutting down");
	});

	pi.on("agent_end", async (event, ctx) => {
		rememberContext(ctx);
		const lastAssistant = [...event.messages].reverse().find(isAbortedAssistantMessage);
		if (!lastAssistant) return;
		await killAll("Parent agent aborted");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		rememberContext(ctx);
		const discovery = getAgents(ctx);
		const guidance = `\n\nSubagent extension is available.
Do not use subagent_run or subagent_start unless the user explicitly asks you to delegate work to a subagent or spawn one.
Use subagent_list, subagent_wait, and subagent_kill to inspect or control background subagents when relevant.
Use subagent_models to inspect the exact model ids accepted by subagent model overrides in this session.
A subagent call may either reference a predefined agent via {agent: "name", ...} or be ad hoc by omitting agent and providing task plus optional systemPrompt/tools/model overrides.
Per-call model overrides are supported via model: "provider/model-id".
Available predefined subagents:\n${formatAgentList(discovery.agents, 20)}`;
		return { systemPrompt: event.systemPrompt + guidance };
	});

	pi.registerTool({
		name: "subagent_models",
		label: "Subagent Models",
		description: "List the exact model ids accepted by subagent model overrides in this session, and whether they are available here.",
		promptSnippet: "Inspect the exact model ids accepted by subagent model overrides before setting one.",
		promptGuidelines: [
			"Use subagent_models before setting a subagent model override when you are not sure which exact model ids are accepted.",
			"Prefer available models from subagent_models; unavailable ones will be rejected for subagent launches.",
		],
		parameters: ModelsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberContext(ctx);
			const includeUnavailable = params.includeUnavailable ?? true;
			const search = params.search?.trim().toLowerCase();
			let models = getKnownModels(ctx).filter((model) => includeUnavailable || model.available);
			if (search) {
				models = models.filter(
					(model) =>
						model.ref.toLowerCase().includes(search) ||
						model.name.toLowerCase().includes(search) ||
						model.provider.toLowerCase().includes(search) ||
						model.id.toLowerCase().includes(search),
				);
			}
			if (models.length === 0) {
				const scope = includeUnavailable ? "known" : "available";
				const suffix = search ? ` matching \"${params.search}\"` : "";
				return {
					content: [{ type: "text", text: `No ${scope} subagent models found${suffix}.` }],
					details: { models: [] },
				};
			}

			const availableCount = models.filter((model) => model.available).length;
			const lines = [
				`${models.length} model${models.length === 1 ? "" : "s"} (${availableCount} available)`,
				...models.map((model) => {
					const flags = [model.available ? "available" : "unavailable", model.reasoning ? "reasoning" : undefined, model.input.includes("image") ? "image" : undefined]
						.filter(Boolean)
						.join(", ");
					return `${model.available ? "✓" : "·"} ${model.ref}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}${flags ? ` (${flags})` : ""}`;
				}),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { models },
			};
		},
	});

	pi.registerTool({
		name: "subagent_run",
		label: "Subagent Run",
		description:
			"Run one focused subagent task, a small parallel swarm, or a sequential chain. Only use this when the user explicitly asks you to delegate work to a subagent or spawn one.",
		promptSnippet: "Only when the user explicitly asks, delegate work to a specialized subagent or small swarm.",
		promptGuidelines: [
			"Do not use subagent_run unless the user explicitly asks for delegation, a subagent, or a swarm.",
			"Use tasks[] for small independent swarms, and chain[] for stepwise handoffs using {previous}.",
			"Use subagent_models before setting a child model override when you are unsure which exact model ids are accepted.",
			"You can override the child model per call with model: \"provider/model-id\".",
			"For ad hoc subagents, omit agent and provide task plus optional systemPrompt, tools, and model.",
		],
		parameters: RunSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			rememberContext(ctx);

			const parentModel = getModelCliArg(ctx);

			if (typeof params.task === "string" && !Array.isArray(params.tasks) && !Array.isArray(params.chain)) {
				const { discovery, agent, error } = materializeValidatedAgent(ctx, params as TaskSpec);
				if (!agent) {
					return {
						content: [{ type: "text", text: `${error || "Invalid subagent spec"}\n\nAvailable subagents:\n${formatAgentList(discovery.agents)}` }],
						details: { availableAgents: discovery.agents.map((value) => value.name) },
					};
				}

				const handle = spawnSubagent(agent, params.task, params.cwd || ctx.cwd, parentModel);
				bindAbort(signal, handle, "Caller aborted subagent_run");
				const result = await waitForHandle(handle);
				return {
					content: [{ type: "text", text: result.resultText || result.error || "(no output)" }],
					details: { handles: [serializeHandle(result)] },
				};
			}

			if (Array.isArray(params.tasks) && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: {},
					};
				}

				const discovery = getAgents(ctx);
				const materialized = (params.tasks as TaskSpec[]).map((task) => materializeValidatedAgent(ctx, task));
				const failures = materialized.filter((value) => !value.agent);
				if (failures.length > 0) {
					return {
						content: [{ type: "text", text: `${failures.map((value) => value.error || "Invalid subagent spec").join("\n")}\n\nAvailable subagents:\n${formatAgentList(discovery.agents)}` }],
						details: {},
					};
				}

				const spawned = await mapWithConcurrencyLimit(params.tasks as TaskSpec[], MAX_CONCURRENCY, async (task, index) => {
					if (signal?.aborted) throw new Error("Caller aborted subagent swarm");
					const agent = materialized[index]!.agent!;
					const handle = spawnSubagent(agent, task.task, task.cwd || ctx.cwd, parentModel);
					bindAbort(signal, handle, "Caller aborted subagent swarm");
					return waitForHandle(handle);
				});

				const summary = spawned
					.map((handle) => `[${handle.agent.name} #${handle.id}] ${handle.state}: ${truncate(handle.resultText || handle.error || handle.statusText, 120)}`)
					.join("\n");
				return {
					content: [{ type: "text", text: summary || "Parallel swarm finished." }],
					details: { handles: spawned.map(serializeHandle) },
				};
			}

			const discovery = getAgents(ctx);
			const chain = Array.isArray(params.chain) ? (params.chain as TaskSpec[]) : [];
			if (chain.length === 0) {
				return {
					content: [{ type: "text", text: `Invalid subagent_run call. Provide either {agent, task}, {tasks:[...]}, or {chain:[...]}.\n\nAvailable subagents:\n${formatAgentList(discovery.agents)}` }],
					details: {},
				};
			}
			const results: SubagentHandle[] = [];
			let previous = "";
			for (let i = 0; i < chain.length; i++) {
				const step = chain[i]!;
				const { discovery: currentDiscovery, agent, error } = materializeValidatedAgent(ctx, step);
				if (!agent) {
					return {
						content: [{ type: "text", text: `${error || `Invalid chain step ${i + 1}`}\n\nAvailable subagents:\n${formatAgentList(currentDiscovery.agents)}` }],
						details: { handles: results.map(serializeHandle) },
					};
				}
				const task = step.task.replace(/\{previous\}/g, previous);
				const handle = spawnSubagent(agent, task, step.cwd || ctx.cwd, parentModel);
				bindAbort(signal, handle, "Caller aborted subagent chain");
				const result = await waitForHandle(handle);
				results.push(result);
				if (result.state !== "done") {
					return {
						content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${result.error || result.statusText}` }],
						details: { handles: results.map(serializeHandle) },
					};
				}
				previous = result.resultText;
			}

			return {
				content: [{ type: "text", text: results[results.length - 1]?.resultText || "Chain finished." }],
				details: { handles: results.map(serializeHandle) },
			};
		},
	});

	pi.registerTool({
		name: "subagent_start",
		label: "Subagent Start",
		description: "Start a background subagent and return immediately with its id. Only use this when the user explicitly asks you to spawn a background subagent.",
		promptSnippet: "Only when the user explicitly asks, start a background subagent and return its id.",
		promptGuidelines: ["Do not use subagent_start unless the user explicitly asks for a background subagent."],
		parameters: SingleSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberContext(ctx);
			const { discovery, agent, error } = materializeValidatedAgent(ctx, params as TaskSpec);
			if (!agent) {
				return {
					content: [{ type: "text", text: `${error || "Invalid subagent spec"}\n\nAvailable subagents:\n${formatAgentList(discovery.agents)}` }],
					details: {},
				};
			}
			const handle = spawnSubagent(agent, params.task, params.cwd || ctx.cwd, getModelCliArg(ctx));
			return {
				content: [{ type: "text", text: `Started subagent #${handle.id} (${agent.name}).` }],
				details: { handle: serializeHandle(handle) },
			};
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: "List tracked subagents and their current status.",
		parameters: ListSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberContext(ctx);
			const summary = getActiveOrRecentSummary(params.includeCompleted ?? true);
			return {
				content: [{ type: "text", text: summary }],
				details: { handles: sortHandles([...handles.values()]).map(serializeHandle) },
			};
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description: "Wait for a background subagent, or all active subagents, to finish.",
		parameters: WaitSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			rememberContext(ctx);
			let targets: SubagentHandle[] = [];
			if (params.id) {
				const handle = handles.get(params.id);
				if (!handle) {
					return { content: [{ type: "text", text: `Unknown subagent id: ${params.id}` }], details: {} };
				}
				targets = [handle];
			} else {
				targets = [...handles.values()].filter(isHandleActive);
				if (targets.length === 0) {
					return {
						content: [{ type: "text", text: "No active subagents to wait for." }],
						details: { handles: sortHandles([...handles.values()]).map(serializeHandle) },
					};
				}
			}
			if (signal) {
				const abort = () => {
					for (const handle of targets) void killHandle(handle, "Caller aborted subagent_wait");
				};
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
			const results = await waitForAll(targets, params.timeoutMs);
			return {
				content: [{ type: "text", text: results.map(formatHandleSummary).join("\n\n") }],
				details: { handles: results.map(serializeHandle) },
			};
		},
	});

	pi.registerTool({
		name: "subagent_kill",
		label: "Subagent Kill",
		description: "Abort a running background subagent.",
		parameters: KillSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			rememberContext(ctx);
			const handle = handles.get(params.id);
			if (!handle) {
				return { content: [{ type: "text", text: `Unknown subagent id: ${params.id}` }], details: {} };
			}
			const result = await killHandle(handle, "Killed via subagent_kill");
			return {
				content: [{ type: "text", text: `Killed subagent #${result.id} (${result.agent.name}).` }],
				details: { handle: serializeHandle(result) },
			};
		},
	});

	pi.registerCommand("subagents", {
		description: "Show tracked subagent status",
		handler: async (_args, ctx) => {
			rememberContext(ctx);
			ctx.ui.notify(getActiveOrRecentSummary(true), "info");
		},
	});

	pi.registerCommand("subagents-toggle", {
		description: "Toggle the subagent widget",
		handler: async (_args, ctx) => {
			rememberContext(ctx);
			widgetVisible = !widgetVisible;
			refreshUi();
			ctx.ui.notify(`Subagent widget ${widgetVisible ? "enabled for active subagents" : "disabled"}.`, "info");
		},
	});

	pi.registerCommand("subagents-kill-all", {
		description: "Kill all running subagents",
		handler: async (_args, ctx) => {
			rememberContext(ctx);
			await killAll("Killed via /subagents-kill-all");
			ctx.ui.notify("Killed all running subagents.", "warning");
		},
	});
}
