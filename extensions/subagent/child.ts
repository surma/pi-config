import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	type ChildFrame,
	IPC_SCHEMA_VERSION,
	type ParentFrame,
	type SessionReason,
	type ShutdownReason,
} from "./ipc.js";
import { connectChild, type IpcChildConnector } from "./ipc-child.js";

const childId = process.env.PI_SUBAGENT_CHILD_ID ?? "";
const socketPath = process.env.BRIDGE_SOCKET_PATH;
const bridgeLogPath = process.env.BRIDGE_LOG_PATH;
const ownerSessionFile = process.env.PI_SUBAGENT_OWNER_SESSION_FILE || "";
const ownerSessionId = process.env.PI_SUBAGENT_OWNER_SESSION_ID || "";
const launchControllerInstanceId =
	process.env.PI_SUBAGENT_CONTROLLER_INSTANCE_ID || "";
const incarnation = process.env.PI_SUBAGENT_INCARNATION || "";
const delegatedPrompt = process.env.PI_SUBAGENT_SYSTEM_PROMPT || "";
const promptPath = process.env.PI_SUBAGENT_PROMPT_PATH;
const subagentDepth = Math.max(
	1,
	Number.parseInt(process.env.PI_SUBAGENT_DEPTH || "1", 10) || 1,
);
const LOG_MAX_BYTES = 1024 * 1024;
interface PersistentBridgeState {
	sessionId?: string;
	runId: number;
	runState: "idle" | "running" | "retrying" | "finishing";
	runOutcome: "pending" | "succeeded" | "failed" | "aborted";
	stopReason?: string;
	errorMessage?: string;
	currentTool?: string;
	isStreaming: boolean;
	assistantTail: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
}
const persistentStatesKey = Symbol.for("pi.subagent.bridgeStates");
const globalWithBridgeStates = globalThis as typeof globalThis & {
	[persistentStatesKey]?: Map<string, PersistentBridgeState>;
};
const existingPersistentStates = globalWithBridgeStates[persistentStatesKey];
const persistentStates: Map<string, PersistentBridgeState> =
	existingPersistentStates ?? new Map();
if (!existingPersistentStates)
	globalWithBridgeStates[persistentStatesKey] = persistentStates;

