import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LOCK_STALE_MS, withDirectoryLock } from "./lock.ts";

test("stale directory locks are quarantined before a retry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lock-"));
	const path = join(directory, "record.json");
	const lockPath = `${path}.lock`;
	await mkdir(lockPath);
	const staleAt = new Date(Date.now() - LOCK_STALE_MS - 1_000);
	await utimes(lockPath, staleAt, staleAt);

	let entered = false;
	await withDirectoryLock(path, async () => {
		entered = true;
	}, "Test lock");

	assert.equal(entered, true);
	await assert.rejects(stat(lockPath), { code: "ENOENT" });
});
