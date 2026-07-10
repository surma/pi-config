import assert from "node:assert/strict";
import test from "node:test";
import {
	createContinuationState,
	onAgentEnd,
	onOrdinaryInput,
	requestContinuation,
	resetContinuationState,
	settleContinuation,
	stopContinuation,
} from "../../extensions/lib/goal-continuation.ts";

function eligible() {
	return { active: true, costAllowed: true } as const;
}

test("a productive ordinary run records one pending continuation and dispatches at settlement", () => {
	let state = createContinuationState();
	state = onAgentEnd(state, { ...eligible(), aborted: false, toolCalls: 1 });
	assert.deepEqual(state, { pending: true, runIsGoalContinuation: false, suppressed: false });
	let settlement = settleContinuation(state, { ...eligible(), idle: true });
	state = settlement.state;
	assert.equal(settlement.shouldDispatch, true);
	assert.deepEqual(state, { pending: false, runIsGoalContinuation: true, suppressed: false });
	settlement = settleContinuation(state, { ...eligible(), idle: true });
	assert.equal(settlement.shouldDispatch, false);
});

test("a productive goal-origin run can request the next continuation", () => {
	let state = createContinuationState();
	const request = requestContinuation(state, { ...eligible(), idle: true, clearSuppression: false });
	state = request.state;
	assert.equal(request.disposition, "started");
	state = onAgentEnd(state, { ...eligible(), aborted: false, toolCalls: 2 });
	assert.equal(state.runIsGoalContinuation, true);
	assert.equal(state.pending, true);
	assert.equal(settleContinuation(state, { ...eligible(), idle: true }).shouldDispatch, true);
});

test("a zero-tool goal-origin run suppresses continuation until ordinary input", () => {
	let state = requestContinuation(createContinuationState(), {
		...eligible(),
		idle: true,
		clearSuppression: false,
	}).state;
	state = onAgentEnd(state, { ...eligible(), aborted: false, toolCalls: 0 });
	assert.deepEqual(state, { pending: false, runIsGoalContinuation: true, suppressed: true });
	assert.equal(settleContinuation(state, { ...eligible(), idle: true }).shouldDispatch, false);

	state = onOrdinaryInput();
	assert.deepEqual(state, { pending: false, runIsGoalContinuation: false, suppressed: false });
	state = onAgentEnd(state, { ...eligible(), aborted: false, toolCalls: 0 });
	assert.equal(state.pending, true);
});

test("multiple low-level agent ends overwrite policy before one settlement", () => {
	let state = requestContinuation(createContinuationState(), {
		...eligible(),
		idle: true,
		clearSuppression: false,
	}).state;

	state = onAgentEnd(state, { ...eligible(), aborted: false, toolCalls: 0 });
	assert.equal(state.suppressed, true);
	state = onAgentEnd(state, { ...eligible(), aborted: false, toolCalls: 1 });
	assert.equal(state.suppressed, false);
	assert.equal(state.pending, true);
	assert.equal(state.runIsGoalContinuation, true);
	assert.equal(settleContinuation(state, { ...eligible(), idle: true }).shouldDispatch, true);
});

test("a final zero-tool retry suppresses after an earlier productive retry", () => {
	let state = requestContinuation(createContinuationState(), {
		...eligible(),
		idle: true,
		clearSuppression: false,
	}).state;
	state = onAgentEnd(state, { ...eligible(), aborted: false, toolCalls: 1 });
	state = onAgentEnd(state, { ...eligible(), aborted: false, toolCalls: 0 });
	assert.equal(state.pending, false);
	assert.equal(state.suppressed, true);
	assert.equal(settleContinuation(state, { ...eligible(), idle: true }).shouldDispatch, false);
});

test("abort and cost blocking overwrite stale pending intent", () => {
	let aborted = requestContinuation(createContinuationState(), {
		...eligible(),
		idle: true,
		clearSuppression: false,
	}).state;
	aborted = onAgentEnd(aborted, { ...eligible(), aborted: true, toolCalls: 1 });
	assert.equal(aborted.pending, false);
	assert.equal(aborted.runIsGoalContinuation, true);
	const abortSettlement = settleContinuation(aborted, { ...eligible(), idle: true });
	assert.equal(abortSettlement.shouldDispatch, false);
	assert.equal(abortSettlement.state.runIsGoalContinuation, false);

	let costBlocked = onAgentEnd(createContinuationState(), { ...eligible(), aborted: false, toolCalls: 1 });
	costBlocked = onAgentEnd(costBlocked, {
		active: true,
		costAllowed: false,
		aborted: false,
		toolCalls: 1,
	});
	assert.equal(costBlocked.pending, false);
	assert.equal(
		settleContinuation(costBlocked, { active: true, costAllowed: false, idle: true }).shouldDispatch,
		false,
	);
});

test("complete, pause, and clear all stop pending and origin state", () => {
	for (const transition of ["complete", "pause", "clear"]) {
		let state = requestContinuation(createContinuationState(), {
			...eligible(),
			idle: true,
			clearSuppression: false,
		}).state;
		state = onAgentEnd(state, { ...eligible(), aborted: false, toolCalls: 1 });
		state = stopContinuation();
		assert.deepEqual(state, { pending: false, runIsGoalContinuation: false, suppressed: false }, transition);
	}
});

test("resume starts immediately when idle and defers without losing intent when busy", () => {
	const suppressed = { ...createContinuationState(), suppressed: true };
	let request = requestContinuation(suppressed, { ...eligible(), idle: true, clearSuppression: true });
	assert.equal(request.disposition, "started");
	assert.deepEqual(request.state, { pending: false, runIsGoalContinuation: true, suppressed: false });

	request = requestContinuation(suppressed, { ...eligible(), idle: false, clearSuppression: true });
	assert.equal(request.disposition, "deferred");
	assert.deepEqual(request.state, { pending: true, runIsGoalContinuation: false, suppressed: false });
	let settlement = settleContinuation(request.state, { ...eligible(), idle: false });
	assert.equal(settlement.shouldDispatch, false);
	assert.equal(settlement.state.pending, true);
	settlement = settleContinuation(settlement.state, { ...eligible(), idle: true });
	assert.equal(settlement.shouldDispatch, true);
});

test("cost-blocked resume clears stale intent and does not claim a queue disposition", () => {
	const state = { ...createContinuationState(), pending: true, suppressed: true };
	const request = requestContinuation(state, {
		active: true,
		costAllowed: false,
		idle: true,
		clearSuppression: true,
	});
	assert.equal(request.disposition, "blocked");
	assert.deepEqual(request.state, { pending: false, runIsGoalContinuation: false, suppressed: false });
});

test("reload, tree navigation, and shutdown reset transient state without dispatch", () => {
	for (const boundary of ["reload", "tree", "shutdown"]) {
		const state = { pending: true, runIsGoalContinuation: true, suppressed: true };
		const reset = resetContinuationState();
		assert.deepEqual(reset, { pending: false, runIsGoalContinuation: false, suppressed: false }, boundary);
		assert.equal(settleContinuation(reset, { ...eligible(), idle: true }).shouldDispatch, false);
		assert.deepEqual(state, { pending: true, runIsGoalContinuation: true, suppressed: true });
	}
});
