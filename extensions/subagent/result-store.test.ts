import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	persistRunResult,
	readRunResult,
	runResultPaths,
	scanRunArtifacts,
} from "./result-store.ts";

test("each run keeps a unique exact result", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-run-results-"));
	await persistRunResult(directory, {
		runId: 1,
		outcome: "succeeded",
		incarnation: "inc-a",
		settledAt: 10,
		result: "first exact result",
	});
	await persistRunResult(directory, {
		runId: 2,
		outcome: "failed",
		incarnation: "inc-a",
		settledAt: 20,
		result: "second exact result",
	});
	assert.equal(
		await readFile(runResultPaths(directory, 1).resultPath, "utf8"),
		"first exact result",
	);
	assert.equal(
		await readFile(runResultPaths(directory, 2).resultPath, "utf8"),
		"second exact result",
	);
	const first = await readRunResult(directory, 1);
	assert.equal(first.status, "available");
	if (first.status === "available") {
		assert.equal(first.record.result, "first exact result");
		assert.equal(first.record.outcome, "succeeded");
	}
});

test("a missing run never falls back to a newer result", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-run-results-"));
	await persistRunResult(directory, {
		runId: 2,
		outcome: "aborted",
		incarnation: "inc-b",
		settledAt: 20,
		result: "newer result",
	});
	const missing = await readRunResult(directory, 1);
	assert.equal(missing.status, "missing");
	assert.equal(missing.reason, "artifact_missing");
});

test("repeated persistence keeps the first complete run pair", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-run-results-"));
	const first = await persistRunResult(directory, {
		runId: 3,
		outcome: "succeeded",
		incarnation: "inc-child",
		settledAt: 30,
		result: "child exact result",
	});
	const repeated = await persistRunResult(directory, {
		runId: 3,
		outcome: "failed",
		incarnation: "inc-parent",
		settledAt: 31,
		result: "different result",
	});
	assert.deepEqual(repeated, first);
	const stored = await readRunResult(directory, 3);
	assert.equal(stored.status, "available");
	if (stored.status === "available") {
		assert.equal(stored.record.result, "child exact result");
		assert.equal(stored.record.outcome, "succeeded");
		assert.equal(stored.record.incarnation, "inc-child");
	}
});

test("concurrent writers converge on one immutable complete pair", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-run-results-"));
	const candidates = [
		{
			runId: 4,
			outcome: "succeeded" as const,
			incarnation: "inc-a",
			settledAt: 40,
			result: "result-a",
		},
		{
			runId: 4,
			outcome: "failed" as const,
			incarnation: "inc-b",
			settledAt: 41,
			result: "result-b",
		},
	];
	const published = await Promise.all(
		candidates.map((candidate) => persistRunResult(directory, candidate)),
	);
	assert.deepEqual(published[0], published[1]);
	const winner = published[0];
	assert.ok(winner);
	assert.ok(
		candidates.some(
			(candidate) =>
				candidate.result === winner.result &&
				candidate.outcome === winner.outcome &&
				candidate.incarnation === winner.incarnation &&
				candidate.settledAt === winner.settledAt,
		),
	);
	const stored = await readRunResult(directory, 4);
	assert.equal(stored.status, "available");
	if (stored.status === "available") assert.deepEqual(stored.record, winner);
});

test("artifact scans reserve numeric directories and identify complete pairs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-run-results-scan-"));
	await persistRunResult(directory, {
		runId: 2,
		outcome: "succeeded",
		incarnation: "inc-a",
		settledAt: 20,
		result: "published",
	});
	const incomplete = runResultPaths(directory, 7);
	await mkdir(incomplete.directory, { recursive: true });
	await writeFile(incomplete.resultPath, "partial");
	const invalid = runResultPaths(directory, 9);
	await mkdir(invalid.directory, { recursive: true });
	await writeFile(invalid.resultPath, "result");
	await writeFile(invalid.metadataPath, "not-json");
	assert.deepEqual(await scanRunArtifacts(directory), {
		highestExistingRunId: 9,
		highestPublishedRunId: 2,
	});
});

test("reader distinguishes missing, incomplete, and invalid artifacts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-run-results-"));
	const missing = await readRunResult(directory, 5);
	assert.equal(missing.status, "missing");
	assert.equal(missing.reason, "artifact_missing");

	const incompletePaths = runResultPaths(directory, 6);
	await mkdir(incompletePaths.directory, { recursive: true });
	await writeFile(incompletePaths.resultPath, "partial");
	const incomplete = await readRunResult(directory, 6);
	assert.equal(incomplete.status, "incomplete");
	assert.equal(incomplete.reason, "artifact_incomplete");

	const invalidPaths = runResultPaths(directory, 7);
	await mkdir(invalidPaths.directory, { recursive: true });
	await writeFile(invalidPaths.resultPath, "result");
	await writeFile(invalidPaths.metadataPath, "not-json");
	const invalid = await readRunResult(directory, 7);
	assert.equal(invalid.status, "invalid_metadata");
	assert.equal(invalid.reason, "metadata_invalid");
});
