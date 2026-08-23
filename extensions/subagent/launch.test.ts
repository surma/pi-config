import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPiInvocation } from "./index.ts";

// All Zellij-specific tests were removed as part of the Zellij-to-RPC
// migration. The helpers below (name, executable, withZellijBinary) and
// the removed test cases relied on ./zellij.ts which no longer exists.

test("child invocation prefers devx and always approves offline projects", async () => {
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
			"--approve",
			"--model",
			"p/m",
		]);
		process.env.PI_SUBAGENT_PI_BIN = "/test/pi";
		assert.deepEqual(getPiInvocation(["--model", "p/m"]), [
			"/test/pi",
			"--offline",
			"--approve",
			"--model",
			"p/m",
		]);
		delete process.env.PI_SUBAGENT_PI_BIN;
		process.env.PATH = "";
		const fallback = getPiInvocation(["--model", "p/m"]);
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
