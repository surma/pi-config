export type SubagentState =
	| "starting"
	| "running"
	| "done"
	| "error"
	| "killed";
export type SessionLifecycle =
	| "starting"
	| "idle"
	| "running"
	| "retrying"
	| "finishing"
	| "killing"
	| "done"
	| "error"
	| "killed";
export type ProcessState = "alive" | "stopped";
export type RunState = "idle" | "running" | "retrying" | "finishing";
export type RunPhase = "active" | "ended";
export type RunOutcome = "pending" | "succeeded" | "failed" | "aborted";
export type SettlementStatus =
	| "pending"
	| "settled"
	| "closed_without_settlement";

export interface SubagentRun {
	id: number;
	phase: RunPhase;
	outcome: RunOutcome;
	startedAt: number;
	endedAt?: number;
	stopReason?: string;
	error?: string;
	assistantMessageGeneration?: number;
	corroborated: boolean;
}

export interface LifecycleState {
	// state/lifecycle are retained for inspector and serialized compatibility.
	state: SubagentState;
	lifecycle: SessionLifecycle;
	processState: ProcessState;
	runState: RunState;
	runSequence: number;
	lastSettledRunId: number;
	runs: SubagentRun[];
	runOutcome?: RunOutcome;
	settlementStatus: SettlementStatus;
	tentativeError?: string;
	finalError?: string;
	settledAt?: number;
	killRequestedAt?: number;
}

const MAX_RUN_HISTORY = 12;
const MAX_RUN_ERROR_LENGTH = 8 * 1024;

export function createLifecycleState(): LifecycleState {
	return {
		state: "starting",
		lifecycle: "idle",
		processState: "alive",
		runState: "idle",
		runSequence: 0,
		lastSettledRunId: 0,
		runs: [],
		settlementStatus: "pending",
	};
}

export function currentRun(state: LifecycleState): SubagentRun | undefined {
	return state.runs[state.runs.length - 1];
}

export function currentRunId(state: LifecycleState): number | undefined {
	return state.runSequence || undefined;
}

export function isLifecycleTerminal(state: LifecycleState): boolean {
	return state.processState === "stopped";
}

export function startRun(
	state: LifecycleState,
	at: number,
	suppliedRunId?: number,
): SubagentRun | undefined {
	if (isLifecycleTerminal(state) || currentRun(state)?.phase === "active")
		return undefined;
	if (
		suppliedRunId !== undefined &&
		(!Number.isSafeInteger(suppliedRunId) ||
			suppliedRunId < 1 ||
			suppliedRunId <= state.runSequence)
	)
		return undefined;
	const id = suppliedRunId ?? state.runSequence + 1;
	state.runSequence = id;
	const run: SubagentRun = {
		id,
		phase: "active",
		outcome: "pending",
		startedAt: at,
		corroborated: false,
	};
	state.runs.push(run);
	if (state.runs.length > MAX_RUN_HISTORY)
		state.runs.splice(0, state.runs.length - MAX_RUN_HISTORY);
	state.state = "running";
	state.runState = "running";
	state.lifecycle = state.killRequestedAt ? "killing" : "running";
	state.runOutcome = "pending";
	state.settlementStatus = "pending";
	state.tentativeError = undefined;
	state.finalError = undefined;
	return run;
}

export function corroborateRun(state: LifecycleState): boolean {
	if (isLifecycleTerminal(state)) return false;
	const run = currentRun(state);
	if (run?.phase !== "active") return false;
	run.corroborated = true;
	return true;
}

export function recordAssistantEnd(
	state: LifecycleState,
	message: {
		stopReason?: string;
		errorMessage?: string;
		assistantMessageGeneration?: number;
	},
): void {
	if (!corroborateRun(state)) return;
	const run = currentRun(state);
	if (!run) return;
	if (message.stopReason) run.stopReason = message.stopReason;
	if (message.assistantMessageGeneration !== undefined)
		run.assistantMessageGeneration = message.assistantMessageGeneration;
	const rawError = message.errorMessage?.trim();
	const error =
		rawError && rawError.length > MAX_RUN_ERROR_LENGTH
			? `${rawError.slice(0, MAX_RUN_ERROR_LENGTH)}…`
			: rawError;
	if (message.stopReason === "aborted") {
		run.outcome = "aborted";
		state.tentativeError = undefined;
	} else if (message.stopReason === "error" || error) {
		run.outcome = "failed";
		run.error = error || "Assistant response failed";
		state.tentativeError = run.error;
	}
}

export function endRun(
	state: LifecycleState,
	at: number,
	willRetry: boolean,
): boolean {
	if (isLifecycleTerminal(state)) return false;
	const run = currentRun(state);
	if (run?.phase !== "active") return false;
	run.phase = "ended";
	run.corroborated = true;
	run.endedAt = at;
	if (run.outcome === "pending") run.outcome = "succeeded";
	state.state = "running";
	state.runState = willRetry ? "retrying" : "finishing";
	state.lifecycle = state.killRequestedAt ? "killing" : state.runState;
	return true;
}

/** Fence an interrupted run, including one that native agent_end already ended. */
export function abortRun(state: LifecycleState, at: number): boolean {
	if (isLifecycleTerminal(state)) return false;
	const run = currentRun(state);
	if (run?.phase === "ended") {
		run.outcome = "aborted";
		run.stopReason = "aborted";
		run.error = undefined;
		state.tentativeError = undefined;
		return true;
	}
	if (run?.phase !== "active") return false;
	run.outcome = "aborted";
	run.stopReason = "aborted";
	run.error = undefined;
	state.tentativeError = undefined;
	return endRun(state, at, false);
}

