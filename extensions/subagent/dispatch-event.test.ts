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
		completionSettled: false,
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