async function captureEffectivePrompt(prompt: string): Promise<void> {
	if (!promptPath) return;
	try {
		await fs.mkdir(dirname(promptPath), { recursive: true, mode: 0o700 });
		await fs.chmod(dirname(promptPath), 0o700).catch(() => {});
		await fs.writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
		await fs.chmod(promptPath, 0o600).catch(() => {});
	} catch (error) {
		process.stderr.write(
			`Failed to capture Pi effective system prompt: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function appendDebug(value: unknown): Promise<void> {
	if (!bridgeLogPath) return;
	try {
		await fs.mkdir(dirname(bridgeLogPath), { recursive: true, mode: 0o700 });
		const stat = await fs.stat(bridgeLogPath).catch(() => undefined);
		if (stat && stat.size > LOG_MAX_BYTES) await fs.truncate(bridgeLogPath, 0);
		await fs.appendFile(bridgeLogPath, `${JSON.stringify(value)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch {
		/* Debug logging is never authoritative. */
	}
}

export default function childSubagentExtension(pi: ExtensionAPI) {
	let connector: IpcChildConnector | undefined;
	let context: ExtensionContext | undefined;
	let sessionReason: SessionReason = "startup";
	const persisted = persistentStates.get(childId) || {
		runId: 0,
		runState: "idle" as const,
		runOutcome: "pending" as const,
		isStreaming: false,
		assistantTail: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
		},
	};
	persistentStates.set(childId, persisted);
	let runId = Math.max(
		persisted.runId,
		Number.parseInt(process.env.PI_SUBAGENT_RUN_ID_BASE || "0", 10) || 0,
	);
	let runState = persisted.runState;
	let runOutcome = persisted.runOutcome;
	let stopReason = persisted.stopReason;
	let errorMessage = persisted.errorMessage;
	let currentTool = persisted.currentTool;
	let isStreaming = persisted.isStreaming;
	let assistantTail = persisted.assistantTail;
	const usage = { ...persisted.usage };
	const syncPersistent = () =>
		Object.assign(persisted, {
			runId,
			runState,
			runOutcome,
			stopReason,
			errorMessage,
			currentTool,
			isStreaming,
			assistantTail,
			usage: { ...usage },
		});

	const base = <T extends ChildFrame["type"]>(type: T) => ({
		type,
		schemaVersion: IPC_SCHEMA_VERSION as 1,
		childId,
		connectionId: connector?.connectionId || "",
		at: Date.now(),
		ownerSessionFile,
		ownerSessionId,
		launchControllerInstanceId,
		incarnation,
	});
	const send = (frame: ChildFrame) => {
		connector?.send(frame);
		void appendDebug({ direction: "out", frame });
	};
	const sessionInfo = () => ({
		sessionId: context?.sessionManager.getSessionId() || "",
		sessionFile: context?.sessionManager.getSessionFile() || "",
	});
	const hello = () => {
		if (!context) return;
		const info = sessionInfo();
		send({
			...base("hello"),
			type: "hello",
			...info,
			sessionFileExists: !!info.sessionFile && existsSync(info.sessionFile),
			pid: process.pid,
			model: context.model
				? {
						provider: context.model.provider,
						id: context.model.id,
						name: context.model.name,
					}
				: null,
			thinkingLevel: pi.getThinkingLevel(),
			reason: sessionReason,
		});
	};
	const snapshot = (ackId?: string) => {
		if (!context) return;
		send({
			...base("snapshot"),
			type: "snapshot",
			...sessionInfo(),
			ackId,
			runState,
			runId,
			runOutcome,
			stopReason,
			errorMessage,
			currentTool,
			isStreaming,
			assistantTail,
			usage: { ...usage },
			updatedAt: Date.now(),
		});
	};
	const event = (
		name: string,
		payload: Record<string, unknown> = {},
		scoped = true,
	) => {
		send({
			...base("event"),
			type: "event",
			event: name,
			...(scoped ? { runId } : {}),
			...payload,
		});
	};
	const ensureConnector = () => {
		if (connector || !socketPath) return;
		connector = connectChild(socketPath, {
			diagnostic: (message) =>
				void appendDebug({ diagnostic: message, at: Date.now() }),
		});
		connector.onConnect(() => {
			hello();
			snapshot();
		});
		connector.onFrame((frame: ParentFrame) => {
			void appendDebug({ direction: "in", frame });
			if (frame.type === "ping") {
				send({ ...base("pong"), type: "pong", id: frame.id });
				return;
			}
			if (frame.type === "snapshot") {
				snapshot(frame.id);
				return;
			}
			if (frame.type !== "send") return;
			const queued = context ? !context.isIdle() : true;
			try {
				pi.sendUserMessage(frame.content, { deliverAs: frame.deliverAs });
				send({ ...base("ack"), type: "ack", id: frame.id, ok: true, queued });
			} catch (error) {
				send({
					...base("ack"),
					type: "ack",
					id: frame.id,
					ok: false,
					queued,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	};

	pi.on("session_start", async (rawEvent, ctx) => {
		context = ctx;
		sessionReason = (rawEvent?.reason || "startup") as SessionReason;
		const nextSessionId = ctx.sessionManager.getSessionId();
		if (
			(persisted.sessionId && persisted.sessionId !== nextSessionId) ||
			sessionReason === "new" ||
			sessionReason === "resume"
		) {
			runState = "idle";
			runOutcome = "pending";
			stopReason = undefined;
			errorMessage = undefined;
			currentTool = undefined;
			isStreaming = false;
			assistantTail = "";
		}
		persisted.sessionId = nextSessionId;
		syncPersistent();
		ensureConnector();
		// A duplicate session_start on the same connection is intentionally harmless;
		// the parent deduplicates hello by child connectionId.
		hello();
		if (sessionReason === "reload" || sessionReason === "resume") snapshot();
	});
	pi.on("before_agent_start", async (rawEvent) => {
		const sections = [rawEvent.systemPrompt];
		if (delegatedPrompt.trim())
			sections.push(`Direct delegated guidance:\n${delegatedPrompt.trim()}`);
		sections.push(`Subagent execution rules:
- You are handling a delegated subtask for a parent agent.
- You are a subagent, not the top-level agent.
- Stay tightly scoped to the assigned task and return a definitive result.
- Prefer concise, high-signal findings over long narration.
- Never call subagent_start from within a subagent. Nested delegation is disabled. If further delegation seems necessary, tell the parent agent instead.
- Your final answer should be useful to another agent that did not watch your full work.
- Current delegated depth: ${subagentDepth}`);
		return { systemPrompt: sections.filter(Boolean).join("\n\n") };
	});
	pi.on("agent_start", async (_rawEvent, ctx) => {
		context = ctx;
		runId++;
		runState = "running";
		runOutcome = "pending";
		stopReason = errorMessage = undefined;
		syncPersistent();
		await captureEffectivePrompt(ctx.getSystemPrompt());
		event("agent_start");
	});
	pi.on("agent_end", async (rawEvent) => {
		const eventDetails = rawEvent as unknown as Record<string, unknown>;
		const willRetry = eventDetails.willRetry === true;
		runState = willRetry ? "retrying" : "finishing";
		syncPersistent();
		event("agent_end", { willRetry, messages: rawEvent.messages });
	});
	pi.on("agent_settled", async (rawEvent) => {
		const eventDetails = rawEvent as unknown as Record<string, unknown>;
		runState = "idle";
		stopReason =
			typeof eventDetails.stopReason === "string"
				? eventDetails.stopReason
				: stopReason;
		errorMessage =
			typeof eventDetails.errorMessage === "string"
				? eventDetails.errorMessage
				: errorMessage;
		const reportedOutcome = eventDetails.runOutcome;
		runOutcome =
			reportedOutcome === "succeeded" ||
			reportedOutcome === "failed" ||
			reportedOutcome === "aborted"
				? reportedOutcome
				: stopReason === "aborted"
					? "aborted"
					: errorMessage || stopReason === "error"
						? "failed"
						: "succeeded";
		syncPersistent();
		event("agent_settled", { runOutcome, stopReason, errorMessage });
		snapshot();
		// Deliberately no ctx.shutdown(): settlement ends a run, not the child process.
	});
	type MessageEventName = "message_start" | "message_update" | "message_end";
	type MessageBridgeEvent = {
		message: unknown;
		assistantMessageEvent?: { type?: unknown };
	};
	const onMessageEvent = pi.on as unknown as (
		name: MessageEventName,
		handler: (rawEvent: MessageBridgeEvent) => Promise<void>,
	) => void;
	for (const name of [
		"message_start",
		"message_update",
		"message_end",
	] as const) {
		onMessageEvent(name, async (rawEvent) => {
			const message = isRecord(rawEvent.message) ? rawEvent.message : undefined;
			if (!message) return;
			if (message.role === "assistant") {
				const text = Array.isArray(message.content)
					? message.content
							.map((part) =>
								isRecord(part) &&
								part.type === "text" &&
								typeof part.text === "string"
									? part.text
									: "",
							)
							.join("")
					: "";
				if (text) assistantTail = text.slice(-64 * 1024);
				isStreaming =
					name !== "message_end" &&
					rawEvent.assistantMessageEvent?.type !== "done" &&
					rawEvent.assistantMessageEvent?.type !== "error";
				if (name === "message_end") {
					const messageUsage = isRecord(message.usage) ? message.usage : {};
					const messageCost = isRecord(messageUsage.cost)
						? messageUsage.cost
						: {};
					usage.input += Number(messageUsage.input) || 0;
					usage.output += Number(messageUsage.output) || 0;
					usage.cacheRead += Number(messageUsage.cacheRead) || 0;
					usage.cacheWrite += Number(messageUsage.cacheWrite) || 0;
					usage.cost += Number(messageCost.total) || 0;
					usage.turns++;
					stopReason =
						typeof message.stopReason === "string"
							? message.stopReason
							: stopReason;
					errorMessage =
						typeof message.errorMessage === "string"
							? message.errorMessage
							: errorMessage;
				}
			}
			syncPersistent();
			event(name, {
				message,
				assistantMessageEvent: rawEvent.assistantMessageEvent,
			});
		});
	}
	pi.on("tool_execution_start", async (rawEvent) => {
		currentTool = rawEvent.toolName;
		syncPersistent();
		event("tool_execution_start", {
			toolCallId: rawEvent.toolCallId,
			toolName: rawEvent.toolName,
			args: rawEvent.args,
		});
	});
	pi.on("tool_execution_update", async (rawEvent) =>
		event("tool_execution_update", {
			toolCallId: rawEvent.toolCallId,
			partialResult: rawEvent.partialResult,
		}),
	);
	pi.on("tool_execution_end", async (rawEvent) => {
		if (currentTool === rawEvent.toolName) currentTool = undefined;
		syncPersistent();
		event("tool_execution_end", {
			toolCallId: rawEvent.toolCallId,
			toolName: rawEvent.toolName,
			result: rawEvent.result,
			isError: rawEvent.isError,
		});
	});
	type ExtensionErrorEvent = { extensionPath?: string; error?: unknown };
	const onExtensionError = pi.on as unknown as (
		name: "extension_error",
		handler: (rawEvent: ExtensionErrorEvent) => Promise<void>,
	) => void;
	onExtensionError("extension_error", async (rawEvent) =>
		event(
			"extension_error",
			{
				extensionPath: rawEvent.extensionPath,
				error: String(rawEvent.error || "Unknown extension error"),
			},
			false,
		),
	);
	pi.on("session_shutdown", async (rawEvent) => {
		const reason = (rawEvent?.reason || "quit") as ShutdownReason;
		event("session_shutdown", { reason }, false);
		send({ ...base("bye"), type: "bye", reason });
		connector?.close();
		connector = undefined;
	});
}
