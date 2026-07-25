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
	reconcileRegistry,
	reconcileRegistryForOwner,
	saveRegistry,
} from "./registry.ts";
import type { PaneInfo } from "./zellij.ts";

const owner: OwnerIdentity = {
	ownerSessionFile: "/tmp/owner.jsonl",
	ownerSessionId: "owner-uuid",
};

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		childId: "child",
		task: "task",
		cwd: "/tmp",
		tabId: 1,
		paneId: 2,
		sessionDir: "/tmp/session",
		socketPath: "/tmp/session/sock",
		requestedModel: "p/m",
		requestedThinking: "off",
		configuredTools: [],
		processState: "alive",
		runState: "idle",
		createdAt: 1,
		lastActivityAt: 1,
		ownerSessionFile: owner.ownerSessionFile,
		ownerSessionId: owner.ownerSessionId,
		controllerInstanceId: "controller-a",
		incarnation: "incarnation-a",
		...overrides,
	};
}
function pane(childId = "child"): PaneInfo {
	return {
		id: 2,
		tab_id: 1,
		is_plugin: false,
		exited: false,
		pane_command: "pi",
		terminal_command: `env PI_SUBAGENT_CHILD_ID=${childId} PI_SUBAGENT_OWNER_SESSION_FILE=${owner.ownerSessionFile} PI_SUBAGENT_OWNER_SESSION_ID=${owner.ownerSessionId} PI_SUBAGENT_CONTROLLER_INSTANCE_ID=controller-a PI_SUBAGENT_INCARNATION=incarnation-a BRIDGE_SOCKET_PATH=/tmp/session/sock pi`,
	};
}

test("registry writes atomically with restrictive mode and reads back", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-registry-"));
	const path = join(dir, "registry.json");
	const entries = [entry()];
	await saveRegistry(entries, path);
	assert.deepEqual(await loadRegistry(path), entries);
	assert.match(await readFile(path, "utf8"), /"childId"/);
	await writeFile(`${path}.tmp-crash`, "partial");
	assert.deepEqual(await loadRegistry(path), entries);
});

test("reconcile keeps only registered matching live Pi panes alive", async () => {
	const known = entry();
	const dead = entry({ childId: "dead", tabId: 3, paneId: 4 });
	const panes: PaneInfo[] = [
		pane(),
		{ id: 99, tab_id: 99, is_plugin: false, exited: false, pane_command: "pi" },
	];
	const result = await reconcileRegistry([known, dead], panes);
	assert.equal(result[0]?.processState, "alive");
	assert.equal(result[1]?.processState, "stopped");
	assert.equal(result.length, 2);
});

test("re-listened sockets reject a hello with the wrong stable child identity", () => {
	assert.equal(helloMatchesRegistryChild("expected", "expected"), true);
	assert.equal(helloMatchesRegistryChild("expected", "recycled-child"), false);
	assert.equal(helloMatchesRegistryChild("expected", undefined), false);
});

test("recycled pane identity is rejected for non-Pi and unrelated Pi processes", async () => {
	const nonPi = await reconcileRegistry(
		[entry()],
		[
			{
				id: 2,
				tab_id: 1,
				is_plugin: false,
				exited: false,
				pane_command: "bash",
				terminal_command: "bash",
			},
		],
	);
	assert.equal(nonPi[0]?.processState, "stopped");
	const unrelatedPi = await reconcileRegistry(
		[entry()],
		[pane("different-child")],
	);
	assert.equal(unrelatedPi[0]?.processState, "stopped");
});

test("reconcileRegistryForOwner keeps only same-owner entries", () => {
	const mine = entry();
	const foreignOwner = entry({
		childId: "foreign-owner",
		ownerSessionFile: "/tmp/other.jsonl",
		ownerSessionId: "other-uuid",
	});
	const foreignSessionId = entry({
		childId: "foreign-session-id",
		ownerSessionId: "other-session-id",
	});
	const foreignController = entry({
		childId: "foreign-controller",
		controllerInstanceId: "controller-b",
	});
	const noIncarnation = entry({
		childId: "no-inc",
		incarnation: "",
	});
	const panes: PaneInfo[] = [pane()];
	const result = reconcileRegistryForOwner(
		[mine, foreignOwner, foreignSessionId, foreignController, noIncarnation],
		panes,
		owner,
	);
	assert.equal(result.length, 2);
	assert.ok(result.some((e) => e.childId === "child"));
	assert.ok(result.some((e) => e.childId === "foreign-controller"));
});

test("reconcileRegistryForOwner marks absent same-owner children stopped", () => {
	const mine = entry();
	const result = reconcileRegistryForOwner([mine], [], owner);
	assert.equal(result.length, 1);
	assert.equal(result[0]?.processState, "stopped");
});

test("reconcileRegistryForOwner preserves stopped entries", () => {
	const stopped = entry({ processState: "stopped" });
	const result = reconcileRegistryForOwner([stopped], [pane()], owner);
	assert.equal(result.length, 1);
	assert.equal(result[0]?.processState, "stopped");
});

test("registry round-trips the new owner and incarnation fields", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-registry-owner-"));
	const path = join(dir, "registry.json");
	const entries = [entry()];
	await saveRegistry(entries, path);
	const loaded = await loadRegistry(path);
	assert.deepEqual(loaded, entries);
	assert.equal(loaded[0]?.ownerSessionFile, owner.ownerSessionFile);
	assert.equal(loaded[0]?.controllerInstanceId, "controller-a");
	assert.equal(loaded[0]?.incarnation, "incarnation-a");
});
