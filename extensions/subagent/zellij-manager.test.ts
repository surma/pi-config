import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedSessionPath } from "./owner.ts";
import {
	createManagedSessionName,
	createManagedSessionRecord,
	loadManagedSession,
	removeManagedSessionIfMatches,
	saveManagedSession,
	saveManagedSessionIfMatches,
} from "./managed-session.ts";
import { createDedicatedSession, deleteDedicatedSession } from "./zellij.ts";
import {
	createDedicatedLifecycleManager,
	type DedicatedLifecycle,
	type DedicatedLifecycleManager,
	type DedicatedLifecycleManagerDependencies,
} from "./zellij-manager.ts";

interface Fixture {
	directory: string;
	binary: string;
	calls: string;
	state: string;
	createMode: string;
	deleteMode: string;
	guardian: string;
	guardianLog: string;
	manager: DedicatedLifecycleManager;
	owner(id: string): { ownerSessionFile: string; ownerSessionId: string };
	setGuardianMode(mode: string): void;
	createManager(overrides?: Partial<DedicatedLifecycleManagerDependencies>): DedicatedLifecycleManager;
	establishWith(manager: DedicatedLifecycleManager, id: string, callbacks?: {
		unexpected?(error: Error): void;
		settle?(): Promise<void>;
		authority?(owner: { ownerSessionFile: string; ownerSessionId: string }): Promise<boolean>;
	}): Promise<DedicatedLifecycle>;
	establish(id: string, callbacks?: {
		unexpected?(error: Error): void;
		settle?(): Promise<void>;
		authority?(owner: { ownerSessionFile: string; ownerSessionId: string }): Promise<boolean>;
	}): Promise<DedicatedLifecycle>;
	retire(lifecycle: DedicatedLifecycle, settle?: () => Promise<void>): Promise<void>;
	close(): void;
}

