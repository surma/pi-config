import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acquireLease,
	hasLeaseAuthority,
	LEASE_STALE_GRACE_MS,
	LEASE_TTL_MS,
	leasePath,
	maintainLeaseAuthority,
	releaseLease,
	type LeaseRecord,
} from "./owner.ts";
import {
	createRetainedCleanupLeaseManager,
	type RetainedCleanupLease,
} from "./retained-cleanup-leases.ts";

const owner = {
	ownerSessionFile: "/tmp/retained-owner.jsonl",
	ownerSessionId: "retained-owner-id",
};

function fixture(now: () => number) {
	let intervalCallback: (() => void) | undefined;
	let timerCleared = false;
	const manager = createRetainedCleanupLeaseManager({
		intervalMs: 10_000,
		now,
		maintainAuthority: maintainLeaseAuthority,
		release: releaseLease,
		setInterval: (callback) => {
			intervalCallback = callback;
			return { unref() {} } as unknown as NodeJS.Timeout;
		},
		clearInterval: () => {
			timerCleared = true;
			intervalCallback = undefined;
		},
	});
	return {
		manager,
		runInterval: () => intervalCallback?.(),
		timerCleared: () => timerCleared,
	};
}

async function retainedEntry(
	directory: string,
	controllerInstanceId: string,
	now: number,
): Promise<RetainedCleanupLease> {
	const acquired = await acquireLease(directory, owner, controllerInstanceId, now);
	if (!acquired.held) throw new Error("fixture lease acquisition failed");
	return { agentDir: directory, owner, controllerInstanceId };
}

test("an arbitrarily delayed retirement retry renews retained authority past normal expiry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-retained-cleanup-"));
	const controllerInstanceId = "controller-a";
	const t0 = 1_000_000;
	let current = t0;
	const f = fixture(() => current);
	const entry = await retainedEntry(directory, controllerInstanceId, t0);

	assert.equal(await f.manager.retain(entry), true);
	current = t0 + LEASE_TTL_MS + LEASE_STALE_GRACE_MS + 1;
	assert.equal(
		await hasLeaseAuthority(directory, owner, controllerInstanceId, current),
		false,
		"the original lease really passed its ordinary expiry and grace window",
	);

	assert.equal(await f.manager.ensureAuthority(), true);
	let retirementRetried = false;
	if (await hasLeaseAuthority(directory, owner, controllerInstanceId, current))
		retirementRetried = true;
	assert.equal(retirementRetried, true);
	const renewed = JSON.parse(await readFile(leasePath(directory, owner), "utf8")) as LeaseRecord;
	assert.equal(renewed.renewedAt, current);
	assert.equal(renewed.expiresAt, current + LEASE_TTL_MS);

	await f.manager.resolveAfterRetirements();
	assert.equal(f.manager.retainedCount(), 0);
	assert.equal(f.timerCleared(), true);
	assert.equal(
		await hasLeaseAuthority(directory, owner, controllerInstanceId, current),
		false,
	);
});

test("the process-global style interval maintains every unresolved retained owner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-retained-cleanup-"));
	let current = 2_000_000;
	const f = fixture(() => current);
	const first = await retainedEntry(directory, "controller-a", current);
	const secondOwner = {
		ownerSessionFile: "/tmp/retained-owner-two.jsonl",
		ownerSessionId: "retained-owner-two-id",
	};
	const secondResult = await acquireLease(directory, secondOwner, "controller-a", current);
	if (!secondResult.held) return assert.fail("second fixture lease acquisition failed");
	const second = { ...first, owner: secondOwner };
	await f.manager.retain(first);
	await f.manager.retain(second);

	current += 20_000;
	f.runInterval();
	assert.equal(await f.manager.ensureAuthority(), true);
	assert.equal(await hasLeaseAuthority(directory, owner, "controller-a", current), true);
	assert.equal(await hasLeaseAuthority(directory, secondOwner, "controller-a", current), true);
	assert.equal(f.manager.retainedCount(), 2);
	await f.manager.finalQuit();
	assert.equal(f.manager.retainedCount(), 0);
	assert.equal(f.timerCleared(), true);
});

test("unavailable old authority blocks the provisioning gate and is never stolen back", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-retained-cleanup-"));
	const t0 = 3_000_000;
	let current = t0;
	const f = fixture(() => current);
	const entry = await retainedEntry(directory, "controller-a", t0);
	await f.manager.retain(entry);

	current = t0 + LEASE_TTL_MS + LEASE_STALE_GRACE_MS + 1;
	const successor = await acquireLease(directory, owner, "controller-b", current);
	assert.equal(successor.held, true);
	let provisions = 0;
	if (await f.manager.ensureAuthority()) provisions++;
	assert.equal(provisions, 0, "new provisioning must not run without old cleanup authority");
	const onDisk = JSON.parse(await readFile(leasePath(directory, owner), "utf8")) as LeaseRecord;
	assert.equal(onDisk.controllerInstanceId, "controller-b");

	await releaseLease(directory, owner, "controller-b");
	assert.equal(
		await f.manager.ensureAuthority(),
		false,
		"the old controller must not recreate an absent retained lease after successor release",
	);
	await assert.rejects(readFile(leasePath(directory, owner), "utf8"), /ENOENT/);
	await f.manager.finalQuit();
});
