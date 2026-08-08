import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPiInvocation } from "./index.ts";
import {
	actionInSession,
	buildNewTabArgs,
	closePaneInSession,
	createDedicatedSession,
	deleteDedicatedSession,
	discoverPaneIdInSession,
	listSessionNames,
	newTabInSession,
	sessionExists,
} from "./zellij.ts";

const name = "pi0123456789abcdefABCDEF";

async function executable(directory: string, source: string): Promise<string> {
	const binary = join(directory, "zellij");
	await writeFile(binary, source);
	await chmod(binary, 0o755);
	return binary;
}

async function withZellijBinary<T>(
	binary: string,
	action: () => Promise<T>,
): Promise<T> {
	const previous = process.env.PI_SUBAGENT_ZELLIJ_BIN;
	process.env.PI_SUBAGENT_ZELLIJ_BIN = binary;
	try {
		return await action();
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous;
	}
}

test("new-tab launch is interactive, additive, marked, and has no task argument", () => {
	const args = buildNewTabArgs(
		"child",
		"/work",
		[
			"devx",
			"pi",
			"--offline",
			"-e",
			"/ext/child.ts",
			"--session-dir",
			"/session",
			"--model",
			"p/m",
			"--thinking",
			"max",
		],
		{
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_CHILD_ID: "id",
			PI_SUBAGENT_OWNER_SESSION_FILE: "/tmp/owner.jsonl",
			PI_SUBAGENT_OWNER_SESSION_ID: "owner-session",
			PI_SUBAGENT_CONTROLLER_INSTANCE_ID: "controller-a",
			PI_SUBAGENT_INCARNATION: "inc-a",
			BRIDGE_SOCKET_PATH: "/session/bridge.sock",
		},
	);
	assert.deepEqual(args.slice(0, 7), [
		"new-tab",
		"-n",
		"child",
		"-c",
		"/work",
		"--",
		"env",
	]);
	const joined = args.join(" ");
	assert.match(joined, /PI_SUBAGENT_CHILD=1/);
	assert.match(joined, /PI_SUBAGENT_CHILD_ID=id/);
	assert.match(joined, /PI_SUBAGENT_OWNER_SESSION_FILE=\/tmp\/owner\.jsonl/);
	assert.match(joined, /PI_SUBAGENT_OWNER_SESSION_ID=owner-session/);
	assert.match(joined, /PI_SUBAGENT_CONTROLLER_INSTANCE_ID=controller-a/);
	assert.match(joined, /PI_SUBAGENT_INCARNATION=inc-a/);
	assert.match(joined, /devx pi --offline -e \/ext\/child\.ts/);
	assert.match(joined, /--thinking max/);
	assert.doesNotMatch(
		joined,
		/--mode rpc|--no-extensions|--close-on-exit|the task text/,
	);
});

test("child invocation prefers devx and is always offline", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fake-devx-"));
	const devx = join(directory, "devx");
	await writeFile(devx, "#!/bin/sh\nexit 0\n");
	await chmod(devx, 0o755);
	const previous = {
		path: process.env.PATH,
		pi: process.env.PI_SUBAGENT_PI_BIN,
		devx: process.env.PI_SUBAGENT_DEVX_BIN,
	};
	delete process.env.PI_SUBAGENT_PI_BIN;
	delete process.env.PI_SUBAGENT_DEVX_BIN;
	process.env.PATH = directory;
	try {
		assert.deepEqual(getPiInvocation(["--model", "p/m"]), [
			devx,
			"pi",
			"--offline",
			"--model",
			"p/m",
		]);
		process.env.PI_SUBAGENT_PI_BIN = "/test/pi";
		assert.deepEqual(getPiInvocation(["--model", "p/m"]), [
			"/test/pi",
			"--offline",
			"--model",
			"p/m",
		]);
		delete process.env.PI_SUBAGENT_PI_BIN;
		process.env.PATH = "";
		assert.ok(getPiInvocation(["--model", "p/m"]).includes("--offline"));
	} finally {
		if (previous.path === undefined) delete process.env.PATH;
		else process.env.PATH = previous.path;
		if (previous.pi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = previous.pi;
		if (previous.devx === undefined) delete process.env.PI_SUBAGENT_DEVX_BIN;
		else process.env.PI_SUBAGENT_DEVX_BIN = previous.devx;
	}
});

