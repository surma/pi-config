import assert from "node:assert/strict";
import test from "node:test";
import {
	type AssistantLiveState,
	finalizeAssistantMessage,
	MAX_FINALIZED_ASSISTANT_IDENTITIES,
	startAssistantMessage,
	type ToolActivity,
	updateAssistantMessage,
	updateToolActivity,
} from "./live-state.ts";

function state(): AssistantLiveState {
	return {
		resultText: "",
		currentAssistantText: "",
		latestAssistantText: "",
		assistantMessageGeneration: 0,
		finalizedAssistantIdentities: [],
		assistantTextTruncated: false,
	};
}

function message(timestamp: number, text: string, responseId?: string) {
	return {
		role: "assistant",
		timestamp,
		api: "test-api",
		provider: "p",
		model: "m",
		responseId,
		content: [{ type: "text", text }],
	};
}

test("assistant snapshots replace within a generation and a shorter new turn replaces an older one", () => {
	const live = state();
	startAssistantMessage(live, message(1, ""));
	assert.equal(
		updateAssistantMessage(live, message(1, "first long response"), 1024),
		true,
	);
	assert.equal(live.currentAssistantText, "first long response");
	assert.equal(
		finalizeAssistantMessage(live, message(1, "first long response"), 1024),
		true,
	);
	assert.equal(live.latestAssistantText, "first long response");

	startAssistantMessage(live, message(2, ""));
	updateAssistantMessage(live, message(2, "short"), 1024);
	finalizeAssistantMessage(live, message(2, "short"), 1024);
	assert.equal(live.currentAssistantText, "short");
	assert.equal(live.latestAssistantText, "short");
	assert.equal(live.resultText, "short");
});

test("finalization tombstones reject delayed same-message events and duplicate finalization", () => {
	const live = state();
	assert.equal(startAssistantMessage(live, message(1, "")), true);
	assert.equal(updateAssistantMessage(live, message(1, "partial"), 1024), true);
	assert.equal(finalizeAssistantMessage(live, message(1, "final"), 1024), true);
	assert.equal(live.assistantMessageActive, false);
	assert.equal(live.finalizedAssistantMessageGeneration, 1);

	assert.equal(
		updateAssistantMessage(live, message(1, "stale partial"), 1024),
		false,
	);
	assert.equal(startAssistantMessage(live, message(1, "")), false);
	assert.equal(
		finalizeAssistantMessage(live, message(1, "duplicate final"), 1024),
		false,
	);
	assert.equal(live.finalizedAssistantIdentities.length, 1);
	assert.equal(live.currentAssistantText, "final");
	assert.equal(live.latestAssistantText, "final");
	assert.equal(live.resultText, "final");
});

test("an out-of-order start cannot replace an active message", () => {
	const live = state();
	assert.equal(startAssistantMessage(live, message(2, "")), true);
	assert.equal(updateAssistantMessage(live, message(2, "current"), 1024), true);
	assert.equal(startAssistantMessage(live, message(3, "")), false);
	assert.equal(live.assistantMessageGeneration, 1);
	assert.equal(live.currentAssistantText, "current");
});

test("unseen responseIds distinguish legitimate same-timestamp messages", () => {
	const live = state();
	assert.equal(startAssistantMessage(live, message(4, "", "response-a")), true);
	assert.equal(
		finalizeAssistantMessage(live, message(4, "first", "response-a"), 1024),
		true,
	);
	assert.equal(startAssistantMessage(live, message(4, "", "response-b")), true);
	assert.equal(
		finalizeAssistantMessage(live, message(4, "short", "response-b"), 1024),
		true,
	);
	assert.equal(startAssistantMessage(live, message(4, "", "response-c")), true);
	assert.equal(
		finalizeAssistantMessage(live, message(4, "new", "response-c"), 1024),
		true,
	);
	assert.equal(live.currentAssistantText, "new");
	assert.equal(live.resultText, "new");
});

test("ambiguous fallback collisions are rejected rather than overwriting finalized output", () => {
	const live = state();
	assert.equal(startAssistantMessage(live, message(5, "")), true);
	assert.equal(finalizeAssistantMessage(live, message(5, "safe"), 1024), true);
	assert.equal(startAssistantMessage(live, message(5, "")), false);
	assert.equal(live.currentAssistantText, "safe");
});

