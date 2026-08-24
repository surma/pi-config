import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import childSubagentExtension, {
	CHILD_EXTENSION_HEALTH_SIGNAL,
	childExtensionHealthPath,
	createChildLeaseMonitor,
	isValidChildLeaseRecord,
	verifyChildExtensionHealth,
	waitForChildExtensionHealth,
	writeChildExtensionHealthSignal,
} from "./child.ts";

const identity = {
	ownerSessionFile: "/tmp/parent.jsonl",
	ownerSessionId: "parent-session",
	controllerInstanceId: "controller-a",
};

function record(expiresAt: number): Record<string, unknown> {
	return {
		ownerSessionFile: identity.ownerSessionFile,
		ownerSessionId: identity.ownerSessionId,
		controllerInstanceId: identity.controllerInstanceId,
		expiresAt,
	};
}

test("child extension leaves native run settlement with the RPC host", () => {
	const registered: string[] = [];
	childSubagentExtension({
		on(name: string) {
			registered.push(name);
			return undefined;
		},
	} as never);
	assert.deepEqual(registered, [
		"session_start",
		"session_shutdown",
		"agent_start",
		"before_agent_start",
	]);
});

test("child lease validation requires exact identity and an unexpired finite expiry", () => {
	assert.equal(isValidChildLeaseRecord(record(1_001), identity, 1_000), true);
	assert.equal(isValidChildLeaseRecord(record(1_000), identity, 1_000), true);
	assert.equal(isValidChildLeaseRecord(record(999), identity, 1_000), false);
	assert.equal(
		isValidChildLeaseRecord(
			{ ...record(1_001), controllerInstanceId: "controller-b" },
			identity,
			1_000,
		),
		false,
	);
	assert.equal(isValidChildLeaseRecord({ ...record(Number.NaN) }, identity, 1_000), false);
	assert.equal(isValidChildLeaseRecord({ ...record(Number.POSITIVE_INFINITY) }, identity, 1_000), false);
	assert.equal(isValidChildLeaseRecord("not-json", identity, 1_000), false);
});

test("child extension health uses an exact bounded marker and rejects missing or bad signals", async () => {
	const directory = await fs.mkdtemp(join(tmpdir(), "pi-child-health-"));
	try {
		const path = childExtensionHealthPath(directory, "incarnation-a");
		assert.equal(await verifyChildExtensionHealth(path), false);
		assert.equal(
			await waitForChildExtensionHealth(path, { timeoutMs: 0 }),
			false,
		);
		assert.equal(await writeChildExtensionHealthSignal(path), true);
		assert.equal(await verifyChildExtensionHealth(path), true);
		assert.equal(
			await waitForChildExtensionHealth(path, { timeoutMs: 0 }),
			true,
		);
		await fs.writeFile(path, `${CHILD_EXTENSION_HEALTH_SIGNAL}extra`);
		assert.equal(await verifyChildExtensionHealth(path), false);
		await fs.writeFile(path, "bad-health-marker");
		assert.equal(await verifyChildExtensionHealth(path), false);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("child lease checks do not overlap and stale generations cannot fence a healthy child", async () => {
	let releaseFirst!: () => void;
	let firstStarted!: () => void;
	let secondStarted!: () => void;
	const first = new Promise<void>((resolve) => {
		firstStarted = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const second = new Promise<void>((resolve) => {
		secondStarted = resolve;
	});
	let reads = 0;
	let activeReads = 0;
	let maximumActiveReads = 0;
	let terminations = 0;
	const valid = record(Date.now() + 60_000);
	const monitor = createChildLeaseMonitor({
		leasePath: "/tmp/lease.json",
		identity,
		intervalMs: 60_000,
		readLease: async () => {
			reads++;
			activeReads++;
			maximumActiveReads = Math.max(maximumActiveReads, activeReads);
			try {
				if (reads === 1) {
					firstStarted();
					await release;
					return { ...valid, expiresAt: 0 };
				}
				secondStarted();
				return valid;
			} finally {
				activeReads--;
			}
		},
		terminate: () => terminations++,
	});
	monitor.start();
	await first;
	monitor.checkNow();
	monitor.stop();
	monitor.start();
	releaseFirst();
	await second;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(maximumActiveReads, 1);
	assert.equal(terminations, 0);
	monitor.stop();
});

test("temporary lease read errors retry before self-termination", async () => {
	let releaseFirst!: () => void;
	let firstStarted!: () => void;
	const first = new Promise<void>((resolve) => {
		firstStarted = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let reads = 0;
	let terminations = 0;
	const monitor = createChildLeaseMonitor({
		leasePath: "/tmp/lease.json",
		identity,
		intervalMs: 60_000,
		maxReadErrors: 2,
		readLease: async () => {
			reads++;
			if (reads === 1) {
				firstStarted();
				await release;
				throw new Error("temporary read failure");
			}
			return record(Date.now() + 60_000);
		},
		terminate: () => terminations++,
	});
	monitor.start();
	await first;
	monitor.checkNow();
	releaseFirst();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(reads, 2);
	assert.equal(terminations, 0);
	monitor.stop();
});