test("dedicated creation uses attach create-background and checks its exact name", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-create-"));
	const calls = join(directory, "calls");
	const binary = await executable(
		directory,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nif [ "$1" = list-sessions ]; then printf '${name}\\n'; fi\n`,
	);
	await createDedicatedSession(name, binary);
	const value = await readFile(calls, "utf8");
	assert.match(value, new RegExp(`attach --create-background ${name}`));
	assert.match(value, /list-sessions --short --no-formatting/);
});

test("dedicated creation fails unless the exact generated name appears", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-create-missing-"));
	const binary = await executable(
		directory,
		"#!/bin/sh\nif [ \"$1\" = list-sessions ]; then printf 'another-session\\n'; fi\nexit 0\n",
	);
	await assert.rejects(
		createDedicatedSession(name, binary),
		/did not create the exact dedicated session/,
	);
});

test("whole-session deletion proves exact absence after delete", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-delete-"));
	const calls = join(directory, "calls");
	const binary = await executable(
		directory,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit 0\n`,
	);
	await deleteDedicatedSession(name, binary);
	const value = await readFile(calls, "utf8");
	assert.match(value, new RegExp(`delete-session --force ${name}`));
	assert.match(value, /list-sessions --short --no-formatting/);
});

test("Zellij 0.44.3 empty-list exit means exact session absence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-empty-list-"));
	const binary = await executable(
		directory,
		`#!/bin/sh
if [ "$1" = list-sessions ]; then
  printf 'No active zellij sessions found.\\n' >&2
  exit 1
fi
if [ "$1" = delete-session ]; then exit 1; fi
exit 2
`,
	);
	assert.deepEqual(await listSessionNames(binary), []);
	assert.equal(await sessionExists(name, binary), false);
	await deleteDedicatedSession(name, binary);
});

test("session listing rejects other nonzero empty results", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-list-error-"));
	const binary = await executable(
		directory,
		"#!/bin/sh\nprintf 'permission denied\\n' >&2\nexit 1\n",
	);
	await assert.rejects(listSessionNames(binary), /permission denied/);
});

test("whole-session deletion fails while the exact name remains", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-delete-present-"));
	const binary = await executable(
		directory,
		`#!/bin/sh\nif [ "$1" = list-sessions ]; then printf '${name}\\n'; fi\nexit 0\n`,
	);
	await assert.rejects(
		deleteDedicatedSession(name, binary),
		/remains after deletion/,
	);
});

test("named launch parses its tab id and never inspects a parent session", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-named-"));
	const calls = join(directory, "calls");
	const binary = await executable(
		directory,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nif [ "$4" = new-tab ]; then printf '7\\n'; exit 0; fi\nexit 2\n`,
	);
	await withZellijBinary(binary, async () => {
		assert.deepEqual(
			await newTabInSession(name, "child", "/tmp", ["pi"], {
				PI_SUBAGENT_CHILD: "1",
			}),
			{ tabId: 7, sessionName: name },
		);
	});
	const value = await readFile(calls, "utf8");
	assert.match(value, new RegExp(`--session ${name} action new-tab`));
	assert.doesNotMatch(value, /list-sessions|list-panes/);
});

test("named pane discovery rejects unrelated panes and requires every identity marker", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-discovery-"));
	const matchingPane = {
		id: 42,
		tab_id: 7,
		is_plugin: false,
		exited: false,
		pane_command: "pi",
		terminal_command:
			"env PI_SUBAGENT_CHILD_ID=child BRIDGE_SOCKET_PATH=/tmp/bridge.sock " +
			"PI_SUBAGENT_OWNER_SESSION_FILE=/tmp/owner.jsonl PI_SUBAGENT_OWNER_SESSION_ID=owner " +
			"PI_SUBAGENT_CONTROLLER_INSTANCE_ID=controller PI_SUBAGENT_INCARNATION=incarnation pi",
	};
	const unrelatedPane = {
		...matchingPane,
		id: 41,
		terminal_command: "env PI_SUBAGENT_CHILD_ID=unrelated pi",
	};
	const binary = await executable(
		directory,
		`#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(JSON.stringify([unrelatedPane, matchingPane]))}\n`,
	);
	const identity = {
		childId: "child",
		socketPath: "/tmp/bridge.sock",
		ownerSessionFile: "/tmp/owner.jsonl",
		ownerSessionId: "owner",
		controllerInstanceId: "controller",
		incarnation: "incarnation",
	};
	await withZellijBinary(binary, async () => {
		assert.equal(await discoverPaneIdInSession(name, 7, identity, 0), 42);
		await writeFile(
			binary,
			`#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(JSON.stringify([unrelatedPane]))}\n`,
		);
		await assert.rejects(
			discoverPaneIdInSession(name, 7, identity, 0),
			/Could not discover a live Pi pane with the expected identity/,
		);
	});
});

