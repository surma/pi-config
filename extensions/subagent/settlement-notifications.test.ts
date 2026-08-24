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
		incarnation: `inc-${childId}`,
		runId,
		eventKind: "run_settled",
		outcome,
	};
}

test("one accepted settlement sends one exact steering wake", async () => {
	const sent: { message: SettlementCustomMessage; options: unknown }[] = [];
	const queue = new SettlementNotificationQueue(
		(message, options) => {
			sent.push({ message, options });
		},
		() => true,
	);
	const settlement = record("a", 1);
	queue.queue(settlement);
	queue.queue(settlement);
	await delay(25);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});
	assert.equal(
		sent[0]?.message.content,
		"Subagent a reached idle after run 1. Check subagent_status with numMessages=3.",
	);
	assert.deepEqual(sent[0]?.message.details.settlements, [settlement]);
});

test("nearby settlements each send one wake with complete details", async () => {
	const sent: { message: SettlementCustomMessage; options: unknown }[] = [];
	const queue = new SettlementNotificationQueue(
		(message, options) => {
			sent.push({ message, options });
		},
		() => true,
	);
	queue.queue(record("a", 1, "failed"));
	queue.queue(record("b", 1, "aborted"));
	queue.queue(record("a", 2, "succeeded"));
	await delay(25);
	assert.equal(sent.length, 3);
	assert.deepEqual(
		sent.map(({ message }) => [
			message.content,
			message.details.settlements[0],
		]),
		[
			[
				"Subagent a reached idle after run 1. Check subagent_status with numMessages=3.",
				record("a", 1, "failed"),
			],
			[
				"Subagent b reached idle after run 1. Check subagent_status with numMessages=3.",
				record("b", 1, "aborted"),
			],
			[
				"Subagent a reached idle after run 2. Check subagent_status with numMessages=3.",
				record("a", 2, "succeeded"),
			],
		],
	);
	for (const { options } of sent)
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
});

test("a synchronous send failure retries once without throwing or duplicating", async () => {
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
	const settlement = record("retry", 1);
	queue.queue(settlement);
	await delay(50);
	assert.equal(attempts, 2);
	assert.equal(sent.length, 1);
	queue.queue(settlement);
	await delay(25);
	assert.equal(attempts, 2);
	assert.deepEqual(sent[0]?.details.settlements, [settlement]);
});

test("child suppression cancels a retry after an asynchronous send failure", async () => {
	let attempts = 0;
	let started!: () => void;
	let rejectSend!: (error: Error) => void;
	const sendStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const queue = new SettlementNotificationQueue(
		() => {
			attempts++;
			if (attempts !== 1) return;
			started();
			return new Promise<void>((_resolve, reject) => {
				rejectSend = reject;
			});
		},
		() => true,
	);
	queue.queue(record("async-race", 1));
	await sendStarted;
	queue.suppressChild("async-race");
	rejectSend(new Error("send failed"));
	await delay(25);
	assert.equal(attempts, 1);
});

test("global suppression cancels records that await behind an in-flight send", async () => {
	let attempts = 0;
	let started!: () => void;
	let release!: () => void;
	const sendStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const send = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queue = new SettlementNotificationQueue(
		() => {
			attempts++;
			if (attempts === 1) {
				started();
				return send;
			}
		},
		() => true,
	);
	queue.queue(record("global-first", 1));
	queue.queue(record("global-second", 1));
	await sendStarted;
	queue.suppressAll();
	release();
	await delay(25);
	assert.equal(attempts, 1);
});

test("persistent send failure is bounded and duplicate records stay suppressed", async () => {
	let attempts = 0;
	const queue = new SettlementNotificationQueue(
		() => {
			attempts++;
			throw new Error("persistent send failure");
		},
		() => true,
	);
	const settlement = record("drop", 1);
	queue.queue(settlement);
	await delay(50);
	assert.equal(attempts, 2);
	queue.queue(settlement);
	await delay(25);
	assert.equal(attempts, 2);
});

test("notification flushes yield after a bounded batch", async () => {
	const sent: SettlementCustomMessage[] = [];
	let releaseFirstBatch!: () => void;
	let firstBatchReached!: () => void;
	const firstBatch = new Promise<void>((resolve) => {
		firstBatchReached = resolve;
	});
	const queue = new SettlementNotificationQueue((message) => {
		sent.push(message);
		if (sent.length !== 32) return;
		firstBatchReached();
		return new Promise<void>((resolve) => {
			releaseFirstBatch = resolve;
		});
	});
	for (let index = 1; index <= 40; index++)
		queue.queue(record(`batch-${index}`, index));
	await firstBatch;
	assert.equal(sent.length, 32);
	releaseFirstBatch();
	await delay(25);
	assert.equal(sent.length, 40);
});

test("invalid events, ineligible records, and suppressed records never wake the owner", async () => {
	const sent: SettlementCustomMessage[] = [];
	let eligible = true;
	const queue = new SettlementNotificationQueue(
		(message) => {
			sent.push(message);
		},
		() => eligible,
	);
	queue.queue({ ...record("pending", 1), outcome: "pending" } as never);
	queue.queue({ ...record("idle", 1), eventKind: "idle" } as never);
	queue.queue({ ...record("invalid-run", 0) });
	queue.queue(record("killed", 1));
	queue.suppressChild("killed");
	queue.queue(record("ineligible", 1));
	eligible = false;
	await delay(25);
	queue.queue(record("shutdown", 1));
	queue.suppressAll();
	await delay(25);
	assert.deepEqual(sent, []);
});