async function fixture(): Promise<Fixture> {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-manager-"));
	const binary = join(directory, "zellij");
	const calls = join(directory, "zellij-calls");
	const state = join(directory, "zellij-sessions");
	const createMode = join(directory, "create-mode");
	const deleteMode = join(directory, "delete-mode");
	const guardian = join(directory, "guardian.mjs");
	const guardianLog = join(directory, "guardian-log");
	await writeFile(createMode, "ok");
	await writeFile(deleteMode, "ok");
	await writeFile(binary, `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
create_mode=$(cat ${JSON.stringify(createMode)})
delete_mode=$(cat ${JSON.stringify(deleteMode)})
if [ "$1" = attach ]; then
  [ "$create_mode" = slow ] && sleep 0.15
  [ "$create_mode" = fail ] && exit 7
  [ "$create_mode" = absent ] && exit 0
  printf '%s\n' "$3" > ${JSON.stringify(state)}
  exit 0
fi
if [ "$1" = list-sessions ]; then
  [ "$create_mode" = presence-fail ] && exit 8
  cat ${JSON.stringify(state)} 2>/dev/null
  exit 0
fi
if [ "$1" = delete-session ]; then
  [ "$delete_mode" = slow ] && sleep 0.15
  [ "$delete_mode" = fail ] && exit 9
  rm -f ${JSON.stringify(state)}
  exit 0
fi
exit 2
`);
	await chmod(binary, 0o755);
	await writeFile(guardian, `import { appendFileSync } from "node:fs";
const [sessionName, generation, capability] = process.argv.slice(2);
const mode = process.env.PI_TEST_GUARDIAN_MODE || "normal";
const log = process.env.PI_TEST_GUARDIAN_LOG;
const note = (value) => appendFileSync(log, value + "\\n");
note("start " + process.pid + " " + sessionName);
let disarmed = false;
let input = "";
let hold = setInterval(() => {}, 1000);
const finish = (code = 0) => { clearInterval(hold); process.exitCode = code; };
process.on("SIGTERM", () => { note("TERM " + process.pid); if (mode !== "hung") finish(0); });
if (mode === "premature") { note("premature"); finish(9); }
else {
  if (mode === "missing-ready-capability") process.stdout.write(JSON.stringify({ type: "ready", generation }) + "\\n");
  else if (mode === "wrong-ready-capability") process.stdout.write(JSON.stringify({ type: "ready", generation, capability: capability === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64) }) + "\\n");
  else if (mode !== "readiness-timeout") process.stdout.write(JSON.stringify({ type: "ready", generation, capability }) + "\\n");
  if (mode === "exit-during-provisioning") setTimeout(() => { note("unexpected-exit"); clearInterval(hold); process.exit(11); }, 25);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf("\\n");
      if (newline < 0) break;
      const line = input.slice(0, newline); input = input.slice(newline + 1);
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type !== "disarm" || frame.generation !== generation || frame.capability !== capability) continue;
      note("disarm " + generation + " " + capability);
      if (mode === "exit-before-ack") { clearInterval(hold); process.exit(12); }
      if (mode === "wrong-ack") process.stdout.write(JSON.stringify({ type: "ack", generation, capability: "wrong" }) + "\\n");
      else if (mode !== "missing-ack" && mode !== "hung" && mode !== "stdin-failure") {
        disarmed = true;
        process.stdout.write(JSON.stringify({ type: "ack", generation, capability }) + "\\n");
      }
    }
  });
  process.stdin.on("end", () => { note("EOF " + disarmed); if (!["hung", "missing-ack", "wrong-ack"].includes(mode)) finish(disarmed ? 0 : 1); });
  if (mode === "stdin-failure") setTimeout(() => process.stdin.destroy(), 10);
}
`);
	const oldMode = process.env.PI_TEST_GUARDIAN_MODE;
	const oldLog = process.env.PI_TEST_GUARDIAN_LOG;
	process.env.PI_TEST_GUARDIAN_MODE = "normal";
	process.env.PI_TEST_GUARDIAN_LOG = guardianLog;
	const baseDependencies: DedicatedLifecycleManagerDependencies = {
		guardianPath: guardian,
		guardianReadyTimeoutMs: 500,
		guardianAckTimeoutMs: 60,
		guardianTermGraceMs: 80,
		guardianKillGraceMs: 200,
		spawnGuardian: spawn,
		zellijBinary: () => binary,
		loadRecord: loadManagedSession,
		saveRecord: saveManagedSession,
		saveRecordIfMatches: saveManagedSessionIfMatches,
		removeRecordIfMatches: removeManagedSessionIfMatches,
		createSession: (sessionName) => createDedicatedSession(sessionName, binary),
		deleteSession: (sessionName) => deleteDedicatedSession(sessionName, binary),
	};
	const createManager = (overrides: Partial<DedicatedLifecycleManagerDependencies> = {}) =>
		createDedicatedLifecycleManager({ ...baseDependencies, ...overrides });
	const manager = createManager();
	const result = {
		directory, binary, calls, state, createMode, deleteMode, guardian, guardianLog, manager,
		owner: (id: string) => ({ ownerSessionFile: join(directory, `${id}.jsonl`), ownerSessionId: id }),
		setGuardianMode: (mode: string) => { process.env.PI_TEST_GUARDIAN_MODE = mode; },
		createManager,
		establishWith: (
			chosenManager: DedicatedLifecycleManager,
			id: string,
			callbacks: {
				unexpected?(error: Error): void;
				settle?(): Promise<void>;
				authority?(owner: { ownerSessionFile: string; ownerSessionId: string }): Promise<boolean>;
			} = {},
		) => chosenManager.establish(
			directory,
			result.owner(id),
			`controller-${id}`,
			Date.now(),
			callbacks.unexpected || (() => {}),
			callbacks.settle || (async () => {}),
			callbacks.authority || (async () => true),
		),
		establish: (id: string, callbacks = {}) => result.establishWith(manager, id, callbacks),
		retire: (lifecycle: DedicatedLifecycle, settle = async () => {}) => manager.retire(directory, lifecycle, settle),
		close: () => {
			if (oldMode === undefined) delete process.env.PI_TEST_GUARDIAN_MODE; else process.env.PI_TEST_GUARDIAN_MODE = oldMode;
			if (oldLog === undefined) delete process.env.PI_TEST_GUARDIAN_LOG; else process.env.PI_TEST_GUARDIAN_LOG = oldLog;
		},
	} satisfies Fixture;
	return result;
}

