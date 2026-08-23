import assert from "node:assert/strict";
import test from "node:test";
import {
	dispatchSubagentEvent,
	type SubagentDispatchHandle,
	type SubagentDispatchOptions,
} from "./dispatch-event.ts";
import { createLifecycleState } from "./lifecycle.ts";

function assistant(
	timestamp: number,
	text: string,
	stopReason = "stop",
	responseId = `r-${timestamp}`,
	errorMessage?: string,
) {
	return {
		role: "assistant",
		api: "test",
		provider: "test",
		model: "model",
		timestamp,
		responseId,
		content: [{ type: "text", text }],
		stopReason,
		errorMessage,
		usage: {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			cost: { total: 0.5 },
		},
	};
}
function createHandle(): SubagentDispatchHandle {
	return {
		...createLifecycleState(),
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
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
		},
	};
}
function harness() {
	const handle = createHandle();
	let clock = 0;
	let settled = 0;
	const diagnostics: string[] = [];
	const options: SubagentDispatchOptions = {
		now: () => ++clock,
		assistantDisplayMax: 1024,
		toolOutputTailMax: 32,
		maxRecentTools: 8,
		update: () => {},
		diagnostic: (message) => diagnostics.push(message),
		onAssistantFinalized: () => {},
		onSettled: () => {
			settled++;
		},
	};
	return {
		handle,
		options,
		diagnostics,
		get settled() {
			return settled;
		},
	};
}
function emitMessage(
	h: ReturnType<typeof harness>,
	message: ReturnType<typeof assistant>,
) {
	dispatchSubagentEvent(
		h.handle,
		{ type: "message_start", message: { ...message, content: [] } },
		h.options,
	);
	dispatchSubagentEvent(
		h.handle,
		{
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta" },
		},
		h.options,
	);
	dispatchSubagentEvent(h.handle, { type: "message_end", message }, h.options);
}
function completeRun(
	h: ReturnType<typeof harness>,
	id: number,
	text: string,
	extra: Record<string, unknown> = {},
) {
	const message = assistant(id, text);
	assert.equal(
		dispatchSubagentEvent(
			h.handle,
			{ type: "agent_start", runId: id },
			h.options,
		),
		true,
	);
	emitMessage(h, message);
	assert.equal(
		dispatchSubagentEvent(
			h.handle,
			{ type: "agent_end", runId: id, messages: [message], willRetry: false },
			h.options,
		),
		true,
	);
	assert.equal(
		dispatchSubagentEvent(
			h.handle,
			{ type: "agent_settled", runId: id, runOutcome: "succeeded", ...extra },
			h.options,
		),
		true,
	);
}

test("dispatch settlement is non-terminal and another run succeeds", () => {
	const h = harness();
	completeRun(h, 1, "first");
	assert.equal(h.handle.processState, "alive");
	assert.equal(h.handle.runState, "idle");
	assert.equal(h.handle.lastSettledRunId, 1);
	assert.equal(h.settled, 1);
	completeRun(h, 2, "second");
	assert.equal(h.handle.runSequence, 2);
	assert.equal(h.handle.lastSettledRunId, 2);
	assert.equal(h.handle.resultText, "second");
	assert.equal(h.handle.usage.turns, 2);
	assert.equal(h.settled, 2);
});

test("failed retry followed by success has no final error", () => {
	const h = harness();
	const failed = assistant(1, "failed", "error", "failed", "temporary");
	dispatchSubagentEvent(h.handle, { type: "agent_start", runId: 1 }, h.options);
	emitMessage(h, failed);
	dispatchSubagentEvent(
		h.handle,
		{ type: "agent_end", messages: [failed], willRetry: true },
		h.options,
	);
	assert.equal(h.handle.runState, "retrying");
	completeRun(h, 2, "recovered");
	assert.equal(h.handle.finalError, undefined);
	assert.equal(h.handle.processState, "alive");
});

