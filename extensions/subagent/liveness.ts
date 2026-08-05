export const HEARTBEAT_SWEEP_MS = 5_000;
export const HEARTBEAT_IDLE_MS = 10_000;
export const HEARTBEAT_RESPONSE_MS = 15_000;
export const RECONNECT_GRACE_MS = 30_000;
export const WATCHDOG_STALL_MS = 15_000;
export const ZELLIJ_ACTION_TIMEOUT_MS = 2_500;
export const ZELLIJ_ACTION_KILL_GRACE_MS = 250;
export const CLEANUP_RETRY_DELAYS_MS = [0, 2_000, 10_000] as const;

export interface PendingHeartbeat {
	id: string;
	sentAt: number;
	deadlineAt: number;
	parentConnectionId: string;
	childConnectionId: string;
}

export interface TerminalCleanupState {
	status: "none" | "pending" | "complete" | "failed";
	attempts: number;
	nextAttemptAt?: number;
	lastError?: string;
}

export type IpcLivenessState =
	| "healthy"
	| "awaiting_pong"
	| "reconnecting"
	| "dead";

export function pingDue(
	handle: {
		processState: "alive" | "stopped";
		connected: boolean;
		lastIpcFrameAt: number;
		pendingHeartbeat?: PendingHeartbeat;
	},
	now: number,
): boolean {
	return (
		handle.processState === "alive" &&
		handle.connected &&
		!handle.pendingHeartbeat &&
		now - handle.lastIpcFrameAt >= HEARTBEAT_IDLE_MS
	);
}

export function heartbeatExpired(
	pending: PendingHeartbeat | undefined,
	now: number,
	parentConnectionId: string | undefined,
	childConnectionId: string | undefined,
): boolean {
	return !!(
		pending &&
		pending.deadlineAt <= now &&
		pending.parentConnectionId === parentConnectionId &&
		pending.childConnectionId === childConnectionId
	);
}

export function reconnectExpired(
	disconnectDeadlineAt: number | undefined,
	now: number,
	connected: boolean,
): boolean {
	return !connected && disconnectDeadlineAt !== undefined && disconnectDeadlineAt <= now;
}

export function parentStalled(lastSweepAt: number, now: number): boolean {
	return now - lastSweepAt > WATCHDOG_STALL_MS;
}