async function eventually(predicate: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) assert.fail("condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
async function pidAbsent(pid: number | undefined): Promise<boolean> {
	if (pid === undefined) return true;
	try { process.kill(pid, 0); return false; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
async function assertClean(f: Fixture, owner: ReturnType<Fixture["owner"]>, lifecycle?: DedicatedLifecycle): Promise<void> {
	assert.equal(await readFile(f.state, "utf8").catch(() => ""), "");
	assert.equal(await loadManagedSession(managedSessionPath(f.directory, owner)), undefined);
	if (lifecycle?.guardian?.pid !== undefined) await eventually(() => pidAbsent(lifecycle.guardian?.pid));
}

for (const mode of [
	"readiness-timeout",
	"missing-ready-capability",
	"wrong-ready-capability",
	"premature",
] as const) {
	test(`startup ${mode} enters cleanup and leaves no process, session, or record`, async () => {
		const f = await fixture();
		const owner = f.owner(mode);
		f.setGuardianMode(mode);
		try {
			await assert.rejects(
				f.establish(mode),
				mode === "premature" ? /prematurely/ : /did not become ready/,
			);
			await assertClean(f, owner);
		} finally { f.close(); }
	});
}

test("guardian spawn error after arming is cleaned and retryable", async () => {
	const f = await fixture();
	const owner = f.owner("spawn-error");
	const failingManager = f.createManager({
		spawnGuardian: (_executable, _args, options) => spawn(join(f.directory, "missing-executable"), [], options),
	});
	try {
		await assert.rejects(f.establishWith(failingManager, "spawn-error"));
		await assertClean(f, owner);
		const lifecycle = await f.establish("spawn-error");
		await f.retire(lifecycle);
	} finally { f.close(); }
});

for (const mode of ["fail", "absent", "presence-fail"] as const) {
	test(`create/presence ${mode} failure cleans uncertain exact presence`, async () => {
		const f = await fixture();
		const owner = f.owner(`create-${mode}`);
		await writeFile(f.createMode, mode);
		try {
			await assert.rejects(f.establish(`create-${mode}`));
			assert.match(await readFile(f.calls, "utf8"), /delete-session --force/);
			if (mode === "presence-fail") {
				assert.equal((await loadManagedSession(managedSessionPath(f.directory, owner)))?.state, "cleanup_pending");
				assert.throws(() => f.manager.assertActionsAllowed(), /cleanup is pending/);
				await writeFile(f.createMode, "ok");
				const retry = await f.establish("presence-retry");
				await f.retire(retry);
			} else await assertClean(f, owner);
		} finally { f.close(); }
	});
}

test("manager-owned provisioning blocks actions before guardian startup", async () => {
	const f = await fixture();
	let entered!: () => void;
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => { entered = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const manager = f.createManager({
		saveRecord: async (path, record) => {
			if (record.state === "arming") { entered(); await gate; }
			await saveManagedSession(path, record);
		},
	});
	const establishing = f.establishWith(manager, "provisioning-block");
	try {
		await waiting;
		assert.throws(() => manager.assertActionsAllowed(), /cleanup is pending/);
		release();
		const lifecycle = await establishing;
		await manager.retire(f.directory, lifecycle, async () => {});
	} finally { release(); await establishing.catch(() => {}); f.close(); }
});

test("active-record persistence failure uses manager cleanup", async () => {
	const f = await fixture();
	const owner = f.owner("active-save");
	let lifecycle: DedicatedLifecycle | undefined;
	const manager = f.createManager({
		saveRecordIfMatches: async (path, expected, record, requiredState) => {
			if (record.state === "active") throw new Error("injected active save failure");
			await saveManagedSessionIfMatches(path, expected, record, requiredState);
		},
	});
	try {
		await assert.rejects(f.establishWith(manager, "active-save"), /injected active save failure/);
		await assertClean(f, owner, lifecycle);
		const pid = Number((await readFile(f.guardianLog, "utf8")).match(/start (\d+)/)?.[1]);
		await eventually(() => pidAbsent(pid));
	} finally { f.close(); }
});

test("guardian exit during provisioning joins startup cleanup", async () => {
	const f = await fixture();
	const owner = f.owner("provisioning-exit");
	f.setGuardianMode("exit-during-provisioning");
	await writeFile(f.createMode, "slow");
	let unexpected = 0;
	try {
		await assert.rejects(f.establish("provisioning-exit", { unexpected: () => { unexpected++; } }), /guardian/);
		assert.equal(unexpected, 1);
		await assertClean(f, owner);
	} finally { f.close(); }
});

test("unexpected established guardian death blocks immediately, settles, and retries cleanup before provisioning", async () => {
	const f = await fixture();
	let unexpected = 0;
	let settled = 0;
	const lifecycle = await f.establish("guardian-death", {
		unexpected: () => { unexpected++; },
		settle: async () => { settled++; },
	});
	await writeFile(f.deleteMode, "fail");
	try {
		lifecycle.guardian!.kill("SIGKILL");
		await eventually(() => unexpected === 1);
		assert.throws(() => f.manager.assertActionsAllowed(), /cleanup is pending/);
		await eventually(async () => (await loadManagedSession(managedSessionPath(f.directory, lifecycle.owner)))?.state === "cleanup_pending");
		await writeFile(f.deleteMode, "ok");
		const next = await f.establish("after-guardian-death");
		assert.equal(settled, 1);
		await f.retire(next);
	} finally {
		await writeFile(f.deleteMode, "ok");
		await f.retire(lifecycle).catch(() => {});
		f.close();
	}
});

test("concurrent guardian exit and explicit retirement share one settlement", async () => {
	const f = await fixture();
	let settled = 0;
	const lifecycle = await f.establish("concurrent");
	await writeFile(f.deleteMode, "slow");
	try {
		lifecycle.guardian!.kill("SIGKILL");
		await Promise.allSettled([
			f.retire(lifecycle, async () => { settled++; }),
			f.retire(lifecycle, async () => { settled++; }),
		]);
		assert.equal(settled, 1);
		await assertClean(f, lifecycle.owner, lifecycle);
	} finally { f.close(); }
});

test("failed retirement remains blocked, then establish retries it and clears stale cleanupError", async () => {
	const f = await fixture();
	const lifecycle = await f.establish("retry-retirement");
	let settled = 0;
	await writeFile(f.deleteMode, "fail");
	try {
		await assert.rejects(f.retire(lifecycle, async () => { settled++; }), /delete session/);
		assert.equal(
			f.manager.hasPendingRetirement(lifecycle.owner, lifecycle.controllerInstanceId),
			true,
		);
		assert.throws(() => f.manager.assertActionsAllowed(), /cleanup is pending/);
		assert.ok((await loadManagedSession(managedSessionPath(f.directory, lifecycle.owner)))?.cleanupError);
		await assert.rejects(f.establish("blocked-owner"), /cleanup is pending.*retry failed/i);
		await writeFile(f.deleteMode, "ok");
		const next = await f.establish("retry-owner");
		assert.equal(
			f.manager.hasPendingRetirement(lifecycle.owner, lifecycle.controllerInstanceId),
			false,
		);
		assert.equal(settled, 1);
		assert.equal(await loadManagedSession(managedSessionPath(f.directory, lifecycle.owner)), undefined);
		await f.retire(next);
	} finally {
		await writeFile(f.deleteMode, "ok");
		await f.retire(lifecycle).catch(() => {});
		f.close();
	}
});

test("successor generation replacement before deletion blocks the wrong target", async () => {
	const f = await fixture();
	let replaceBeforeDelete = false;
	let successor: ReturnType<typeof createManagedSessionRecord> | undefined;
	const lifecycle = await f.establish("replace-before-delete", {
		authority: async (owner) => {
			if (replaceBeforeDelete) {
				successor = createManagedSessionRecord(
					owner,
					"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					createManagedSessionName(owner.ownerSessionId),
					Date.now() + 1,
					"active",
				);
				await saveManagedSession(managedSessionPath(f.directory, owner), successor);
			}
			return true;
		},
	});
	replaceBeforeDelete = true;
	try {
		await assert.rejects(f.retire(lifecycle), /record changed/);
		assert.doesNotMatch(await readFile(f.calls, "utf8"), /delete-session/);
		assert.deepEqual(await loadManagedSession(managedSessionPath(f.directory, lifecycle.owner)), successor);
	} finally {
		lifecycle.guardian?.kill("SIGKILL");
		await eventually(() => pidAbsent(lifecycle.guardian?.pid));
		f.close();
	}
});

test("successor generation replacement before removal is never unlinked", async () => {
	const f = await fixture();
	const lifecycle = await f.establish("replace-before-remove");
	let successor: ReturnType<typeof createManagedSessionRecord> | undefined;
	try {
		await assert.rejects(
			f.retire(lifecycle, async () => {
				successor = createManagedSessionRecord(
					lifecycle.owner,
					"cccccccccccccccccccccccccccccccc",
					createManagedSessionName(lifecycle.owner.ownerSessionId),
					Date.now() + 1,
					"active",
				);
				await saveManagedSession(managedSessionPath(f.directory, lifecycle.owner), successor);
			}),
			/changed before removal/,
		);
		const calls = await readFile(f.calls, "utf8");
		assert.match(calls, new RegExp(`delete-session --force ${lifecycle.record.sessionName}`));
		assert.ok(successor);
		assert.doesNotMatch(calls, new RegExp(`delete-session --force ${successor.sessionName}`));
		assert.deepEqual(await loadManagedSession(managedSessionPath(f.directory, lifecycle.owner)), successor);
	} finally { f.close(); }
});

test("current lease loss blocks deletion and a later authorized establish retries first", async () => {
	const f = await fixture();
	let authorized = true;
	let settled = 0;
	const lifecycle = await f.establish("lease-loss", {
		authority: async () => authorized,
	});
	authorized = false;
	try {
		await assert.rejects(f.retire(lifecycle, async () => { settled++; }), /lease authority/);
		assert.doesNotMatch(await readFile(f.calls, "utf8"), /delete-session/);
		assert.equal((await loadManagedSession(managedSessionPath(f.directory, lifecycle.owner)))?.state, "cleanup_pending");
		const attachCount = (await readFile(f.calls, "utf8")).match(/^attach /gm)?.length ?? 0;
		await assert.rejects(f.establish("authority-unavailable"), /cleanup is pending.*lease authority/i);
		assert.equal(
			(await readFile(f.calls, "utf8")).match(/^attach /gm)?.length ?? 0,
			attachCount,
			"a new owner was provisioned without retiring-owner authority",
		);
		authorized = true;
		const next = await f.establish("lease-retry");
		assert.equal(settled, 1);
		await f.retire(next);
	} finally {
		authorized = true;
		await f.retire(lifecycle).catch(() => {});
		f.close();
	}
});

test("authority is rechecked after settlement and guardian reap before record removal", async () => {
	const f = await fixture();
	let authorityChecks = 0;
	let retryAuthorized = false;
	let settled = 0;
	const lifecycle = await f.establish("final-authority", {
		authority: async () => retryAuthorized || ++authorityChecks === 1,
	});
	try {
		await assert.rejects(
			f.retire(lifecycle, async () => { settled++; }),
			/lost before removing the managed record/,
		);
		assert.equal(settled, 1);
		assert.ok(authorityChecks >= 2);
		assert.equal(
			(await loadManagedSession(managedSessionPath(f.directory, lifecycle.owner)))?.state,
			"cleanup_pending",
		);
		assert.equal(
			f.manager.hasPendingRetirement(lifecycle.owner, lifecycle.controllerInstanceId),
			true,
		);
		retryAuthorized = true;
		const next = await f.establish("after-final-authority");
		assert.equal(await loadManagedSession(managedSessionPath(f.directory, lifecycle.owner)), undefined);
		await f.retire(next);
	} finally {
		retryAuthorized = true;
		await f.retire(lifecycle).catch(() => {});
		f.close();
	}
});

test("cleanup_pending persistence failure prevents deletion", async () => {
	const f = await fixture();
	const manager = f.createManager({
		saveRecordIfMatches: async (path, expected, record, requiredState) => {
			if (record.state === "cleanup_pending") throw new Error("injected cleanup_pending save failure");
			await saveManagedSessionIfMatches(path, expected, record, requiredState);
		},
	});
	const lifecycle = await f.establishWith(manager, "pending-save");
	try {
		await assert.rejects(manager.retire(f.directory, lifecycle, async () => {}), /cleanup_pending save failure/);
		assert.doesNotMatch(await readFile(f.calls, "utf8"), /delete-session/);
		assert.equal((await loadManagedSession(managedSessionPath(f.directory, lifecycle.owner)))?.state, "active");
	} finally {
		lifecycle.guardian?.kill("SIGKILL");
		await eventually(() => pidAbsent(lifecycle.guardian?.pid));
		f.close();
	}
});

for (const mode of ["missing-ack", "wrong-ack", "exit-before-ack", "stdin-failure", "hung"] as const) {
	test(`guardian ${mode} falls back to close/TERM/KILL and is reaped`, async () => {
		const f = await fixture();
		f.setGuardianMode(mode);
		const lifecycle = await f.establish(`disarm-${mode}`);
		const pid = lifecycle.guardian?.pid;
		try {
			await f.retire(lifecycle);
			await eventually(() => pidAbsent(pid));
			await assertClean(f, lifecycle.owner, lifecycle);
			if (mode !== "exit-before-ack") assert.match(await readFile(f.guardianLog, "utf8"), /TERM/);
		} finally { f.close(); }
	});
}

test("record remains cleanup_pending through child settlement and guardian reap", async () => {
	const f = await fixture();
	const lifecycle = await f.establish("ordering");
	let observed = false;
	try {
		await f.retire(lifecycle, async () => {
			const record = await loadManagedSession(managedSessionPath(f.directory, lifecycle.owner));
			assert.equal(record?.state, "cleanup_pending");
			assert.equal(await readFile(f.state, "utf8").catch(() => ""), "");
			observed = true;
		});
		assert.equal(observed, true);
		await assertClean(f, lifecycle.owner, lifecycle);
	} finally { f.close(); }
});

test("fresh recovery handles guardian PID absence and deletes before new creation", async () => {
	const f = await fixture();
	const owner = f.owner("stale");
	const staleName = "piAAAAAAAAAAAAAAAAAAAAAA";
	const path = managedSessionPath(f.directory, owner);
	await writeFile(f.state, `${staleName}\n`);
	await saveManagedSession(path, createManagedSessionRecord(owner, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", staleName, 1, "cleanup_pending"));
	try {
		const lifecycle = await f.establish("stale");
		const calls = await readFile(f.calls, "utf8");
		assert.ok(calls.indexOf(`delete-session --force ${staleName}`) < calls.lastIndexOf("attach --create-background"));
		await f.retire(lifecycle);
	} finally { f.close(); }
});

test("guardian fallback kills and reaps a hung descendant cleanup client", { skip: process.platform === "win32" }, async () => {
	const f = await fixture();
	const descendantPidPath = join(f.directory, "guardian-descendant-pid");
	await writeFile(
		f.binary,
		`#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid) + "\\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`,
	);
	await chmod(f.binary, 0o755);
	const manager = f.createManager({
		guardianPath: new URL("./zellij-guardian.mjs", import.meta.url).pathname,
		guardianTermGraceMs: 80,
		guardianKillGraceMs: 500,
		createSession: async () => {},
		deleteSession: async () => {},
	});
	const lifecycle = await f.establishWith(manager, "guardian-descendant");
	let descendantPid: number | undefined;
	try {
		lifecycle.guardian?.stdin?.end();
		await eventually(async () => {
			const value = await readFile(descendantPidPath, "utf8").catch(() => "");
			descendantPid = Number(value.trim().split("\\n")[0]);
			return Number.isInteger(descendantPid) && descendantPid! > 0;
		});
		assert.equal(await pidAbsent(descendantPid), false);
		await manager.retire(f.directory, lifecycle, async () => {});
		await eventually(() => pidAbsent(descendantPid));
		await eventually(() => pidAbsent(lifecycle.guardian?.pid));
	} finally {
		if (lifecycle.guardian?.pid !== undefined) {
			try { process.kill(-lifecycle.guardian.pid, "SIGKILL"); } catch {}
		}
		if (descendantPid !== undefined && !(await pidAbsent(descendantPid))) {
			try { process.kill(descendantPid, "SIGKILL"); } catch {}
		}
		f.close();
	}
});

test("parent SIGKILL closes the control pipe, deletes the exact session, and reaps the guardian", async () => {
	const f = await fixture();
	const parentProgram = join(f.directory, "parent.mjs");
	const managerUrl = new URL("./zellij-manager.ts", import.meta.url).href;
	await writeFile(
		parentProgram,
		`const [managerUrl, agentDir, binary] = process.argv.slice(2);
process.env.PI_SUBAGENT_ZELLIJ_BIN = binary;
const { establishDedicatedLifecycle } = await import(managerUrl);
const lifecycle = await establishDedicatedLifecycle(
  agentDir,
  { ownerSessionFile: agentDir + "/parent-owner.jsonl", ownerSessionId: "sigkill-owner" },
  "sigkill-controller",
  Date.now(),
  () => {},
  async () => {},
  async () => true,
);
process.stdout.write(JSON.stringify({
  guardianPid: lifecycle.guardian.pid,
  sessionName: lifecycle.record.sessionName,
}) + "\\n");
setInterval(() => {}, 1_000);
`,
	);
	const parent = spawn(
		process.execPath,
		[
			"--experimental-transform-types",
			parentProgram,
			managerUrl,
			f.directory,
			f.binary,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let guardianPid: number | undefined;
	try {
		const ready = await new Promise<{ guardianPid: number; sessionName: string }>(
			(resolve, reject) => {
				let output = "";
				parent.stdout.setEncoding("utf8");
				parent.stdout.on("data", (chunk: string) => {
					output += chunk;
					const newline = output.indexOf("\n");
					if (newline >= 0) resolve(JSON.parse(output.slice(0, newline)));
				});
				parent.once("error", reject);
				parent.once("exit", (code) =>
					reject(new Error(`parent exited before ready (${code ?? "unknown"})`)),
				);
			},
		);
		guardianPid = ready.guardianPid;
		assert.match(ready.sessionName, /^pi[A-Za-z0-9_-]{22}$/);
		assert.equal((await readFile(f.state, "utf8")).trim(), ready.sessionName);
		parent.kill("SIGKILL");
		const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
			(resolve) => parent.once("close", (value, reason) => resolve([value, reason])),
		);
		assert.equal(code, null);
		assert.equal(signal, "SIGKILL");
		await eventually(async () => {
			const deleted = (await readFile(f.calls, "utf8")).includes(
				`delete-session --force ${ready.sessionName}`,
			);
			const absent = (await readFile(f.state, "utf8").catch(() => "")) === "";
			return deleted && absent && await pidAbsent(ready.guardianPid);
		}, 5_000);
	} finally {
		if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
		if (guardianPid !== undefined && !(await pidAbsent(guardianPid))) {
			try { process.kill(guardianPid, "SIGKILL"); } catch {}
		}
		f.close();
	}
});
