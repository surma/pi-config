import assert from "node:assert/strict";
import test from "node:test";
import {
	HEARTBEAT_IDLE_MS,
	HEARTBEAT_RESPONSE_MS,
	RECONNECT_GRACE_MS,
	WATCHDOG_STALL_MS,
	heartbeatExpired,
	parentStalled,
	pingDue,
	reconnectExpired,
	type PendingHeartbeat,
} from "./liveness.ts";

const pending: PendingHeartbeat = {
	id: "ping",
	sentAt: 10_000,
	deadlineAt: 10_000 + HEARTBEAT_RESPONSE_MS,
	parentConnectionId: "parent",
	childConnectionId: "child",
};

test("heartbeat decisions honor threshold boundaries", () => {
	assert.equal(
		pingDue({ processState: "alive", connected: true, lastIpcFrameAt: 0 }, HEARTBEAT_IDLE_MS - 1),
		false,
	);
	assert.equal(
		pingDue({ processState: "alive", connected: true, lastIpcFrameAt: 0 }, HEARTBEAT_IDLE_MS),
		true,
	);
	assert.equal(heartbeatExpired(pending, pending.deadlineAt - 1, "parent", "child"), false);
	assert.equal(heartbeatExpired(pending, pending.deadlineAt, "parent", "child"), true);
});

test("reconnect and stall decisions honor threshold boundaries", () => {
	assert.equal(reconnectExpired(RECONNECT_GRACE_MS, RECONNECT_GRACE_MS - 1, false), false);
	assert.equal(reconnectExpired(RECONNECT_GRACE_MS, RECONNECT_GRACE_MS, false), true);
	assert.equal(parentStalled(0, WATCHDOG_STALL_MS), false);
	assert.equal(parentStalled(0, WATCHDOG_STALL_MS + 1), true);
});

test("stopped handles and stale epochs never receive liveness decisions", () => {
	assert.equal(
		pingDue({ processState: "stopped", connected: true, lastIpcFrameAt: 0 }, HEARTBEAT_IDLE_MS),
		false,
	);
	assert.equal(heartbeatExpired(pending, pending.deadlineAt, "other", "child"), false);
	assert.equal(heartbeatExpired(pending, pending.deadlineAt, "parent", "other"), false);
	assert.equal(reconnectExpired(0, RECONNECT_GRACE_MS, true), false);
});