export function requestKill(state: LifecycleState, at: number): void {
	if (isLifecycleTerminal(state)) return;
	state.killRequestedAt ||= at;
	state.lifecycle = "killing";
}

/** Revive a stopped logical child for a new process incarnation. */
export function reviveForResume(state: LifecycleState): void {
	state.processState = "alive";
	state.killRequestedAt = undefined;
	state.settledAt = undefined;
	state.settlementStatus = "pending";
	resetRunViewForSession(state);
}

/** Clear session-specific live state without resetting the process-wide settlement cursor. */
export function resetRunViewForSession(state: LifecycleState): void {
	if (isLifecycleTerminal(state)) return;
	state.state = "starting";
	state.lifecycle = "idle";
	state.runState = "idle";
	state.runOutcome = "pending";
	state.runs = [];
	state.tentativeError = undefined;
	state.finalError = undefined;
}

/** Settle one run while leaving the child process alive and re-enterable. */
export function settleRunToIdle(
	state: LifecycleState,
	at: number,
	outcome?: Exclude<RunOutcome, "pending">,
	stopReason?: string,
	errorMessage?: string,
): SubagentState | undefined {
	if (isLifecycleTerminal(state)) return state.state;
	const run = currentRun(state);
	if (run?.phase === "active") {
		if (run.corroborated) return undefined;
		state.runs.pop();
	}
	const settled = currentRun(state);
	if (settled?.phase !== "ended" || settled.id <= state.lastSettledRunId)
		return undefined;
	if (stopReason) settled.stopReason = stopReason;
	if (stopReason === "aborted") settled.outcome = "aborted";
	else if (
		outcome &&
		!(settled.outcome === "aborted" && outcome === "succeeded")
	)
		settled.outcome = outcome;
	if (errorMessage) settled.error = errorMessage;
	state.lastSettledRunId = Math.max(state.lastSettledRunId, settled.id);
	state.settledAt = at;
	state.settlementStatus = "settled";
	state.runState = "idle";
	state.lifecycle = "idle";
	state.tentativeError = undefined;
	state.runOutcome = settled.outcome;
	if (settled.outcome === "failed") {
		state.state = "error";
		state.finalError =
			settled.error || errorMessage || "Assistant response failed";
	} else if (settled.outcome === "aborted") {
		state.state = "running";
		state.finalError = undefined;
	} else {
		state.state = "done";
		state.finalError = undefined;
	}
	return state.state;
}

/** Backward-compatible name: settlement is now per-run and non-terminal. */
export function settleLifecycle(
	state: LifecycleState,
	at: number,
): SubagentState | undefined {
	return settleRunToIdle(state, at);
}

export function markStopped(
	state: LifecycleState,
	at: number,
	exit?: {
		code?: number | null;
		signal?: NodeJS.Signals | null;
		error?: string;
	},
): SubagentState {
	if (isLifecycleTerminal(state)) return state.state;
	const last = currentRun(state);
	const closedWithoutSettlement =
		state.runSequence > state.lastSettledRunId ||
		(last !== undefined && last.id > state.lastSettledRunId);
	if (closedWithoutSettlement)
		state.settlementStatus = "closed_without_settlement";
	state.processState = "stopped";
	state.settledAt = at;
	state.runState = "idle";
	state.tentativeError = undefined;
	if (state.killRequestedAt) {
		state.state = "killed";
		state.lifecycle = "killed";
		state.finalError = state.finalError || "Killed";
		return state.state;
	}
	const settledOutcome = last?.outcome || state.runOutcome;
	if (
		(last && last.id <= state.lastSettledRunId) ||
		(!last && state.settlementStatus === "settled")
	) {
		state.state = settledOutcome === "failed" ? "error" : "done";
		state.lifecycle = state.state;
		state.finalError =
			settledOutcome === "failed"
				? last?.error || state.finalError || "Assistant response failed"
				: undefined;
		return state.state;
	}
	const failed = [...state.runs]
		.reverse()
		.find((candidate) => candidate.outcome === "failed");
	state.state = "error";
	state.lifecycle = "error";
	state.finalError =
		exit?.error ||
		failed?.error ||
		`Process exited before agent_settled${exit?.signal ? ` via signal ${exit.signal}` : ` with code ${exit?.code ?? "unknown"}`}`;
	return state.state;
}

export function closeBeforeSettlement(
	state: LifecycleState,
	at: number,
	exit: { code: number | null; signal: NodeJS.Signals | null },
): SubagentState {
	return markStopped(state, at, exit);
}

export function lifecycleActivity(
	state: Pick<LifecycleState, "lifecycle" | "runState" | "processState">,
	activity: { currentTool?: string; isStreaming: boolean; lastTool?: string },
): string {
	if (state.lifecycle === "killing") return "killing";
	if (state.processState === "stopped") return state.lifecycle;
	if (activity.currentTool) return `tool: ${activity.currentTool}`;
	if (activity.isStreaming) return "responding";
	if (state.runState === "retrying") return "retrying";
	if (state.runState === "finishing") return "finishing";
	if (activity.lastTool) return `tool: ${activity.lastTool}`;
	return "idle";
}
