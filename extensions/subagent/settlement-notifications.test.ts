import assert from "node:assert/strict";
import test from "node:test";
import {
	type SettlementCustomMessage,
	SettlementNotificationQueue,
	type SettlementNotificationRecord,
} from "./settlement-notifications.ts";

const delay = (milliseconds: number) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

function record(
	childId: string,
	runId: number,
	outcome: SettlementNotificationRecord["outcome"] = "succeeded",
): SettlementNotificationRecord {
	return {
		ownerSessionFile: "/tmp/owner.jsonl",
		ownerSessionId: "owner-session",
		childId,
		name: `name-${childId}`,
		incarnation: `inc-${childId}`,
		runId,
		eventKind: "run_settled",
		outcome,
		childAlive: true,
		preview: `preview ${childId}/${runId}`,
	};
}

test("one accepted settlement sends one steering notification", async () => {
	const sent: { message: SettlementCustomMessage; options: unknown }[] = [];
	const queue = new SettlementNotificationQueue(
		(message, options) => sent.push({ message, options }),
		() => true,
	);
	const settlement = record("a", 1);
	queue.queue(settlement);
	queue.queue(settlement);
	await delay(75);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});
	assert.deepEqual(sent[0]?.message.details.settlements, [settlement]);
	assert.match(sent[0]?.message.content || "", /subagent_result/);
});

test("nearby child settlements form one batch with accurate outcomes", async () => {
	const sent: SettlementCustomMessage[] = [];
	const queue = new SettlementNotificationQueue(
		(message) => sent.push(message),
		() => true,
	);
	queue.queue(record("a", 1, "failed"));
	queue.queue(record("b", 1, "aborted"));
	queue.queue(record("a", 2, "succeeded"));
	await delay(75);
	assert.equal(sent.length, 1);
	assert.deepEqual(
		sent[0]?.details.settlements.map((item) => [
			item.childId,
			item.runId,
			item.outcome,
		]),
		[
			["a", 1, "failed"],
			["b", 1, "aborted"],
			["a", 2, "succeeded"],
		],
	);
});

test("a synchronous send failure retries once without losing deduplication", async () => {
	const sent: SettlementCustomMessage[] = [];
	let attempts = 0;
	const queue = new SettlementNotificationQueue(
		(message) => {
			attempts++;
			if (attempts === 1) throw new Error("temporary send failure");
			sent.push(message);
		},
		() => true,
	);
	let failedAttempts = 0;
	const failingQueue = new SettlementNotificationQueue(
		() => {
			failedAttempts++;
			throw new Error("persistent send failure");
		},
		() => true,
	);
	const settlement = record("retry", 1);
	queue.queue(settlement);
	failingQueue.queue(record("drop-after-retry", 1));
	await delay(125);
	assert.equal(attempts, 2);
	assert.equal(failedAttempts, 2);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]?.details.settlements, [settlement]);
	queue.queue(settlement);
	await delay(75);
	assert.equal(attempts, 2);
	assert.equal(failedAttempts, 2);
});

test("shutdown, lease loss, and explicit kill suppress pending records", async () => {
	const sent: SettlementCustomMessage[] = [];
	let eligible = true;
	const queue = new SettlementNotificationQueue(
		(message) => sent.push(message),
		() => eligible,
	);
	queue.queue(record("killed", 1));
	queue.suppressChild("killed");
	queue.queue(record("lease-lost", 1));
	eligible = false;
	await delay(75);
	queue.queue(record("shutdown", 1));
	queue.suppressAll();
	await delay(75);
	assert.deepEqual(sent, []);
});
