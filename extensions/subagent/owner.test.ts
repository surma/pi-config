import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	acquireLease,
	canonicalOwnerSessionFile,
	controllerDir,
	hasLeaseAuthority,
	incarnationSocketDir,
	LEASE_STALE_GRACE_MS,
	LEASE_TTL_MS,
	type LeaseRecord,
	leasePath,
	maintainLeaseAuthority,
	ownerKey,
	ownerRegistryPath,
	releaseLease,
	renewLease,
} from "./owner.ts";

const owner = {
	ownerSessionFile: "/Users/surma/sess.jsonl",
	ownerSessionId: "session-uuid",
};

test("canonical session identity is stable before and after a file appears through a symlink", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-owner-canonical-"));
	const realDirectory = join(directory, "real");
	const aliasDirectory = join(directory, "alias");
	await mkdir(realDirectory);
	await symlink(realDirectory, aliasDirectory);
	const sessionFile = join(aliasDirectory, "parent.jsonl");
	const before = await canonicalOwnerSessionFile(sessionFile);
	await writeFile(sessionFile, "session\n");
	const after = await canonicalOwnerSessionFile(sessionFile);
	assert.equal(before, after);
	assert.equal(before, join(await realpath(realDirectory), "parent.jsonl"));
});

test("ownerKey is a stable 24-hex-char key derived from the session file", () => {
	const key = ownerKey(owner.ownerSessionFile);
	assert.match(key, /^[0-9a-f]{24}$/);
	assert.equal(key, ownerKey(owner.ownerSessionFile));
	assert.notEqual(key, ownerKey("/Users/surma/other.jsonl"));
});

test("controller-scoped paths nest under controllers/<ownerKey>", () => {
	const agentDir = "/tmp/agent";
	const key = ownerKey(owner.ownerSessionFile);
	assert.equal(
		controllerDir(agentDir, owner),
		join(agentDir, "sessions", "subagents", "controllers", key),
	);
	assert.equal(
		leasePath(agentDir, owner),
		join(controllerDir(agentDir, owner), "lease.json"),
	);
	assert.equal(
		ownerRegistryPath(agentDir, owner),
		join(controllerDir(agentDir, owner), "registry.json"),
	);
	assert.equal(
		incarnationSocketDir(agentDir, owner, "child1", "inc1"),
		join(
			controllerDir(agentDir, owner),
			"children",
			"child1",
			"inc1",
			"bridge.sock",
		),
	);
});

test("incarnation socket dirs for the same child differ by incarnation", () => {
	const agentDir = "/tmp/agent";
	const a = incarnationSocketDir(agentDir, owner, "child1", "inc-a");
	const b = incarnationSocketDir(agentDir, owner, "child1", "inc-b");
	assert.notEqual(a, b);
});

test("acquire writes a valid lease on an absent file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const now = 1_000_000;
	const result = await acquireLease(dir, owner, "controller-a", now);
	assert.equal(result.held, true);
	if (!result.held) return;
	assert.equal(result.lease.controllerInstanceId, "controller-a");
	assert.equal(result.lease.ownerSessionFile, owner.ownerSessionFile);
	assert.equal(result.lease.ownerSessionId, owner.ownerSessionId);
	assert.equal(result.lease.acquiredAt, now);
	assert.equal(result.lease.expiresAt, now + LEASE_TTL_MS);
	const onDisk = JSON.parse(
		await readFile(leasePath(dir, owner), "utf8"),
	) as LeaseRecord;
	assert.equal(onDisk.controllerInstanceId, "controller-a");
});

test("a second controller conflicts before lease expiry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	await acquireLease(dir, owner, "controller-a", t0);
	const result = await acquireLease(dir, owner, "controller-b", t0 + 1_000);
	assert.equal(result.conflict, true);
	if (!result.conflict) return;
	assert.equal(result.existing.controllerInstanceId, "controller-a");
	const onDisk = JSON.parse(
		await readFile(leasePath(dir, owner), "utf8"),
	) as LeaseRecord;
	assert.equal(onDisk.controllerInstanceId, "controller-a");
});

test("the same controller reacquiring returns held", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	await acquireLease(dir, owner, "controller-a", t0);
	const result = await acquireLease(dir, owner, "controller-a", t0 + 1_000);
	assert.equal(result.held, true);
});

