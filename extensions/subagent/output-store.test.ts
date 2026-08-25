import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	MAX_OUTPUT_ERROR_BYTES,
	writeCallerOutput,
} from "./output-store.ts";

async function temporaryDirectory(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-caller-output-"));
}

test("omitted output path returns not_requested without touching the filesystem", async () => {
	const directory = await temporaryDirectory();
	assert.deepEqual(
		await writeCallerOutput({ content: "" }),
		{ status: "not_requested" },
	);
	assert.deepEqual(await readdir(directory), []);
});

test("an empty output creates the caller-selected path atomically", async () => {
	const directory = await temporaryDirectory();
	const path = join(directory, "nested", "empty.md");
	const result = await writeCallerOutput({ path, content: "" });
	assert.deepEqual(result, { status: "written", path });
	assert.equal(await readFile(path, "utf8"), "");
});

test("an existing deliverable returns collision and stays unchanged", async () => {
	const directory = await temporaryDirectory();
	const path = join(directory, "result.md");
	await writeFile(path, "first result", "utf8");
	assert.deepEqual(
		await writeCallerOutput({ path, content: "second result" }),
		{ status: "collision", path },
	);
	assert.deepEqual(
		await writeCallerOutput({ path, content: "third result" }),
		{ status: "collision", path },
	);
	assert.equal(await readFile(path, "utf8"), "first result");
});

test("concurrent writers publish one complete result and report one collision", async () => {
	const directory = await temporaryDirectory();
	const path = join(directory, "concurrent.md");
	const candidates = ["candidate one".repeat(10_000), "candidate two".repeat(10_000)];
	const results = await Promise.all(
		candidates.map((content) => writeCallerOutput({ path, content })),
	);
	assert.deepEqual(
		results.map((result) => result.status).sort(),
		["collision", "written"],
	);
	const published = await readFile(path, "utf8");
	assert.ok(candidates.includes(published));
	assert.deepEqual(
		(await readdir(directory)).filter((entry) => entry.startsWith(".pi-output.")),
		[],
	);
});

test("filesystem errors return failed instead of throwing", async () => {
	const directory = await temporaryDirectory();
	const parent = join(directory, "not-a-directory");
	await writeFile(parent, "occupied", "utf8");
	const path = join(parent, "result.md");
	const result = await writeCallerOutput({ path, content: "result" });
	assert.equal(result.status, "failed");
	if (result.status === "failed") {
		assert.equal(result.path, path);
		assert.notEqual(result.error, "");
	}
});

test("oversized filesystem errors return a bounded caller-output error", async () => {
	const directory = await temporaryDirectory();
	const path = join(directory, "x".repeat(4_000), "result.md");
	const result = await writeCallerOutput({ path, content: "result" });
	assert.equal(result.status, "failed");
	if (result.status === "failed") {
		assert.ok(Buffer.byteLength(result.error, "utf8") <= MAX_OUTPUT_ERROR_BYTES);
		assert.ok(result.error.length < path.length);
	}
});

test("an empty caller path is a failed request, not an implicit output", async () => {
	const result = await writeCallerOutput({ path: "", content: "result" });
	assert.deepEqual(result, {
		status: "failed",
		path: "",
		error: "The caller output path must be a non-empty string.",
	});
});

test("caller output larger than eight MiB is published exactly", async () => {
	const directory = await temporaryDirectory();
	const path = join(directory, "large.txt");
	const formerLimit = 8 * 1024 * 1024;
	const content = "x".repeat(formerLimit + 1);
	const result = await writeCallerOutput({ path, content });
	assert.deepEqual(result, { status: "written", path });
	assert.equal(await readFile(path, "utf8"), content);
});

test("filesystem waits return a failed status before they can hold the caller", async () => {
	const directory = await temporaryDirectory();
	const never = new Promise<never>(() => {});
	const started = Date.now();
	const result = await writeCallerOutput(
		{ path: join(directory, "stuck.txt"), content: "result" },
		{ timeoutMs: 25, io: { mkdir: async () => never } },
	);
	assert.equal(result.status, "failed");
	if (result.status === "failed") assert.match(result.error, /timed out/);
	assert.ok(Date.now() - started < 500);
});

test("cancellation returns a failed status without publishing output", async () => {
	const directory = await temporaryDirectory();
	const controller = new AbortController();
	controller.abort(new Error("caller canceled"));
	const path = join(directory, "canceled.txt");
	const result = await writeCallerOutput(
		{ path, content: "result" },
		{ signal: controller.signal },
	);
	assert.equal(result.status, "failed");
	assert.match(result.error, /caller canceled/);
	assert.deepEqual(await readdir(directory), []);
});