test("native agent_settled infers an aborted outcome from the final assistant message", () => {
	const h = harness();
	const aborted = assistant(1, "partial", "aborted");
	dispatchSubagentEvent(h.handle, { type: "agent_start" }, h.options);
	emitMessage(h, aborted);
	dispatchSubagentEvent(
		h.handle,
		{ type: "agent_end", messages: [aborted], willRetry: false },
		h.options,
	);
	assert.equal(
		dispatchSubagentEvent(h.handle, { type: "agent_settled" }, h.options),
		true,
	);
	assert.equal(h.handle.runOutcome, "aborted");
	assert.equal(h.handle.processState, "alive");
	assert.equal(h.settled, 1);
});

test("explicit abort fence settles native settlement without message_end", () => {
	const h = harness();
	assert.equal(
		dispatchSubagentEvent(h.handle, { type: "agent_start", runId: 1 }, h.options),
		true,
	);
	h.handle.abortRequestedAt = 2;
	assert.equal(
		dispatchSubagentEvent(
			h.handle,
			{ type: "agent_settled", runId: 1 },
			h.options,
		),
		true,
	);
	assert.equal(h.handle.runOutcome, "aborted");
	assert.equal(h.handle.runState, "idle");
	assert.equal(h.handle.processState, "alive");
	assert.equal(h.handle.lastSettledRunId, 1);
	assert.equal(h.settled, 1);
});

test("an accepted abort fences a native assistant error before agent_settled", () => {
	const h = harness();
	let settledRun: { outcome: string; error?: string } | undefined;
	let settledCount = 0;
	h.options.onSettled = (run) => {
		settledRun = run;
		settledCount++;
	};
	const aborted = assistant(
		4,
		"",
		"error",
		"aborted-error",
		"This operation was aborted",
	);
	const events: Record<string, unknown>[] = [
		{ type: "agent_start", runId: 1 },
		{
			type: "tool_execution_start",
			toolCallId: "sleep-call",
			toolName: "bash",
			args: { command: "sleep 60" },
		},
		{
			type: "tool_execution_update",
			toolCallId: "sleep-call",
			partialResult: { content: [{ type: "text", text: "running" }] },
		},
		{
			type: "tool_execution_end",
			toolCallId: "sleep-call",
			result: { content: [{ type: "text", text: "Command aborted" }] },
			isError: true,
		},
		{ type: "message_start", message: { ...aborted, content: [] } },
		{ type: "message_end", message: aborted },
		{ type: "agent_end", runId: 1, messages: [aborted], willRetry: false },
		{ type: "agent_settled", runId: 1 },
	];
	assert.equal(
		dispatchSubagentEvent(h.handle, events[0]!, h.options),
		true,
	);
	h.handle.abortRequestedAt = 2;
	for (const event of events.slice(1))
		assert.equal(dispatchSubagentEvent(h.handle, event, h.options), true);

	assert.equal(h.handle.runOutcome, "aborted");
	assert.equal(h.handle.settlementStatus, "settled");
	assert.equal(h.handle.runState, "idle");
	assert.equal(h.handle.processState, "alive");
	assert.equal(h.handle.finalError, undefined);
	assert.equal(h.handle.tentativeError, undefined);
	assert.equal(h.handle.error, undefined);
	assert.equal(settledRun?.outcome, "aborted");
	assert.equal(settledRun?.error, undefined);
	assert.equal(settledCount, 1);
});

test("an abort settlement clears an unfinished assistant before the next run", () => {
	const h = harness();
	const first = assistant(1, "partial");
	assert.equal(
		dispatchSubagentEvent(h.handle, { type: "agent_start", runId: 1 }, h.options),
		true,
	);
	assert.equal(
		dispatchSubagentEvent(
			h.handle,
			{ type: "message_start", message: { ...first, content: [] } },
			h.options,
		),
		true,
	);
	h.handle.abortRequestedAt = 3;
	assert.equal(
		dispatchSubagentEvent(h.handle, { type: "agent_settled", runId: 1 }, h.options),
		true,
	);
	assert.equal(h.handle.isStreaming, false);
	assert.equal(h.handle.assistantMessageActive, false);
	assert.equal(
		dispatchSubagentEvent(h.handle, { type: "agent_start", runId: 2 }, h.options),
		true,
	);
	const second = assistant(2, "next");
	assert.equal(
		dispatchSubagentEvent(
			h.handle,
			{ type: "message_start", message: { ...second, content: [] } },
			h.options,
		),
		true,
	);
});