test("direct pane cleanup uses only the captured session and stable terminal pane", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-close-"));
	const record = join(directory, "closed");
	const binary = await executable(
		directory,
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nif [ "$4" = close-pane ]; then exit 0; fi\nexit 2\n`,
	);
	await withZellijBinary(binary, () => closePaneInSession(name, 42));
	assert.deepEqual((await readFile(record, "utf8")).trim().split("\n"), [
		"--session",
		name,
		"action",
		"close-pane",
		"--pane-id",
		"terminal_42",
	]);
});

test("Zellij 0.44.3 already-absent panes are cleanup success", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-absent-"));
	const binary = await executable(directory, "#!/bin/sh\nexit 0\n");
	await withZellijBinary(binary, () => closePaneInSession(name, 999_999));
});

test("bounded Zellij actions wait for close after TERM", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-timeout-"));
	const closed = join(directory, "closed");
	const binary = await executable(
		directory,
		`#!${process.execPath}\nconst fs = require("node:fs");\nprocess.on("SIGTERM", () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(closed)}, "closed"); process.exit(0); }, 30));\nsetInterval(() => {}, 1000);\n`,
	);
	await assert.rejects(
		actionInSession(binary, name, ["close-pane"]),
		/completion is uncertain/,
	);
	assert.equal(await readFile(closed, "utf8"), "closed");
});

test("session listing is bounded and terminates its hung client", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-list-timeout-"));
	const terminated = join(directory, "terminated");
	const binary = await executable(
		directory,
		`#!${process.execPath}\nconst fs = require("node:fs");\nif (process.argv[2] !== "list-sessions") process.exit(2);\nprocess.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(terminated)}, "SIGTERM"); process.exit(0); });\nsetInterval(() => {}, 1000);\n`,
	);
	await assert.rejects(listSessionNames(binary), /completion is uncertain/);
	assert.equal(await readFile(terminated, "utf8"), "SIGTERM");
});

test("dedicated startup is bounded and terminates its hung client", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-create-timeout-"));
	const terminated = join(directory, "terminated");
	const binary = await executable(
		directory,
		`#!${process.execPath}\nconst fs = require("node:fs");\nif (process.argv[2] !== "attach") process.exit(2);\nprocess.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(terminated)}, "SIGTERM"); process.exit(0); });\nsetInterval(() => {}, 1000);\n`,
	);
	await assert.rejects(createDedicatedSession(name, binary), /completion is uncertain/);
	assert.equal(await readFile(terminated, "utf8"), "SIGTERM");
});

test("dedicated deletion is bounded and terminates its hung client", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-delete-timeout-"));
	const terminated = join(directory, "terminated");
	const binary = await executable(
		directory,
		`#!${process.execPath}\nconst fs = require("node:fs");\nif (process.argv[2] !== "delete-session") process.exit(2);\nprocess.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(terminated)}, "SIGTERM"); process.exit(0); });\nsetInterval(() => {}, 1000);\n`,
	);
	await assert.rejects(deleteDedicatedSession(name, binary), /completion is uncertain/);
	assert.equal(await readFile(terminated, "utf8"), "SIGTERM");
});

test("a timed-out non-idempotent named new-tab runs exactly once", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-new-tab-timeout-"));
	const actions = join(directory, "actions");
	const binary = await executable(
		directory,
		`#!${process.execPath}\nconst fs = require("node:fs");\nif (process.argv[5] !== "new-tab") process.exit(2);\nfs.appendFileSync(${JSON.stringify(actions)}, "new-tab\\n");\nprocess.on("SIGTERM", () => process.exit(0));\nsetInterval(() => {}, 1000);\n`,
	);
	await withZellijBinary(binary, async () => {
		await assert.rejects(
			newTabInSession(name, "child", "/tmp", ["pi"], {}),
			/completion is uncertain/,
		);
	});
	assert.deepEqual((await readFile(actions, "utf8")).trim().split("\n"), [
		"new-tab",
	]);
});

test("a SIGTERM-resistant Zellij action receives SIGKILL and closes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-sigkill-"));
	const pidPath = join(directory, "pid");
	const termPath = join(directory, "term");
	const binary = await executable(
		directory,
		`#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termPath)}, "ignored"));\nsetInterval(() => {}, 1000);\n`,
	);
	await assert.rejects(
		actionInSession(binary, name, ["close-pane"]),
		/completion is uncertain/,
	);
	assert.equal(await readFile(termPath, "utf8"), "ignored");
	const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("failed named actions preserve stdout and stderr as separate fields", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-streams-"));
	const binary = await executable(
		directory,
		"#!/bin/sh\nprintf 'stdout-only-detail\\n'\nprintf 'stderr-only-detail\\n' >&2\nexit 7\n",
	);
	await assert.rejects(
		actionInSession(binary, name, ["close-pane"]),
		(error: Error) => {
			assert.match(error.message, /stdout: "stdout-only-detail"/);
			assert.match(error.message, /stderr: "stderr-only-detail"/);
			assert.doesNotMatch(
				error.message,
				/stdout-only-detail\\nstderr-only-detail/,
			);
			return true;
		},
	);
});