test("a fallback identity can upgrade to a documented provider responseId", () => {
	const live = state();
	assert.equal(startAssistantMessage(live, message(6, "")), true);
	assert.equal(
		updateAssistantMessage(live, message(6, "partial", "response-late"), 1024),
		true,
	);
	assert.equal(
		finalizeAssistantMessage(live, message(6, "final", "response-late"), 1024),
		true,
	);
	assert.equal(live.finalizedAssistantResponseId, "response-late");
	assert.deepEqual(live.finalizedAssistantIdentities[0], {
		fallbackKey: JSON.stringify([6, "test-api", "p", "m"]),
		timestamp: 6,
		responseId: "response-late",
	});
	assert.equal(
		startAssistantMessage(live, message(6, "", "response-next")),
		true,
	);
	assert.equal(
		finalizeAssistantMessage(live, message(6, "next", "response-next"), 1024),
		true,
	);
	assert.equal(startAssistantMessage(live, message(6, "")), false);
	assert.equal(
		startAssistantMessage(live, message(6, "", "response-late")),
		false,
	);
});

test("retained older finalized identities reject start, update, and end records", () => {
	const live = state();
	const first = message(7, "old", "response-old");
	assert.equal(startAssistantMessage(live, { ...first, content: [] }), true);
	assert.equal(finalizeAssistantMessage(live, first, 1024), true);
	assert.equal(
		startAssistantMessage(live, message(7, "", "response-new")),
		true,
	);
	assert.equal(
		finalizeAssistantMessage(live, message(7, "new", "response-new"), 1024),
		true,
	);

	assert.equal(startAssistantMessage(live, { ...first, content: [] }), false);
	assert.equal(
		startAssistantMessage(live, message(7, "", "response-current")),
		true,
	);
	assert.equal(updateAssistantMessage(live, first, 1024), false);
	assert.equal(finalizeAssistantMessage(live, first, 1024), false);
	assert.equal(live.assistantMessageActive, true);
	assert.equal(live.resultText, "new");
	assert.equal(
		finalizeAssistantMessage(
			live,
			message(7, "current", "response-current"),
			1024,
		),
		true,
	);
	assert.equal(live.currentAssistantText, "current");
	assert.equal(live.resultText, "current");
	assert.equal(live.finalizedAssistantIdentities.length, 3);
});

test("finalized assistant identity history is FIFO-bounded to 256 entries", () => {
	const live = state();
	for (let index = 0; index <= MAX_FINALIZED_ASSISTANT_IDENTITIES; index++) {
		const responseId = `response-${index}`;
		assert.equal(startAssistantMessage(live, message(9, "", responseId)), true);
		assert.equal(
			finalizeAssistantMessage(live, message(9, responseId, responseId), 1024),
			true,
		);
	}

	assert.equal(MAX_FINALIZED_ASSISTANT_IDENTITIES, 256);
	assert.equal(
		live.finalizedAssistantIdentities.length,
		MAX_FINALIZED_ASSISTANT_IDENTITIES,
	);
	assert.equal(live.finalizedAssistantIdentities[0]?.responseId, "response-1");
	assert.equal(
		live.finalizedAssistantIdentities.at(-1)?.responseId,
		"response-256",
	);
	assert.equal(
		startAssistantMessage(live, message(9, "", "response-1")),
		false,
	);
	assert.equal(startAssistantMessage(live, message(9, "", "response-0")), true);
});

test("late snapshots from an older assistant message are ignored", () => {
	const live = state();
	startAssistantMessage(live, message(1, ""));
	updateAssistantMessage(live, message(1, "old"), 1024);
	finalizeAssistantMessage(live, message(1, "old"), 1024);
	startAssistantMessage(live, message(2, ""));
	updateAssistantMessage(live, message(2, "new"), 1024);
	assert.equal(
		updateAssistantMessage(live, message(1, "late old snapshot"), 1024),
		false,
	);
	assert.equal(live.currentAssistantText, "new");
});

test("parallel tool output stays correlated and bounded", () => {
	const first: ToolActivity = {
		toolCallId: "a",
		name: "bash",
		startedAt: 1,
		updatedAt: 1,
		output: "",
		outputTruncated: false,
	};
	const second: ToolActivity = {
		toolCallId: "b",
		name: "read",
		startedAt: 2,
		updatedAt: 2,
		output: "",
		outputTruncated: false,
	};
	updateToolActivity(
		first,
		{
			content: [{ type: "text", text: `prefix-${"x".repeat(50)}-tail-a` }],
			details: { progress: 25 },
		},
		16,
		3,
	);
	updateToolActivity(
		second,
		{ content: [{ type: "text", text: "output-b" }] },
		16,
		4,
	);
	assert.match(first.output, /tail-a$/);
	assert.equal(first.outputTruncated, true);
	assert.equal(first.progress, 25);
	assert.equal(second.output, "output-b");
	assert.equal(second.progress, undefined);
});
