import assert from "node:assert/strict";
import test from "node:test";
import {
	closeBeforeSettlement,
	corroborateRun,
	createLifecycleState,
	currentRunId,
	endRun,
	isLifecycleTerminal,
	lifecycleActivity,
	markStopped,
	recordAssistantEnd,
	requestKill,
	resetRunViewForSession,
	reviveForResume,
	settleRunToIdle,
	startRun,
} from "./lifecycle.ts";

test("agent settlement is non-terminal idle and a second run can start", () => {
	const state = createLifecycleState();
	startRun(state, 1);
	recordAssistantEnd(state, { stopReason: "stop" });
	endRun(state, 2, false);
	assert.equal(settleRunToIdle(state, 3), "done");
	assert.equal(state.processState, "alive");
	assert.equal(state.runState, "idle");
	assert.equal(state.settlementStatus, "settled");
	assert.equal(isLifecycleTerminal(state), false);
	assert.equal(state.lastSettledRunId, 1);
	assert.equal(startRun(state, 4)?.id, 2);
	assert.equal(state.settlementStatus, "pending");
	assert.equal(currentRunId(state), 2);
});

test("session replacement preserves monotonic run and settlement cursors", () => {
	const state = createLifecycleState();
	startRun(state, 1, 5);
	recordAssistantEnd(state, { stopReason: "stop" });
	endRun(state, 2, false);
	settleRunToIdle(state, 3);
	assert.equal(state.runSequence, 5);
	assert.equal(state.lastSettledRunId, 5);
	resetRunViewForSession(state);
	assert.equal(state.runSequence, 5);
	assert.equal(state.lastSettledRunId, 5);
	assert.equal(startRun(state, 4, 6)?.id, 6);
	recordAssistantEnd(state, { stopReason: "stop" });
	endRun(state, 5, false);
	settleRunToIdle(state, 6);
	assert.equal(state.lastSettledRunId, 6);
});

test("failed retry followed by success remains alive and records final success", () => {
	const state = createLifecycleState();
	startRun(state, 1);
	recordAssistantEnd(state, { stopReason: "error", errorMessage: "temporary" });
	endRun(state, 2, true);
	assert.equal(state.runState, "retrying");
	startRun(state, 3);
	recordAssistantEnd(state, { stopReason: "stop" });
	endRun(state, 4, false);
	assert.equal(settleRunToIdle(state, 5), "done");
	assert.equal(state.finalError, undefined);
	assert.equal(state.processState, "alive");
});

test("duplicate boundaries and uncorroborated late start are ignored", () => {
	const state = createLifecycleState();
	assert.ok(startRun(state, 1));
	assert.equal(startRun(state, 2), undefined);
	recordAssistantEnd(state, { stopReason: "stop" });
	assert.equal(endRun(state, 3, false), true);
	assert.equal(endRun(state, 4, false), false);
	assert.ok(startRun(state, 5));
	assert.equal(settleRunToIdle(state, 6), "done");
	assert.equal(state.runs.length, 1);
	assert.equal(settleRunToIdle(state, 7), undefined);
});

test("corroborated active continuation cannot settle early", () => {
	const state = createLifecycleState();
	startRun(state, 1);
	recordAssistantEnd(state, { stopReason: "stop" });
	endRun(state, 2, false);
	startRun(state, 3);
	corroborateRun(state);
	assert.equal(settleRunToIdle(state, 4), undefined);
	assert.equal(state.runState, "running");
});

test("failed and aborted outcomes classify the run without stopping process", () => {
	const failed = createLifecycleState();
	startRun(failed, 1);
	recordAssistantEnd(failed, { stopReason: "error", errorMessage: "quota" });
	endRun(failed, 2, false);
	assert.equal(settleRunToIdle(failed, 3, "failed", "error", "quota"), "error");
	assert.equal(failed.processState, "alive");
	assert.equal(failed.finalError, "quota");
	const aborted = createLifecycleState();
	startRun(aborted, 1);
	corroborateRun(aborted);
	endRun(aborted, 2, false);
	assert.equal(settleRunToIdle(aborted, 3, "aborted", "aborted"), "running");
	assert.equal(aborted.runOutcome, "aborted");
	assert.equal(aborted.processState, "alive");
});

test("resume revival clears the kill fence and preserves monotonic cursors", () => {
	const state = createLifecycleState();
	startRun(state, 1, 2);
	recordAssistantEnd(state, { stopReason: "stop" });
	endRun(state, 2, false);
	settleRunToIdle(state, 3);
	requestKill(state, 4);
	markStopped(state, 5);
	reviveForResume(state);
	assert.equal(state.processState, "alive");
	assert.equal(state.lifecycle, "idle");
	assert.equal(state.killRequestedAt, undefined);
	assert.equal(state.runSequence, 2);
	assert.equal(state.lastSettledRunId, 2);
	assert.equal(state.settledAt, undefined);
	assert.equal(state.settlementStatus, "pending");
	assert.equal(startRun(state, 6, 3)?.id, 3);
	assert.equal(state.lifecycle, "running");
});

test("markStopped is the terminal transition", () => {
	const state = createLifecycleState();
	startRun(state, 1);
	markStopped(state, 2, { code: 7 });
	assert.equal(state.processState, "stopped");
	assert.equal(isLifecycleTerminal(state), true);
	assert.equal(state.state, "error");
	assert.equal(state.settlementStatus, "closed_without_settlement");
	assert.match(state.finalError || "", /code 7/);
	assert.equal(startRun(state, 3), undefined);
});

test("an initial close keeps settlement status pending", () => {
	const state = createLifecycleState();
	markStopped(state, 1, { code: 0, signal: null });
	assert.equal(state.settlementStatus, "pending");
});

test("durable run cursors classify an unavailable active run as unsettled", () => {
	const state = createLifecycleState();
	state.runSequence = 2;
	state.lastSettledRunId = 1;
	state.runOutcome = "pending";
	markStopped(state, 3, { code: null, signal: "SIGTERM" });
	assert.equal(state.settlementStatus, "closed_without_settlement");
	assert.match(state.finalError || "", /before agent_settled/);
});

test("a close after a durable settlement keeps the completed outcome", () => {
	const state = createLifecycleState();
	state.runSequence = 1;
	state.lastSettledRunId = 1;
	state.runOutcome = "succeeded";
	state.settlementStatus = "settled";
	markStopped(state, 2, { code: 0, signal: null, error: "transport closed" });
	assert.equal(state.settlementStatus, "settled");
	assert.equal(state.state, "done");
	assert.equal(state.lifecycle, "done");
});

test("kill and close fallback stop exactly once", () => {
	const state = createLifecycleState();
	startRun(state, 1);
	requestKill(state, 2);
	assert.equal(
		closeBeforeSettlement(state, 3, { code: null, signal: "SIGTERM" }),
		"killed",
	);
	assert.equal(state.processState, "stopped");
	assert.equal(
		closeBeforeSettlement(state, 4, { code: 1, signal: null }),
		"killed",
	);
});

test("activity reports process and run state", () => {
	const state = createLifecycleState();
	assert.equal(lifecycleActivity(state, { isStreaming: false }), "idle");
	startRun(state, 1);
	assert.equal(lifecycleActivity(state, { isStreaming: true }), "responding");
	assert.equal(
		lifecycleActivity(state, { currentTool: "bash", isStreaming: true }),
		"tool: bash",
	);
	requestKill(state, 2);
	assert.equal(lifecycleActivity(state, { isStreaming: false }), "killing");
});
