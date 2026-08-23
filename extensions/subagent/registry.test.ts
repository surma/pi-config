import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OwnerIdentity } from "./owner.ts";
import {
	helloMatchesRegistryChild,
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
		sessionDir: "/tmp/session",
		requestedModel: "p/m",
		requestedThinking: "off",
		processState: "alive",
		runState: "idle",
		pid: 1234,
		createdAt: 1,
		lastActivityAt: 1,
		ownerSessionFile: owner.ownerSessionFile,
		ownerSessionId: owner.ownerSessionId,
		controllerInstanceId: "controller-a",
		incarnation: "incarnation-a",
		...overrides,
	};
}

test("registry writes entries atomically and reads them back", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-registry-"));
	const path = join(dir, "registry.json");
	const entries = [entry()];
	await saveRegistry(entries, path);
	assert.deepEqual(await loadRegistry(path), entries);
	assert.match(await readFile(path, "utf8"), /"sessionDir"/);
	await writeFile(`${path}.tmp-crash`, "partial");
	assert.deepEqual(await loadRegistry(path), entries);
});

test("optional fields can be omitted and round-trip cleanly", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-registry-optional-"));
	const path = join(dir, "registry.json");
	const minimal: RegistryEntry = {
		childId: "child",
		task: "task",
		cwd: "/tmp",
		sessionDir: "/tmp/session",
		requestedModel: "p/m",
		requestedThinking: "off",
		processState: "stopped",
		runState: "idle",
		createdAt: 1,
		lastActivityAt: 1,
		ownerSessionFile: owner.ownerSessionFile,
		ownerSessionId: owner.ownerSessionId,
		controllerInstanceId: "controller-a",
		incarnation: "incarnation-a",
	};
	await saveRegistry([minimal], path);
	assert.deepEqual(await loadRegistry(path), [minimal]);
});

test("re-listened sockets reject a hello with the wrong stable child identity", () => {
	assert.equal(helloMatchesRegistryChild("expected", "expected"), true);
	assert.equal(helloMatchesRegistryChild("expected", "recycled-child"), false);
	assert.equal(helloMatchesRegistryChild("expected", undefined), false);
});

test("owner filtering never uses pane state as a liveness oracle", () => {
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
