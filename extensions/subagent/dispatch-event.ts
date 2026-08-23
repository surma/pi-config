import {
	abortRun,
	corroborateRun,
	currentRun,
	endRun,
	isLifecycleTerminal,
	type LifecycleState,
	recordAssistantEnd,
	type SubagentRun,
	settleRunToIdle,
	startRun,
} from "./lifecycle.js";
import {
	type AssistantLiveState,
	assistantMessageMatchesFinalized,
	finalizeAssistantMessage,
	startAssistantMessage,
	type ToolActivity,
	updateAssistantMessage,
	updateToolActivity,
} from "./live-state.js";

export interface SubagentUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

// Independent from active display state so delayed prior-run records remain inert.
const MAX_KNOWN_TOOL_CALL_IDS = 256;

export interface SubagentDispatchHandle
	extends LifecycleState,
		AssistantLiveState {
	agentStartedAt?: number;
	agentEndedAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	lastTool?: string;
	activeTools: Map<string, ToolActivity>;
	recentTools: ToolActivity[];
	knownToolCallIds: string[];
	isStreaming: boolean;
	usage: SubagentUsageStats;
	stopReason?: string;
	error?: string;
	abortRequestedAt?: number;
	completionSettled: boolean;
}

export interface SubagentDispatchOptions {
	now: () => number;
	assistantDisplayMax: number;
	toolOutputTailMax: number;
	maxRecentTools: number;
	update: (streaming?: boolean) => void;
	diagnostic: (message: string) => void;
	onAssistantFinalized: () => void;
	onSettled: (run: SubagentRun) => void;
}

function cloneToolActivity(tool: ToolActivity): ToolActivity {
	return { ...tool };
}

function updateCurrentTool(handle: SubagentDispatchHandle): void {
	const latest = [...handle.activeTools.values()].sort(
		(a, b) => b.startedAt - a.startedAt,
	)[0];
	handle.currentTool = latest?.name;
	handle.currentToolStartedAt = latest?.startedAt;
}

function rememberNewToolCallId(
	handle: SubagentDispatchHandle,
	toolCallId: string,
): boolean {
	if (handle.knownToolCallIds.includes(toolCallId)) return false;
	handle.knownToolCallIds.push(toolCallId);
	if (handle.knownToolCallIds.length > MAX_KNOWN_TOOL_CALL_IDS) {
		handle.knownToolCallIds.splice(
			0,
			handle.knownToolCallIds.length - MAX_KNOWN_TOOL_CALL_IDS,
		);
	}
	return true;
}

function diagnoseInactiveToolRecord(
	handle: SubagentDispatchHandle,
	options: SubagentDispatchOptions,
	type: "tool_execution_update" | "tool_execution_end",
	toolCallId: string,
): false {
	const reason = handle.knownToolCallIds.includes(toolCallId)
		? "duplicate or delayed"
		: "out-of-order unknown";
	options.diagnostic(`Ignored ${reason} ${type} for inactive toolCallId.`);
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function updateUsage(
	handle: SubagentDispatchHandle,
	message: Record<string, unknown>,
): void {
	const usage = isRecord(message.usage) ? message.usage : {};
	const cost = isRecord(usage.cost) ? usage.cost : {};
	handle.usage.input += Number(usage.input) || 0;
	handle.usage.output += Number(usage.output) || 0;
	handle.usage.cacheRead += Number(usage.cacheRead) || 0;
	handle.usage.cacheWrite += Number(usage.cacheWrite) || 0;
	handle.usage.cost += Number(cost.total) || 0;
	handle.usage.turns += 1;
}

function latestAssistantMessage(
	messages: unknown,
): Record<string, unknown> | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message &&
			typeof message === "object" &&
			(message as { role?: unknown }).role === "assistant"
		) {
			return message as Record<string, unknown>;
		}
	}
	return undefined;
}

function ignoreTerminal(options: SubagentDispatchOptions, type: string): false {
	options.diagnostic(`Ignored late ${type} after terminal settlement.`);
	return false;
}

function requireActiveRun(
	handle: SubagentDispatchHandle,
	options: SubagentDispatchOptions,
	type: string,
): boolean {
	if (currentRun(handle)?.phase === "active") return true;
	options.diagnostic(
		`Ignored out-of-order ${type} without an active current run.`,
	);
	return false;
}

