import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile as readFileFs,
	rm as rmFs,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
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

test("stale regular-file locks are quarantined before a retry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lock-file-"));
	const path = join(directory, "record.json");
	const lockPath = `${path}.lock`;
	await writeFile(lockPath, "not-json\n", "utf8");
	const staleAt = new Date(Date.now() - LOCK_STALE_MS - 1_000);
	await utimes(lockPath, staleAt, staleAt);

	let entered = false;
	await withDirectoryLock(path, async () => {
		entered = true;
	}, "Test lock");

	assert.equal(entered, true);
	await assert.rejects(stat(lockPath), { code: "ENOENT" });
});

test("a live PID lock is never removed when its identity token is absent", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lock-live-"));
	const path = join(directory, "record.json");
	const lockPath = `${path}.lock`;
	await mkdir(lockPath);
	await writeFile(
		join(lockPath, "owner.json"),
		`${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - LOCK_STALE_MS - 1_000 })}\n`,
		"utf8",
	);
	const staleAt = new Date(Date.now() - LOCK_STALE_MS - 1_000);
	await utimes(lockPath, staleAt, staleAt);

	await assert.rejects(
		withDirectoryLock(path, async () => {}, "Live lock", {
			timeoutMs: 40,
			retryMs: 1,
			retries: 10,
		}),
		/operation timed out/,
	);
	assert.equal((await stat(lockPath)).isDirectory(), true);
});

test("a mismatched process start token allows safe PID-reuse quarantine", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lock-pid-reuse-"));
	const path = join(directory, "record.json");
	const lockPath = `${path}.lock`;
	await mkdir(lockPath);
	await writeFile(
		join(lockPath, "owner.json"),
		`${JSON.stringify({
			pid: process.pid,
			acquiredAt: Date.now() - LOCK_STALE_MS - 1_000,
			pidStartToken: "old-token",
		})}\n`,
		"utf8",
	);
	const staleAt = new Date(Date.now() - LOCK_STALE_MS - 1_000);
	await utimes(lockPath, staleAt, staleAt);
	const io = {
		readFile: async (readPath: string, encoding: "utf8") => {
			if (readPath === `/proc/${process.pid}/stat`) {
				const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "new-token"];
				return `123 (node) ${fields.slice(0, 1).join(" ")} ${fields.slice(1).join(" ")}`;
			}
			return readFileFs(readPath, encoding);
		},
	};
	let entered = false;
	await withDirectoryLock(path, async () => {
		entered = true;
	}, "PID reuse lock", { io });
	assert.equal(entered, true);
	await assert.rejects(stat(lockPath), { code: "ENOENT" });
});

test("filesystem acquisition waits have a finite deadline", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lock-timeout-"));
	const path = join(directory, "record.json");
	const never = new Promise<void>(() => {});
	const started = Date.now();
	await assert.rejects(
		withDirectoryLock(path, async () => {}, "Stuck lock", {
			timeoutMs: 25,
			io: { mkdir: async () => never },
		}),
		/timed out/,
	);
	assert.ok(Date.now() - started < 500);
});

test("the lock bounds an action that never settles", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lock-action-"));
	const path = join(directory, "record.json");
	const never = new Promise<void>(() => {});
	await assert.rejects(
		withDirectoryLock(path, async () => never, "Stuck action", { timeoutMs: 25 }),
		/timed out/,
	);
});

test("a timed-out cleanup cannot remove a later lock acquisition", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lock-late-cleanup-"));
	const path = join(directory, "record.json");
	const lockPath = `${path}.lock`;
	let releaseLateCleanup!: () => void;
	const lateCleanup = new Promise<void>((resolve) => {
		releaseLateCleanup = resolve;
	});
	let releaseAction!: () => void;
	const action = new Promise<void>((resolve) => {
		releaseAction = resolve;
	});
	let cleanupStarted = false;
	let firstCleanup = true;
	const io = {
		rm: async (target: string, options: { recursive: boolean; force: boolean }) => {
			if (target === lockPath && firstCleanup) {
				firstCleanup = false;
				cleanupStarted = true;
				await rmFs(target, options);
				await lateCleanup;
				await rmFs(target, options);
				return;
			}
			await rmFs(target, options);
		},
	};
	const started = Date.now();
	const first = withDirectoryLock(
		path,
		async () => action,
		"First lock",
		{ timeoutMs: 25, io },
	);
	await assert.rejects(first, /timed out/);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(cleanupStarted, true);
	assert.ok(Date.now() - started < 150);
	try {
		let entered = false;
		await assert.rejects(
			withDirectoryLock(
				path,
				async () => {
					entered = true;
				},
				"Second lock",
				{ timeoutMs: 25, retryMs: 1, retries: 100, io },
			),
			/timed out/,
		);
		assert.equal(entered, false);
	} finally {
		releaseLateCleanup();
		releaseAction();
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
	let entered = false;
	await withDirectoryLock(
		path,
		async () => {
			entered = true;
		},
		"Third lock",
		{ io },
	);
	assert.equal(entered, true);
	await assert.rejects(stat(lockPath), { code: "ENOENT" });
});