test("a different controller reclaims after expiry plus grace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	const first = await acquireLease(dir, owner, "controller-a", t0);
	if (!first.held) return assert.fail("first acquire failed");
	const reclaimAt = first.lease.expiresAt + LEASE_STALE_GRACE_MS + 1;
	const result = await acquireLease(dir, owner, "controller-b", reclaimAt);
	assert.equal(result.held, true);
	if (!result.held) return;
	assert.equal(result.lease.controllerInstanceId, "controller-b");
});

test("a different controller cannot reclaim before expiry plus grace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	const first = await acquireLease(dir, owner, "controller-a", t0);
	if (!first.held) return assert.fail("first acquire failed");
	const beforeGrace = first.lease.expiresAt + LEASE_STALE_GRACE_MS - 1;
	const result = await acquireLease(dir, owner, "controller-b", beforeGrace);
	assert.equal(result.conflict, true);
});

test("renewLease extends expiry only for the current holder", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	await acquireLease(dir, owner, "controller-a", t0);
	const renewed = await renewLease(dir, owner, "controller-a", t0 + 5_000);
	assert.equal(renewed, true);
	const onDisk = JSON.parse(
		await readFile(leasePath(dir, owner), "utf8"),
	) as LeaseRecord;
	assert.equal(onDisk.controllerInstanceId, "controller-a");
	assert.equal(onDisk.expiresAt, t0 + 5_000 + LEASE_TTL_MS);
	assert.equal(onDisk.renewedAt, t0 + 5_000);
});

test("renewLease fails when the holder changed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	const first = await acquireLease(dir, owner, "controller-a", t0);
	if (!first.held) return assert.fail("first acquire failed");
	const reclaimAt = first.lease.expiresAt + LEASE_STALE_GRACE_MS + 1;
	await acquireLease(dir, owner, "controller-b", reclaimAt);
	const renewed = await renewLease(dir, owner, "controller-a", reclaimAt + 1);
	assert.equal(renewed, false);
	const onDisk = JSON.parse(
		await readFile(leasePath(dir, owner), "utf8"),
	) as LeaseRecord;
	assert.equal(onDisk.controllerInstanceId, "controller-b");
});

test("renewLease on an absent file returns false", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const renewed = await renewLease(dir, owner, "controller-a", 1_000);
	assert.equal(renewed, false);
});

test("retained authority maintenance fails closed when the exact lease is absent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	assert.equal(
		await maintainLeaseAuthority(dir, owner, "controller-a", 1_000),
		false,
	);
	await assert.rejects(stat(leasePath(dir, owner)));
});

test("retained authority can be safely maintained after its normal expiry window", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	const first = await acquireLease(dir, owner, "controller-a", t0);
	if (!first.held) return assert.fail("first acquire failed");
	const delayedAt = first.lease.expiresAt + LEASE_STALE_GRACE_MS + 1;
	assert.equal(await hasLeaseAuthority(dir, owner, "controller-a", delayedAt), false);
	assert.equal(
		await maintainLeaseAuthority(dir, owner, "controller-a", delayedAt),
		true,
	);
	assert.equal(await hasLeaseAuthority(dir, owner, "controller-a", delayedAt), true);
});

test("retained maintenance racing stale takeover never overwrites the elected holder", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	const first = await acquireLease(dir, owner, "controller-a", t0);
	if (!first.held) return assert.fail("first acquire failed");
	const reclaimAt = first.lease.expiresAt + LEASE_STALE_GRACE_MS + 1;
	const [reclaimed, maintained] = await Promise.all([
		acquireLease(dir, owner, "controller-b", reclaimAt),
		maintainLeaseAuthority(dir, owner, "controller-a", reclaimAt),
	]);
	const onDisk = JSON.parse(
		await readFile(leasePath(dir, owner), "utf8"),
	) as LeaseRecord;
	if (maintained) {
		assert.equal(reclaimed.conflict, true);
		assert.equal(onDisk.controllerInstanceId, "controller-a");
	} else {
		assert.equal(reclaimed.held, true);
		assert.equal(onDisk.controllerInstanceId, "controller-b");
	}
});

test("releaseLease deletes only when the holder matches", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	await acquireLease(dir, owner, "controller-a", t0);
	const path = leasePath(dir, owner);
	const foreignRelease = await releaseLease(dir, owner, "controller-b");
	assert.equal(foreignRelease, false);
	await stat(path);
	await releaseLease(dir, owner, "controller-a");
	await assert.rejects(stat(path));
});

