import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPiInvocation } from "./index.ts";
import {
	buildNewTabArgs,
	closeValidatedSubagentTab,
	newTab,
	requireZellij,
} from "./zellij.ts";

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
			"high",
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
	assert.doesNotMatch(
		joined,
		/--mode rpc|--no-extensions|--close-on-exit|the task text/,
	);
});

test("child invocation prefers devx and is always offline", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-devx-"));
	const devx = join(dir, "devx");
	await writeFile(devx, "#!/bin/sh\nexit 0\n");
	await chmod(devx, 0o755);
	const previous = {
		path: process.env.PATH,
		pi: process.env.PI_SUBAGENT_PI_BIN,
		devx: process.env.PI_SUBAGENT_DEVX_BIN,
	};
	delete process.env.PI_SUBAGENT_PI_BIN;
	delete process.env.PI_SUBAGENT_DEVX_BIN;
	process.env.PATH = dir;
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

test("Zellij requirement has the exact actionable error", () => {
	const previous = process.env.ZELLIJ_SESSION_NAME;
	delete process.env.ZELLIJ_SESSION_NAME;
	try {
		assert.throws(requireZellij, /requires running inside a Zellij session/);
	} finally {
		if (previous === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previous;
	}
});

test("kill and parent quit close live or exited validated tabs without IPC", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-close-"));
	const script = join(dir, "zellij");
	const record = join(dir, "closed");
	const socketPath = "/tmp/private/bridge.sock";
	const ownerSessionFile = "/tmp/owner.jsonl";
	const ownerSessionId = "owner-session";
	const controllerInstanceId = "controller-a";
	const incarnation = "inc-a";
	const panes = JSON.stringify([
		{
			id: 9,
			tab_id: 7,
			is_plugin: false,
			exited: true,
			pane_command: "pi",
			terminal_command: `env PI_SUBAGENT_CHILD_ID=child PI_SUBAGENT_OWNER_SESSION_FILE=${ownerSessionFile} PI_SUBAGENT_OWNER_SESSION_ID=${ownerSessionId} PI_SUBAGENT_CONTROLLER_INSTANCE_ID=${controllerInstanceId} PI_SUBAGENT_INCARNATION=${incarnation} BRIDGE_SOCKET_PATH=${socketPath} pi`,
		},
	]);
	await writeFile(
		script,
		`#!/bin/sh\nif [ "$2" = list-panes ]; then printf '%s\\n' ${JSON.stringify(panes)}; exit 0; fi\nif [ "$2" = close-tab-by-id ]; then printf closed > ${JSON.stringify(record)}; exit 0; fi\nexit 2\n`,
	);
	await chmod(script, 0o755);
	const previous = {
		bin: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_SUBAGENT_ZELLIJ_BIN = script;
	process.env.ZELLIJ_SESSION_NAME = "test";
	try {
		assert.equal(
			await closeValidatedSubagentTab(7, 9, {
				childId: "child",
				socketPath,
				ownerSessionFile,
				ownerSessionId,
				controllerInstanceId,
				incarnation,
			}),
			true,
		);
		assert.equal(await readFile(record, "utf8"), "closed");
	} finally {
		if (previous.bin === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous.bin;
		if (previous.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previous.session;
	}
});

test("newTab parses the explicit id from zellij stdout", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-"));
	const script = join(dir, "zellij");
	const record = join(dir, "args");
	await writeFile(
		script,
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nprintf '7\\n'\n`,
	);
	await chmod(script, 0o755);
	const previous = {
		bin: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_SUBAGENT_ZELLIJ_BIN = script;
	process.env.ZELLIJ_SESSION_NAME = "test";
	try {
		assert.equal(
			await newTab("name", "/tmp", ["pi"], { PI_SUBAGENT_CHILD: "1" }),
			7,
		);
		assert.match(await readFile(record, "utf8"), /new-tab/);
	} finally {
		if (previous.bin === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous.bin;
		if (previous.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previous.session;
	}
});