/** Dispatch one typed companion event into the production subagent state machine. */
export function dispatchSubagentEvent(
	handle: SubagentDispatchHandle,
	record: Record<string, unknown>,
	options: SubagentDispatchOptions,
): boolean {
	const at = options.now();
	switch (record.type) {
		case "agent_start": {
			if (isLifecycleTerminal(handle))
				return ignoreTerminal(options, "agent_start");
			const run = startRun(
				handle,
				at,
				typeof record.runId === "number" ? record.runId : undefined,
			);
			if (!run) {
				options.diagnostic(
					"Ignored duplicate agent_start while the current run is active.",
				);
				return false;
			}
			handle.abortRequestedAt = undefined;
			handle.agentStartedAt ||= at;
			handle.agentEndedAt = undefined;
			handle.resultText = "";
			handle.activeTools.clear();
			updateCurrentTool(handle);
			options.update();
			return true;
		}
		case "tool_execution_start": {
			if (isLifecycleTerminal(handle))
				return ignoreTerminal(options, "tool_execution_start");
			if (
				typeof record.toolCallId !== "string" ||
				typeof record.toolName !== "string"
			) {
				options.diagnostic(
					"Ignored malformed tool_execution_start without toolCallId/toolName.",
				);
				return false;
			}
			if (!requireActiveRun(handle, options, "tool_execution_start"))
				return false;
			if (!rememberNewToolCallId(handle, record.toolCallId)) {
				options.diagnostic(
					"Ignored duplicate or delayed tool_execution_start for a previously seen toolCallId.",
				);
				return false;
			}
			corroborateRun(handle);
			handle.activeTools.set(record.toolCallId, {
				toolCallId: record.toolCallId,
				name: record.toolName,
				startedAt: at,
				updatedAt: at,
				output: "",
				outputTruncated: false,
			});
			updateCurrentTool(handle);
			options.update();
			return true;
		}
		case "tool_execution_update": {
			if (isLifecycleTerminal(handle))
				return ignoreTerminal(options, "tool_execution_update");
			if (typeof record.toolCallId !== "string") return false;
			if (!requireActiveRun(handle, options, "tool_execution_update"))
				return false;
			const tool = handle.activeTools.get(record.toolCallId);
			if (!tool)
				return diagnoseInactiveToolRecord(
					handle,
					options,
					"tool_execution_update",
					record.toolCallId,
				);
			corroborateRun(handle);
			updateToolActivity(
				tool,
				record.partialResult,
				options.toolOutputTailMax,
				at,
			);
			updateCurrentTool(handle);
			options.update(true);
			return true;
		}
		case "tool_execution_end": {
			if (isLifecycleTerminal(handle))
				return ignoreTerminal(options, "tool_execution_end");
			if (typeof record.toolCallId !== "string") return false;
			if (!requireActiveRun(handle, options, "tool_execution_end"))
				return false;
			const tool = handle.activeTools.get(record.toolCallId);
			if (!tool)
				return diagnoseInactiveToolRecord(
					handle,
					options,
					"tool_execution_end",
					record.toolCallId,
				);
			corroborateRun(handle);
			updateToolActivity(tool, record.result, options.toolOutputTailMax, at);
			tool.endedAt = at;
			tool.isError = record.isError === true;
			handle.activeTools.delete(record.toolCallId);
			handle.recentTools.push(cloneToolActivity(tool));
			if (handle.recentTools.length > options.maxRecentTools) {
				handle.recentTools.splice(
					0,
					handle.recentTools.length - options.maxRecentTools,
				);
			}
			handle.lastTool = tool.name;
			updateCurrentTool(handle);
			options.update();
			return true;
		}
		case "message_start": {
			if (isLifecycleTerminal(handle))
				return ignoreTerminal(options, "message_start");
			const message = record.message as Record<string, unknown> | undefined;
			if (message?.role !== "assistant") return false;
			if (!requireActiveRun(handle, options, "assistant message_start"))
				return false;
			if (!startAssistantMessage(handle, message)) {
				options.diagnostic(
					"Ignored duplicate, delayed, or unidentifiable assistant message_start.",
				);
				return false;
			}
			corroborateRun(handle);
			handle.isStreaming = true;
			options.update();
			return true;
		}
		case "message_update": {
			if (isLifecycleTerminal(handle))
				return ignoreTerminal(options, "message_update");
			const message = record.message as Record<string, unknown> | undefined;
			if (message?.role !== "assistant") return false;
			if (!requireActiveRun(handle, options, "assistant message_update"))
				return false;
			if (
				!updateAssistantMessage(handle, message, options.assistantDisplayMax)
			) {
				options.diagnostic(
					"Ignored delayed or out-of-order assistant message_update.",
				);
				return false;
			}
			corroborateRun(handle);
			handle.isStreaming = true;
			const event = record.assistantMessageEvent as
				| { type?: unknown }
				| undefined;
			if (event?.type === "done" || event?.type === "error")
				handle.isStreaming = false;
			options.update(true);
			return true;
		}
		case "message_end": {
			if (isLifecycleTerminal(handle))
				return ignoreTerminal(options, "message_end");
			const message = record.message as Record<string, unknown> | undefined;
			if (message?.role !== "assistant") return false;
			if (!requireActiveRun(handle, options, "assistant message_end"))
				return false;
			if (
				!finalizeAssistantMessage(handle, message, options.assistantDisplayMax)
			) {
				options.diagnostic(
					"Ignored duplicate, delayed, or out-of-order assistant message_end.",
				);
				return false;
			}
			corroborateRun(handle);
			handle.isStreaming = false;
			options.onAssistantFinalized();
			updateUsage(handle, message);
			handle.stopReason =
				typeof message.stopReason === "string"
					? message.stopReason
					: handle.stopReason;
			recordAssistantEnd(handle, {
				stopReason:
					typeof message.stopReason === "string"
						? message.stopReason
						: undefined,
				errorMessage:
					typeof message.errorMessage === "string"
						? message.errorMessage
						: undefined,
				assistantMessageGeneration: handle.finalizedAssistantMessageGeneration,
			});
			options.update();
			return true;
		}
		case "agent_end": {
			if (isLifecycleTerminal(handle))
				return ignoreTerminal(options, "agent_end");
			const run = currentRun(handle);
			if (run?.phase !== "active") {
				options.diagnostic(
					"Ignored duplicate or late agent_end without an active current run.",
				);
				return false;
			}
			const finalAssistant = latestAssistantMessage(record.messages);
			if (
				run.assistantMessageGeneration === undefined ||
				run.assistantMessageGeneration !==
					handle.finalizedAssistantMessageGeneration ||
				!assistantMessageMatchesFinalized(handle, finalAssistant)
			) {
				options.diagnostic(
					"Ignored out-of-order agent_end whose final assistant message does not match the active run.",
				);
				return false;
			}
			if (!endRun(handle, at, record.willRetry === true)) return false;
			handle.isStreaming = false;
			handle.agentEndedAt = at;
			options.update();
			return true;
		}
		case "agent_settled": {
			if (isLifecycleTerminal(handle))
				return ignoreTerminal(options, "agent_settled");
			const current = currentRun(handle);
			if (
				typeof record.runId === "number" &&
				current &&
				record.runId !== current.id
			) {
				options.diagnostic(
					"Ignored agent_settled for a stale or unexpected run id.",
				);
				return false;
			}
			const outcome =
				record.runOutcome === "succeeded" ||
				record.runOutcome === "failed" ||
				record.runOutcome === "aborted"
					? record.runOutcome
					: undefined;
			const stopReason =
				typeof record.stopReason === "string" ? record.stopReason : undefined;
			const abortFence =
				handle.abortRequestedAt !== undefined ||
				outcome === "aborted" ||
				stopReason === "aborted";
			if (current?.phase === "active" && abortFence) abortRun(handle, at);
			const state = settleRunToIdle(
				handle,
				at,
				outcome,
				stopReason,
				typeof record.errorMessage === "string"
					? record.errorMessage
					: undefined,
			);
			if (!state) {
				options.diagnostic(
					"Ignored out-of-order agent_settled while the corroborated current run is active.",
				);
				return false;
			}
			handle.abortRequestedAt = undefined;
			handle.error = handle.finalError;
			const settled = currentRun(handle);
			if (!settled) return false;
			options.update();
			options.onSettled(settled);
			return true;
		}
		case "extension_error":
			options.diagnostic(
				`${String(record.extensionPath || "extension")}: ${String(record.error || "Unknown extension error")}`,
			);
			options.update();
			return true;
		default:
			return false;
	}
}
