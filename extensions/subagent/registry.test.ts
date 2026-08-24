import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OwnerIdentity } from "./owner.ts";
import {
	MAX_REGISTRY_ENTRIES,
	MAX_REGISTRY_FILE_BYTES,
	loadRegistry,
	type RegistryEntry,
	registryEntriesForOwner,
	saveRegistry,
} from "./registry.ts";

const owner: OwnerIdentity = {
	ownerSessionFile: "/tmp/owner.jsonl",
	ownerSessionId: "owner-uuid",
};

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		childId: "child",
		task: "task",
		cwd: "/tmp",
		pid: 123,
		sessionDir: "/tmp/session",
		sessionFile: "/tmp/session/child.jsonl",
		promptPath: "/tmp/session/prompt.txt",
		requestedModel: "provider/model",
		requestedThinking: "off",
		processState: "alive",
		runState: "idle",
		runId: 1,
		lastSettledRunId: 1,
		createdAt: 1,
		lastActivityAt: 2,
		ownerSessionFile: owner.ownerSessionFile,
		ownerSessionId: owner.ownerSessionId,
		incarnation: "incarnation-a",
		...overrides,
	};
}

test("registry round trips RPC process identity atomically", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-registry-"));
	const path = join(dir, "registry.json");
	const entries = [entry({ exitSignal: "SIGINT" })];
	await saveRegistry(entries, path);
	assert.deepEqual(await loadRegistry(path), entries);
	assert.match(await readFile(path, "utf8"), /"pid": 123/);
	await writeFile(`${path}.tmp-crash`, "partial");
	assert.deepEqual(await loadRegistry(path), entries);
});

test("registry owner filtering excludes foreign owners and missing incarnations", () => {
	const mine = entry();
	const stopped = entry({ childId: "stopped", processState: "stopped" });
	const foreignOwner = entry({
		childId: "foreign-owner",
		ownerSessionFile: "/tmp/other.jsonl",
		ownerSessionId: "other-uuid",
	});
	const foreignSessionId = entry({ childId: "foreign-session", ownerSessionId: "other" });
	const noIncarnation = entry({ childId: "no-incarnation", incarnation: "" });
	const result = registryEntriesForOwner(
		[mine, stopped, foreignOwner, foreignSessionId, noIncarnation],
		owner,
	);
	assert.deepEqual(result.map((candidate) => candidate.childId), ["child", "stopped"]);
	assert.equal(result[0]?.processState, "alive");
	assert.equal(result[1]?.processState, "stopped");
});

test("registry loader ignores non-entry top-level values", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-registry-invalid-"));
	const path = join(dir, "registry.json");
	await writeFile(
		path,
		JSON.stringify([null, 4, { sessionDir: "/tmp/no-id" }, entry()]),
	);
	const loaded = await loadRegistry(path);
	assert.deepEqual(loaded, [entry()]);
});

test("registry loader rejects malformed owner-matching entries before reconciliation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-registry-malformed-"));
	const path = join(dir, "registry.json");
	await writeFile(
		path,
		JSON.stringify([
			entry({ cwd: undefined as unknown as string }),
			entry({ processState: "unknown" as never }),
			entry({ runState: "unknown" as never }),
			entry({ createdAt: Number.NaN }),
			entry({ ownerSessionId: undefined as unknown as string }),
			entry(),
		]),
	);
	assert.deepEqual(await loadRegistry(path), [entry()]);
});

test("registry loading rejects an oversized snapshot before JSON parsing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-registry-size-"));
	const path = join(dir, "registry.json");
	await writeFile(path, "x".repeat(MAX_REGISTRY_FILE_BYTES + 1), "utf8");
	await assert.rejects(loadRegistry(path), /Registry file exceeds/);
});

test("registry loading rejects an excessive entry count before validation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-registry-count-"));
	const path = join(dir, "registry.json");
	await writeFile(
		path,
		JSON.stringify(
			Array.from({ length: MAX_REGISTRY_ENTRIES + 1 }, (_, index) =>
				entry({ childId: `child-${index}` }),
			),
		),
		"utf8",
	);
	await assert.rejects(loadRegistry(path), /more than .* entries/);
});

test("registry saves reject bounded output before filesystem publication", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-registry-save-limit-"));
	await assert.rejects(
		saveRegistry([entry()], join(dir, "registry.json"), { maxOutputBytes: 100 }),
		/Registry output exceeds/,
	);
	await assert.rejects(
		saveRegistry(
			Array.from({ length: MAX_REGISTRY_ENTRIES + 1 }, (_, index) =>
				entry({ childId: `child-${index}` }),
			),
			join(dir, "too-many.json"),
		),
		/more than .* entries/,
	);
});

test("registry filesystem waits have a finite deadline", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-registry-timeout-"));
	const never = new Promise<never>(() => {});
	const started = Date.now();
	await assert.rejects(
		loadRegistry(join(dir, "registry.json"), {
			timeoutMs: 25,
			io: { open: async () => never },
		}),
		/timed out/,
	);
	assert.ok(Date.now() - started < 500);
	await assert.rejects(
		saveRegistry([entry()], join(dir, "save.json"), {
			timeoutMs: 25,
			io: { mkdir: async () => never },
		}),
		/timed out/,
	);
});