test("releaseLease on an absent file returns false", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const released = await releaseLease(dir, owner, "controller-a");
	assert.equal(released, false);
});

test("concurrent lease creates do not both succeed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-concurrent-"));
	const now = 1_000_000;
	const results = await Promise.all([
		acquireLease(dir, owner, "controller-a", now),
		acquireLease(dir, owner, "controller-b", now),
		acquireLease(dir, owner, "controller-c", now),
	]);
	const holders = results.filter((r) => r.held);
	const conflicts = results.filter((r) => r.conflict);
	assert.equal(holders.length, 1, "exactly one holder");
	assert.equal(conflicts.length, 2, "two conflicts");
	const onDisk = JSON.parse(
		await readFile(leasePath(dir, owner), "utf8"),
	) as LeaseRecord;
	assert.ok(
		holders.some(
			(h) =>
				h.held && h.lease.controllerInstanceId === onDisk.controllerInstanceId,
		),
	);
});

test("concurrent stale reclaim elects exactly one new holder", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	const first = await acquireLease(dir, owner, "controller-a", t0);
	if (!first.held) return assert.fail("first acquire failed");
	const reclaimAt = first.lease.expiresAt + LEASE_STALE_GRACE_MS + 1;
	const results = await Promise.all([
		acquireLease(dir, owner, "controller-b", reclaimAt),
		acquireLease(dir, owner, "controller-c", reclaimAt),
	]);
	assert.equal(results.filter((result) => result.held).length, 1);
	assert.equal(results.filter((result) => result.conflict).length, 1);
});

test("renewal racing stale takeover cannot overwrite the elected holder", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	const first = await acquireLease(dir, owner, "controller-a", t0);
	if (!first.held) return assert.fail("first acquire failed");
	const reclaimAt = first.lease.expiresAt + LEASE_STALE_GRACE_MS + 1;
	const [reclaimed, renewed] = await Promise.all([
		acquireLease(dir, owner, "controller-b", reclaimAt),
		renewLease(dir, owner, "controller-a", reclaimAt),
	]);
	const onDisk = JSON.parse(
		await readFile(leasePath(dir, owner), "utf8"),
	) as LeaseRecord;
	if (renewed) {
		assert.equal(reclaimed.conflict, true);
		assert.equal(onDisk.controllerInstanceId, "controller-a");
	} else {
		assert.equal(reclaimed.held, true);
		assert.equal(onDisk.controllerInstanceId, "controller-b");
	}
});

test("release racing takeover cannot delete the new holder", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	const first = await acquireLease(dir, owner, "controller-a", t0);
	if (!first.held) return assert.fail("first acquire failed");
	const reclaimAt = first.lease.expiresAt + LEASE_STALE_GRACE_MS + 1;
	await Promise.all([
		acquireLease(dir, owner, "controller-b", reclaimAt),
		releaseLease(dir, owner, "controller-a"),
	]);
	const onDisk = JSON.parse(
		await readFile(leasePath(dir, owner), "utf8"),
	) as LeaseRecord;
	assert.ok(
		["controller-a", "controller-b"].includes(onDisk.controllerInstanceId),
	);
});

test("authority requires the exact unexpired owner and holder", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	await acquireLease(dir, owner, "controller-a", t0);
	assert.equal(
		await hasLeaseAuthority(dir, owner, "controller-a", t0 + 1),
		true,
	);
	assert.equal(
		await hasLeaseAuthority(dir, owner, "controller-b", t0 + 1),
		false,
	);
	assert.equal(
		await hasLeaseAuthority(
			dir,
			{ ...owner, ownerSessionId: "other-session" },
			"controller-a",
			t0 + 1,
		),
		false,
	);
	assert.equal(
		await hasLeaseAuthority(dir, owner, "controller-a", t0 + LEASE_TTL_MS + 1),
		false,
	);
});

test("a lease file that is empty or corrupt is treated as absent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const path = leasePath(dir, owner);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, "", { mode: 0o600 });
	const now = 1_000_000;
	const result = await acquireLease(dir, owner, "controller-a", now);
	assert.equal(result.held, true);
	await rm(dir, { recursive: true, force: true });
});