test("parallel tools correlate and retained identity history is bounded", () => {
	const h = harness();
	dispatchSubagentEvent(h.handle, { type: "agent_start", runId: 1 }, h.options);
	for (let index = 0; index < 300; index++) {
		const toolCallId = `t-${index}`;
		dispatchSubagentEvent(
			h.handle,
			{
				type: "tool_execution_start",
				toolCallId,
				toolName: index % 2 ? "read" : "bash",
				args: {},
			},
			h.options,
		);
		dispatchSubagentEvent(
			h.handle,
			{
				type: "tool_execution_update",
				toolCallId,
				partialResult: { content: [{ type: "text", text: "progress" }] },
			},
			h.options,
		);
		dispatchSubagentEvent(
			h.handle,
			{
				type: "tool_execution_end",
				toolCallId,
				result: { content: [{ type: "text", text: "done" }] },
				isError: false,
			},
			h.options,
		);
	}
	assert.equal(h.handle.knownToolCallIds.length, 256);
	assert.equal(h.handle.recentTools.length, 8);
	assert.equal(h.handle.activeTools.size, 0);
});

test("duplicate and out-of-order boundaries are inert", () => {
	const h = harness();
	assert.equal(
		dispatchSubagentEvent(
			h.handle,
			{ type: "agent_start", runId: 1 },
			h.options,
		),
		true,
	);
	assert.equal(
		dispatchSubagentEvent(
			h.handle,
			{ type: "agent_start", runId: 1 },
			h.options,
		),
		false,
	);
	assert.equal(
		dispatchSubagentEvent(
			h.handle,
			{ type: "agent_end", messages: [], willRetry: false },
			h.options,
		),
		false,
	);
	assert.equal(
		dispatchSubagentEvent(
			h.handle,
			{ type: "agent_settled", runId: 1 },
			h.options,
		),
		false,
	);
	assert.match(
		h.diagnostics.join("\n"),
		/duplicate agent_start|does not match/,
	);
});

test("tool updates require an active known tool", () => {
	const h = harness();
	dispatchSubagentEvent(h.handle, { type: "agent_start" }, h.options);
	assert.equal(
		dispatchSubagentEvent(
			h.handle,
			{
				type: "tool_execution_update",
				toolCallId: "missing",
				partialResult: {},
			},
			h.options,
		),
		false,
	);
	assert.match(h.diagnostics.join("\n"), /unknown/);
});

test("supplied run ids must increase and settlement ids must match the current run", () => {
	const h = harness();
	completeRun(h, 5, "first");
	assert.equal(
		dispatchSubagentEvent(h.handle, { type: "agent_start", runId: 5 }, h.options),
		false,
	);
	assert.equal(
		dispatchSubagentEvent(h.handle, { type: "agent_start", runId: 4 }, h.options),
		false,
	);
	assert.equal(
		dispatchSubagentEvent(h.handle, { type: "agent_start", runId: 0 }, h.options),
		false,
	);
	assert.equal(
		dispatchSubagentEvent(h.handle, { type: "agent_start", runId: 6 }, h.options),
		true,
	);
	assert.equal(
		dispatchSubagentEvent(h.handle, { type: "agent_settled", runId: 5 }, h.options),
		false,
	);
	assert.equal(h.handle.runSequence, 6);
	assert.match(h.diagnostics.join("\n"), /run id|unexpected/);
});

test("settlement notification runs before the optional update callback", () => {
	const h = harness();
	const order: string[] = [];
	h.options.update = () => order.push("update");
	h.options.onSettled = () => order.push("settled");
	completeRun(h, 1, "first");
	assert.equal(order.at(-2), "settled");
	assert.equal(order.at(-1), "update");
});
