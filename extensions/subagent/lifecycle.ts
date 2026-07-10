export type SubagentState = "starting" | "running" | "done" | "error" | "killed";
export type SessionLifecycle = "starting" | "running" | "retrying" | "finishing" | "killing" | "done" | "error" | "killed";
export type RunPhase = "active" | "ended";
export type RunOutcome = "pending" | "succeeded" | "failed";

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
	state: SubagentState;
	lifecycle: SessionLifecycle;
	runSequence: number;
	runs: SubagentRun[];
	tentativeError?: string;
	finalError?: string;
	settledAt?: number;
	killRequestedAt?: number;
}

const MAX_RUN_HISTORY = 12;
const MAX_RUN_ERROR_LENGTH = 8 * 1024;

export function createLifecycleState(): LifecycleState {
	return { state: "starting", lifecycle: "starting", runSequence: 0, runs: [] };
}

export function currentRun(state: LifecycleState): SubagentRun | undefined {
	return state.runs[state.runs.length - 1];
}

export function isLifecycleTerminal(state: LifecycleState): boolean {
	return state.lifecycle === "done" || state.lifecycle === "error" || state.lifecycle === "killed";
}

export function startRun(state: LifecycleState, at: number): SubagentRun | undefined {
	if (isLifecycleTerminal(state) || currentRun(state)?.phase === "active") return undefined;
	const run: SubagentRun = {
		id: ++state.runSequence,
		phase: "active",
		outcome: "pending",
		startedAt: at,
		corroborated: false,
	};
	state.runs.push(run);
	if (state.runs.length > MAX_RUN_HISTORY) state.runs.splice(0, state.runs.length - MAX_RUN_HISTORY);
	state.state = "running";
	state.lifecycle = state.killRequestedAt ? "killing" : "running";
	state.tentativeError = undefined;
	state.finalError = undefined;
	return run;
}

export function corroborateRun(state: LifecycleState): boolean {
	if (isLifecycleTerminal(state)) return false;
	const run = currentRun(state);
	if (!run || run.phase !== "active") return false;
	run.corroborated = true;
	return true;
}

export function recordAssistantEnd(
	state: LifecycleState,
	message: { stopReason?: string; errorMessage?: string; assistantMessageGeneration?: number },
): void {
	if (!corroborateRun(state)) return;
	const run = currentRun(state)!;
	if (message.stopReason) run.stopReason = message.stopReason;
	if (message.assistantMessageGeneration !== undefined) run.assistantMessageGeneration = message.assistantMessageGeneration;
	const rawError = message.errorMessage?.trim();
	const error = rawError && rawError.length > MAX_RUN_ERROR_LENGTH ? `${rawError.slice(0, MAX_RUN_ERROR_LENGTH)}…` : rawError;
	if (message.stopReason === "error" || error) {
		run.outcome = "failed";
		run.error = error || "Assistant response failed";
		state.tentativeError = run.error;
	}
}

export function endRun(state: LifecycleState, at: number, willRetry: boolean): boolean {
	if (isLifecycleTerminal(state)) return false;
	const run = currentRun(state);
	if (!run || run.phase !== "active") return false;
	run.phase = "ended";
	run.corroborated = true;
	run.endedAt = at;
	if (run.outcome === "pending") run.outcome = "succeeded";
	state.state = "running";
	state.lifecycle = state.killRequestedAt ? "killing" : willRetry ? "retrying" : "finishing";
	return true;
}

export function requestKill(state: LifecycleState, at: number): void {
	if (isLifecycleTerminal(state)) return;
	state.killRequestedAt ||= at;
	state.lifecycle = "killing";
}

export function settleLifecycle(state: LifecycleState, at: number): SubagentState | undefined {
	if (isLifecycleTerminal(state)) return state.state;
	if (!state.killRequestedAt) {
		const run = currentRun(state);
		if (run?.phase === "active") {
			if (run.corroborated) return undefined;
			// A bare start after a completed run is only a candidate boundary. With no
			// accepted activity to corroborate it, settlement proves it was duplicate/late.
			state.runs.pop();
		}
	}
	state.settledAt = at;
	state.tentativeError = undefined;
	if (state.killRequestedAt) {
		state.state = "killed";
		state.lifecycle = "killed";
		state.finalError = "Killed";
		return state.state;
	}
	const run = [...state.runs].reverse().find((candidate) => candidate.phase === "ended");
	if (run?.outcome === "failed") {
		state.state = "error";
		state.lifecycle = "error";
		state.finalError = run.error || "Assistant response failed";
		return state.state;
	}
	if (run?.outcome === "succeeded") {
		state.state = "done";
		state.lifecycle = "done";
		state.finalError = undefined;
		return state.state;
	}
	state.state = "error";
	state.lifecycle = "error";
	state.finalError = "agent_settled arrived without an ended agent run";
	return state.state;
}

export function closeBeforeSettlement(
	state: LifecycleState,
	at: number,
	exit: { code: number | null; signal: NodeJS.Signals | null },
): SubagentState {
	if (isLifecycleTerminal(state)) return state.state;
	state.settledAt = at;
	state.tentativeError = undefined;
	if (state.killRequestedAt) {
		state.state = "killed";
		state.lifecycle = "killed";
		state.finalError = "Killed";
		return state.state;
	}
	const failed = [...state.runs].reverse().find((candidate) => candidate.outcome === "failed");
	state.state = "error";
	state.lifecycle = "error";
	state.finalError =
		failed?.error ||
		`Process exited before agent_settled${exit.signal ? ` via signal ${exit.signal}` : ` with code ${exit.code ?? "unknown"}`}`;
	return state.state;
}

export function lifecycleActivity(
	state: Pick<LifecycleState, "lifecycle">,
	activity: { currentTool?: string; isStreaming: boolean; lastTool?: string },
): string {
	if (state.lifecycle === "killing") return "killing";
	if (activity.currentTool) return `tool: ${activity.currentTool}`;
	if (activity.isStreaming) return "responding";
	if (state.lifecycle === "retrying") return "retrying";
	if (state.lifecycle === "finishing") return "finishing";
	if (activity.lastTool) return `tool: ${activity.lastTool}`;
	return state.lifecycle === "done" ? "final response" : state.lifecycle === "error" ? "error" : state.lifecycle === "killed" ? "killed" : "idle";
}
