import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
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
	LEASE_STALE_GRACE_MS,
	LEASE_TTL_MS,
	type LeaseRecord,
	leasePath,
	maintainLeaseAuthority,
	ownerKey,
	ownerRegistryPath,
	readLeaseRecord,
	releaseLease,
	renewLease,
} from "./owner.ts";

const owner = {
	ownerSessionFile: "/Users/surma/sess.jsonl",
	ownerSessionId: "session-uuid",
};

test("canonical session identity stays stable before and after file creation", async () => {
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

test("owner paths use a stable 24-character hash", () => {
	const key = ownerKey(owner.ownerSessionFile);
	assert.match(key, /^[0-9a-f]{24}$/);
	assert.equal(key, ownerKey(owner.ownerSessionFile));
	assert.notEqual(key, ownerKey("/Users/surma/other.jsonl"));
	const agentDir = "/tmp/agent";
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
});

test("acquire writes a valid lease and same controller can reacquire", async () => {
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
	assert.equal((await acquireLease(dir, owner, "controller-a", now + 1_000)).held, true);
});

test("a foreign controller conflicts until expiry plus stale grace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const first = await acquireLease(dir, owner, "controller-a", 1_000_000);
	if (!first.held) return assert.fail("first acquire failed");
	const beforeGrace = first.lease.expiresAt + LEASE_STALE_GRACE_MS - 1;
	const blocked = await acquireLease(dir, owner, "controller-b", beforeGrace);
	assert.equal(blocked.conflict, true);
	if (!blocked.conflict) return;
	assert.equal(blocked.existing.controllerInstanceId, "controller-a");
	const reclaimed = await acquireLease(
		dir,
		owner,
		"controller-b",
		first.lease.expiresAt + LEASE_STALE_GRACE_MS + 1,
	);
	assert.equal(reclaimed.held, true);
});

test("renewal extends only the exact current lease", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	await acquireLease(dir, owner, "controller-a", t0);
	assert.equal(await renewLease(dir, owner, "controller-a", t0 + 5_000), true);
	const onDisk = JSON.parse(
		await readFile(leasePath(dir, owner), "utf8"),
	) as LeaseRecord;
	assert.equal(onDisk.expiresAt, t0 + 5_000 + LEASE_TTL_MS);
	assert.equal(onDisk.renewedAt, t0 + 5_000);
	assert.equal(await renewLease(dir, owner, "controller-b", t0 + 6_000), false);
	assert.equal(
		await renewLease(
			dir,
			{ ...owner, ownerSessionId: "other-session" },
			"controller-a",
			t0 + 6_000,
		),
		false,
	);
});

test("renewal can reclaim this controller's own expired record but not a takeover", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	const first = await acquireLease(dir, owner, "controller-a", t0);
	if (!first.held) return assert.fail("first acquire failed");
	const delayed = first.lease.expiresAt + 7 * 60 * 60 * 1_000;
	assert.equal(await hasLeaseAuthority(dir, owner, "controller-a", delayed), false);
	assert.equal(await renewLease(dir, owner, "controller-a", delayed), true);
	assert.equal(await hasLeaseAuthority(dir, owner, "controller-a", delayed), true);
	const takeover = await acquireLease(dir, owner, "controller-b", delayed + 1);
	assert.equal(takeover.held, false);
	assert.equal(await renewLease(dir, owner, "controller-a", delayed + 2), true);
});

test("renewal refuses a lease that another controller elected", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	const first = await acquireLease(dir, owner, "controller-a", t0);
	if (!first.held) return assert.fail("first acquire failed");
	const reclaimAt = first.lease.expiresAt + LEASE_STALE_GRACE_MS + 1;
	const takeover = await acquireLease(dir, owner, "controller-b", reclaimAt);
	assert.equal(takeover.held, true);
	assert.equal(await renewLease(dir, owner, "controller-a", reclaimAt + 1), false);
	assert.equal(
		(await readLeaseRecord(dir, owner))?.controllerInstanceId,
		"controller-b",
	);
});

test("maintenance fails closed when the lease is absent and extends an exact lease", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	assert.equal(
		await maintainLeaseAuthority(dir, owner, "controller-a", 1_000),
		false,
	);
	await assert.rejects(stat(leasePath(dir, owner)));
	const first = await acquireLease(dir, owner, "controller-a", 10_000);
	if (!first.held) return assert.fail("first acquire failed");
	const delayed = first.lease.expiresAt + LEASE_STALE_GRACE_MS + 1;
	assert.equal(
		await maintainLeaseAuthority(dir, owner, "controller-a", delayed),
		true,
	);
	assert.equal(await hasLeaseAuthority(dir, owner, "controller-a", delayed), true);
});

test("release deletes only the exact current lease", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	await acquireLease(dir, owner, "controller-a", 1_000_000);
	const path = leasePath(dir, owner);
	assert.equal(await releaseLease(dir, owner, "controller-b"), false);
	await stat(path);
	assert.equal(await releaseLease(dir, owner, "controller-a"), true);
	await assert.rejects(stat(path));
	assert.equal(await releaseLease(dir, owner, "controller-a"), false);
});

test("authority checks owner, controller, and expiry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-"));
	const t0 = 1_000_000;
	await acquireLease(dir, owner, "controller-a", t0);
	assert.equal(await hasLeaseAuthority(dir, owner, "controller-a", t0 + 1), true);
	assert.equal(await hasLeaseAuthority(dir, owner, "controller-b", t0 + 1), false);
	assert.equal(
		await hasLeaseAuthority(dir, { ...owner, ownerSessionId: "other" }, "controller-a", t0 + 1),
		false,
	);
	assert.equal(
		await hasLeaseAuthority(dir, owner, "controller-a", t0 + LEASE_TTL_MS + 1),
		false,
	);
});

test("concurrent acquire and stale reclaim elect one controller", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-concurrent-"));
	const initial = await Promise.all([
		acquireLease(dir, owner, "controller-a", 1_000_000),
		acquireLease(dir, owner, "controller-b", 1_000_000),
		acquireLease(dir, owner, "controller-c", 1_000_000),
	]);
	assert.equal(initial.filter((result) => result.held).length, 1);
	assert.equal(initial.filter((result) => result.conflict).length, 2);
	const current = await readLeaseRecord(dir, owner);
	assert.ok(current);
	const reclaimAt = current.expiresAt + LEASE_STALE_GRACE_MS + 1;
	const reclaim = await Promise.all([
		acquireLease(dir, owner, "controller-d", reclaimAt),
		acquireLease(dir, owner, "controller-e", reclaimAt),
	]);
	assert.equal(reclaim.filter((result) => result.held).length, 1);
	assert.equal(reclaim.filter((result) => result.conflict).length, 1);
});

test("empty or corrupt lease files behave as absent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-owner-lease-corrupt-"));
	const path = leasePath(dir, owner);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, "", { mode: 0o600 });
	assert.equal((await acquireLease(dir, owner, "controller-a", 1_000_000)).held, true);
});
