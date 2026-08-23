import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { persistRunResult } from "./result-store.js";

const childId = process.env.PI_SUBAGENT_CHILD_ID ?? "";
const incarnation = process.env.PI_SUBAGENT_INCARNATION || "";
const delegatedPrompt = process.env.PI_SUBAGENT_SYSTEM_PROMPT || "";
const promptPath = process.env.PI_SUBAGENT_PROMPT_PATH;
const sessionDir = process.env.PI_SUBAGENT_SESSION_DIR;
const subagentDepth = Math.max(
	1,
	Number.parseInt(process.env.PI_SUBAGENT_DEPTH || "1", 10) || 1,
);

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

export default function childSubagentExtension(pi: ExtensionAPI) {
	let runId = 0;
	let runOutcome: "pending" | "succeeded" | "failed" | "aborted" = "pending";
	let resultText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;

	pi.on("session_start", async (_rawEvent, ctx: ExtensionContext) => {
		// Capture the effective system prompt (as known at session start).
		// The before_agent_start hook will update it before the agent runs.
		await captureEffectivePrompt(ctx.getSystemPrompt());
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

	pi.on("agent_start", async (_rawEvent, ctx: ExtensionContext) => {
		runId++;
		runOutcome = "pending";
		stopReason = errorMessage = undefined;
		resultText = "";
		// Capture the effective system prompt after before_agent_start has run.
		await captureEffectivePrompt(ctx.getSystemPrompt());
	});

	// Track the final assistant message text for persistence.
	type MessageEventName = "message_end";
	type MessageBridgeEvent = { message: unknown };
	const onMessageEnd = pi.on as unknown as (
		name: MessageEventName,
		handler: (rawEvent: MessageBridgeEvent) => Promise<void>,
	) => void;
	onMessageEnd("message_end", async (rawEvent) => {
		const message = isRecord(rawEvent.message) ? rawEvent.message : undefined;
		if (!message || message.role !== "assistant") return;
		const text = Array.isArray(message.content)
			? message.content
					.map((part) =>
						isRecord(part) &&
						part.type === "text" &&
						typeof part.text === "string"
							? part.text
							: "",
					)
					.filter(Boolean)
					.join("\n")
			: "";
		if (text) resultText = text;
		if (typeof message.stopReason === "string") stopReason = message.stopReason;
		if (typeof message.errorMessage === "string")
			errorMessage = message.errorMessage;
	});

	pi.on("agent_settled", async (rawEvent) => {
		const eventDetails = rawEvent as unknown as Record<string, unknown>;
		if (typeof eventDetails.stopReason === "string")
			stopReason = eventDetails.stopReason;
		if (typeof eventDetails.errorMessage === "string")
			errorMessage = eventDetails.errorMessage;
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

		if (sessionDir) {
			try {
				await persistRunResult(sessionDir, {
					runId,
					outcome: runOutcome,
					incarnation,
					settledAt: Date.now(),
					result: resultText,
				});
			} catch (error) {
				process.stderr.write(
					`Failed to persist exact result for run ${runId}: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		}
		// No ctx.shutdown(): settlement ends a run, not the child process.
	});
}

// Suppress the unused variable warning for childId — it is part of the env
// contract used by the parent controller for bookkeeping, not by this code.
void childId;
