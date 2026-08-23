import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRpcChildInvocation, getPiInvocation } from "./index.ts";

test("RPC child invocation includes the session, extension, and explicit model", () => {
	const previous = process.env.PI_SUBAGENT_PI_BIN;
	process.env.PI_SUBAGENT_PI_BIN = "/test/pi";
	try {
	const invocation = buildRpcChildInvocation({
		sessionFile: "/tmp/child-session.jsonl",
		childExtensionPath: "/ext/child.ts",
		sessionDir: "/tmp/subagent",
		model: "provider/model",
		thinking: "max",
	});
	assert.deepEqual(invocation, [
		"/test/pi",
		"--offline",
		"--approve",
		"--mode",
		"rpc",
		"--session",
		"/tmp/child-session.jsonl",
		"-e",
		"/ext/child.ts",
		"--session-dir",
		"/tmp/subagent",
		"--model",
		"provider/model",
		"--thinking",
		"max",
	]);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = previous;
	}
});

test("new RPC child invocation omits a session file and preserves argument order", () => {
	const previous = process.env.PI_SUBAGENT_PI_BIN;
	process.env.PI_SUBAGENT_PI_BIN = "/test/pi";
	try {
		const invocation = buildRpcChildInvocation({
			childExtensionPath: "/ext/child.ts",
			sessionDir: "/tmp/subagent",
			model: "provider/model",
			thinking: "high",
		});
		assert.deepEqual(invocation, [
			"/test/pi",
			"--offline",
			"--approve",
			"--mode",
			"rpc",
			"-e",
			"/ext/child.ts",
			"--session-dir",
			"/tmp/subagent",
			"--model",
			"provider/model",
			"--thinking",
			"high",
		]);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = previous;
	}
});

test("child invocation prefers an explicit Pi binary, then devx, then PATH fallback", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-launch-"));
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
		assert.deepEqual(getPiInvocation(["--mode", "rpc"]), [
			devx,
			"pi",
			"--offline",
			"--approve",
			"--mode",
			"rpc",
		]);
		process.env.PI_SUBAGENT_PI_BIN = "/test/pi";
		assert.deepEqual(getPiInvocation(["--mode", "rpc"]), [
			"/test/pi",
			"--offline",
			"--approve",
			"--mode",
			"rpc",
		]);
		delete process.env.PI_SUBAGENT_PI_BIN;
		process.env.PATH = "";
		const fallback = getPiInvocation(["--mode", "rpc"]);
		assert.ok(fallback.includes("--offline"));
		assert.ok(fallback.includes("--approve"));
	} finally {
		if (previous.path === undefined) delete process.env.PATH;
		else process.env.PATH = previous.path;
		if (previous.pi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = previous.pi;
		if (previous.devx === undefined) delete process.env.PI_SUBAGENT_DEVX_BIN;
		else process.env.PI_SUBAGENT_DEVX_BIN = previous.devx;
	}
});
