export interface ContinuationState {
	readonly pending: boolean;
	readonly runIsGoalContinuation: boolean;
	readonly suppressed: boolean;
}

export interface ContinuationEligibility {
	readonly active: boolean;
	readonly costAllowed: boolean;
}

export type ContinuationRequestDisposition = "started" | "deferred" | "blocked";

export interface ContinuationSettlement {
	readonly state: ContinuationState;
	readonly shouldDispatch: boolean;
}

export interface ContinuationRequest {
	readonly state: ContinuationState;
	readonly disposition: ContinuationRequestDisposition;
}

export function createContinuationState(): ContinuationState {
	return {
		pending: false,
		runIsGoalContinuation: false,
		suppressed: false,
	};
}

export const resetContinuationState = createContinuationState;
export const stopContinuation = createContinuationState;
export const onOrdinaryInput = createContinuationState;

export function clearContinuationSuppression(state: ContinuationState): ContinuationState {
	return { ...state, suppressed: false };
}

export function onAgentEnd(
	state: ContinuationState,
	result: ContinuationEligibility & { readonly aborted: boolean; readonly toolCalls: number },
): ContinuationState {
	if (!result.active || result.aborted || !result.costAllowed) {
		return { ...state, pending: false };
	}

	if (result.toolCalls > 0) {
		return { ...state, pending: true, suppressed: false };
	}

	if (state.runIsGoalContinuation) {
		return { ...state, pending: false, suppressed: true };
	}

	return { ...state, pending: !state.suppressed };
}

export function settleContinuation(
	state: ContinuationState,
	settlement: ContinuationEligibility & { readonly idle: boolean },
): ContinuationSettlement {
	const settledState = { ...state, runIsGoalContinuation: false };

	if (!settlement.active || !settlement.costAllowed) {
		return { state: { ...settledState, pending: false }, shouldDispatch: false };
	}
	if (!settledState.pending || !settlement.idle) {
		return { state: settledState, shouldDispatch: false };
	}

	return {
		state: { ...settledState, pending: false, runIsGoalContinuation: true },
		shouldDispatch: true,
	};
}

export function requestContinuation(
	state: ContinuationState,
	request: ContinuationEligibility & { readonly idle: boolean; readonly clearSuppression: boolean },
): ContinuationRequest {
	const requestedState = request.clearSuppression ? clearContinuationSuppression(state) : state;

	if (!request.active || !request.costAllowed || requestedState.suppressed) {
		return { state: { ...requestedState, pending: false }, disposition: "blocked" };
	}

	if (!request.idle) {
		return { state: { ...requestedState, pending: true }, disposition: "deferred" };
	}

	return {
		state: { ...requestedState, pending: false, runIsGoalContinuation: true },
		disposition: "started",
	};
}
