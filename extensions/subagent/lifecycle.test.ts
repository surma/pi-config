import assert from "node:assert/strict";
import test from "node:test";
import {
	closeBeforeSettlement,
	corroborateRun,
	createLifecycleState,
	endRun,
	lifecycleActivity,
	recordAssistantEnd,
	requestKill,
	settleLifecycle,
	startRun,
} from "./lifecycle.ts";

test("failed retry followed by success settles done without a terminal error", () => {
	const state = createLifecycleState();
	startRun(state, 1);
	recordAssistantEnd(state, { stopReason: "error", errorMessage: "temporary overload" });
	endRun(state, 2, true);
	assert.equal(state.lifecycle, "retrying");
	assert.equal(state.tentativeError, "temporary overload");

	startRun(state, 3);
	assert.equal(state.lifecycle, "running");
	assert.equal(state.tentativeError, undefined);
	recordAssistantEnd(state, { stopReason: "stop" });
	endRun(state, 4, false);
	assert.equal(state.lifecycle, "finishing");
	assert.equal(settleLifecycle(state, 5), "done");
	assert.equal(state.finalError, undefined);
	assert.equal(state.runs[0]?.error, "temporary overload");
});

test("duplicate and late run boundaries are idempotent", () => {
	const state = createLifecycleState();
	const first = startRun(state, 1);
	assert.ok(first);
	assert.equal(startRun(state, 2), undefined);
	assert.equal(state.runs.length, 1);

	assert.equal(endRun(state, 3, true), true);
	assert.equal(state.lifecycle, "retrying");
	assert.equal(endRun(state, 4, false), false);
	assert.equal(state.lifecycle, "retrying");
	assert.equal(state.runs[0]?.endedAt, 3);

	const retry = startRun(state, 5);
	assert.ok(retry);
	assert.equal(state.runs.length, 2);
	assert.equal(corroborateRun(state), true);
	assert.equal(settleLifecycle(state, 6), undefined);
	assert.equal(state.lifecycle, "running");
	assert.equal(endRun(state, 7, false), true);
	assert.equal(settleLifecycle(state, 8), "done");
	assert.equal(startRun(state, 9), undefined);
	assert.equal(endRun(state, 10, true), false);
	assert.equal(state.lifecycle, "done");
});

test("settlement discards an uncorroborated post-end start", () => {
	const state = createLifecycleState();
	startRun(state, 1);
	recordAssistantEnd(state, { stopReason: "stop" });
	endRun(state, 2, false);

	const duplicate = startRun(state, 3);
	assert.ok(duplicate);
	assert.equal(duplicate.corroborated, false);
	assert.equal(settleLifecycle(state, 4), "done");
	assert.equal(state.runs.length, 1);
	assert.equal(state.runs[0]?.phase, "ended");
});

test("settlement does not discard a corroborated continuation", () => {
	const state = createLifecycleState();
	startRun(state, 1);
	recordAssistantEnd(state, { stopReason: "stop" });
	endRun(state, 2, false);

	const continuation = startRun(state, 3);
	assert.ok(continuation);
	assert.equal(corroborateRun(state), true);
	assert.equal(continuation.corroborated, true);
	assert.equal(settleLifecycle(state, 4), undefined);
	assert.equal(state.lifecycle, "running");
	assert.equal(state.runs.length, 2);
});

test("unrecovered final failure settles error from the final run", () => {
	const state = createLifecycleState();
	startRun(state, 1);
	recordAssistantEnd(state, { stopReason: "error", errorMessage: "quota exhausted" });
	endRun(state, 2, false);
	assert.equal(settleLifecycle(state, 3), "error");
	assert.equal(state.finalError, "quota exhausted");
});

test("requested kill settles killed and terminal transitions are idempotent", () => {
	const state = createLifecycleState();
	startRun(state, 1);
	requestKill(state, 2);
	assert.equal(state.lifecycle, "killing");
	assert.equal(settleLifecycle(state, 3), "killed");
	assert.equal(settleLifecycle(state, 4), "killed");
	startRun(state, 5);
	assert.equal(state.runs.length, 1);
});

test("close before settlement uses failed-run evidence or deterministic process fallback", () => {
	const failed = createLifecycleState();
	startRun(failed, 1);
	recordAssistantEnd(failed, { stopReason: "error", errorMessage: "provider failed" });
	endRun(failed, 2, false);
	assert.equal(closeBeforeSettlement(failed, 3, { code: 1, signal: null }), "error");
	assert.equal(failed.finalError, "provider failed");

	const failedBeforeEnd = createLifecycleState();
	startRun(failedBeforeEnd, 1);
	recordAssistantEnd(failedBeforeEnd, { stopReason: "error", errorMessage: "stream failed" });
	assert.equal(closeBeforeSettlement(failedBeforeEnd, 2, { code: 1, signal: null }), "error");
	assert.equal(failedBeforeEnd.finalError, "stream failed");

	const unexpected = createLifecycleState();
	startRun(unexpected, 1);
	assert.equal(closeBeforeSettlement(unexpected, 2, { code: 0, signal: null }), "error");
	assert.equal(unexpected.finalError, "Process exited before agent_settled with code 0");

	const killed = createLifecycleState();
	startRun(killed, 1);
	requestKill(killed, 2);
	assert.equal(closeBeforeSettlement(killed, 3, { code: null, signal: "SIGTERM" }), "killed");
});

test("activity precedence keeps a current stream ahead of the last tool", () => {
	const state = createLifecycleState();
	startRun(state, 1);
	assert.equal(lifecycleActivity(state, { isStreaming: true, lastTool: "read" }), "responding");
	assert.equal(lifecycleActivity(state, { currentTool: "bash", isStreaming: true, lastTool: "read" }), "tool: bash");
	requestKill(state, 2);
	assert.equal(lifecycleActivity(state, { currentTool: "bash", isStreaming: true }), "killing");
});
