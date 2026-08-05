import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPiInvocation } from "./index.ts";
import {
	actionInSession,
	buildNewTabArgs,
	cleanupManagedSession,
	closePaneInSession,
	discoverPaneId,
	ensureZellij,
	invalidateSessionCache,
	newTab,
	requireZellij,
	selectZellijSessionForPane,
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

test("session selection survives a rename followed by old-name reuse", () => {
	assert.equal(
		selectZellijSessionForPane(
			[
				{
					name: "tartarus",
					panes: [
						{
							id: 0,
							tab_id: 0,
							is_plugin: false,
							exited: false,
							pane_command: "pi",
							pane_cwd: "/work/tartarus",
						},
					],
				},
				{
					name: "world-home",
					panes: [
						{
							id: 0,
							tab_id: 0,
							is_plugin: false,
							exited: false,
							pane_command: "pi",
							pane_cwd: "/work/root",
						},
					],
				},
			],
			0,
			"/work/tartarus",
		),
		"tartarus",
	);
});

test("session selection fails closed for an ambiguous parent pane", () => {
	const pane = {
		id: 0,
		tab_id: 0,
		is_plugin: false,
		exited: false,
		pane_command: "pi",
		pane_cwd: "/work/shared",
	};
	assert.throws(
		() =>
			selectZellijSessionForPane(
				[
					{ name: "one", panes: [pane] },
					{ name: "two", panes: [pane] },
				],
				0,
				"/work/shared",
			),
		/Could not uniquely identify the current Zellij session/,
	);
});

test("launch discovery rejects unrelated panes and requires full identity markers", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-discovery-"));
	const script = join(dir, "zellij");
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
	await writeFile(
		script,
		`#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(JSON.stringify([unrelatedPane, matchingPane]))}\n`,
	);
	await chmod(script, 0o755);
	const previous = {
		bin: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		zellij: process.env.ZELLIJ,
		pane: process.env.ZELLIJ_PANE_ID,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_SUBAGENT_ZELLIJ_BIN = script;
	delete process.env.ZELLIJ;
	delete process.env.ZELLIJ_PANE_ID;
	process.env.ZELLIJ_SESSION_NAME = "test";
	invalidateSessionCache();
	const identity = {
		childId: "child",
		socketPath: "/tmp/bridge.sock",
		ownerSessionFile: "/tmp/owner.jsonl",
		ownerSessionId: "owner",
		controllerInstanceId: "controller",
		incarnation: "incarnation",
	};
	try {
		assert.equal(await discoverPaneId(7, identity, 0), 42);
		await writeFile(
			script,
			`#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(JSON.stringify([unrelatedPane]))}\n`,
		);
		await assert.rejects(
			discoverPaneId(7, identity, 0),
			/Could not discover a live Pi pane with the expected identity/,
		);
	} finally {
		if (previous.bin === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous.bin;
		if (previous.zellij === undefined) delete process.env.ZELLIJ;
		else process.env.ZELLIJ = previous.zellij;
		if (previous.pane === undefined) delete process.env.ZELLIJ_PANE_ID;
		else process.env.ZELLIJ_PANE_ID = previous.pane;
		if (previous.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previous.session;
		invalidateSessionCache();
	}
});

test("direct cleanup closes only the captured stable terminal pane", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-close-"));
	const script = join(dir, "zellij");
	const record = join(dir, "closed");
	await writeFile(
		script,
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nif [ "$4" = close-pane ]; then exit 0; fi\nexit 2\n`,
	);
	await chmod(script, 0o755);
	const previous = process.env.PI_SUBAGENT_ZELLIJ_BIN;
	process.env.PI_SUBAGENT_ZELLIJ_BIN = script;
	try {
		await closePaneInSession("world-home", 42);
		assert.deepEqual((await readFile(record, "utf8")).trim().split("\n"), [
			"--session",
			"world-home",
			"action",
			"close-pane",
			"--pane-id",
			"terminal_42",
		]);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous;
	}
});

test("Zellij 0.44.3 already-absent panes are cleanup success", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-absent-"));
	const script = join(dir, "zellij");
	await writeFile(
		script,
		"#!/bin/sh\n# Zellij 0.44.3 exits zero with empty stdout and stderr for an absent pane.\nexit 0\n",
	);
	await chmod(script, 0o755);
	const previous = process.env.PI_SUBAGENT_ZELLIJ_BIN;
	process.env.PI_SUBAGENT_ZELLIJ_BIN = script;
	try {
		await closePaneInSession("disposable", 999_999);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous;
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
	invalidateSessionCache();
	try {
		assert.deepEqual(
			await newTab("name", "/tmp", ["pi"], { PI_SUBAGENT_CHILD: "1" }),
			{ tabId: 7, sessionName: "test" },
		);
		const args = (await readFile(record, "utf8")).trim().split("\n");
		assert.deepEqual(args.slice(0, 4), [
			"--session",
			"test",
			"action",
			"new-tab",
		]);
	} finally {
		if (previous.bin === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous.bin;
		if (previous.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previous.session;
	}
});

test("bounded Zellij actions terminate a hung client", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-hung-"));
	const script = join(dir, "zellij");
	const record = join(dir, "terminated");
	await writeFile(
		script,
		`#!${process.execPath}\nconst fs = require("node:fs");\nprocess.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(record)}, "SIGTERM"); process.exit(0); });\nsetInterval(() => {}, 1_000);\n`,
	);
	await chmod(script, 0o755);
	await assert.rejects(
		actionInSession(script, "world-home", ["close-pane", "--pane-id", "terminal_42"]),
		/timed out after 2500ms/,
	);
	for (let attempt = 0; attempt < 20; attempt++) {
		if (await readFile(record, "utf8").catch(() => "") === "SIGTERM") return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(await readFile(record, "utf8"), "SIGTERM");
});

test("session discovery bounds and terminates a hung Zellij client", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-list-sessions-hung-"));
	const script = join(dir, "zellij");
	const pidPath = join(dir, "pid");
	const termPath = join(dir, "term");
	await writeFile(
		script,
		`#!${process.execPath}\nconst fs = require("node:fs");\nif (process.argv[2] !== "list-sessions") process.exit(2);\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termPath)}, "SIGTERM"));\nsetInterval(() => {}, 1_000);\n`,
	);
	await chmod(script, 0o755);
	const previous = {
		bin: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		zellij: process.env.ZELLIJ,
		pane: process.env.ZELLIJ_PANE_ID,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_SUBAGENT_ZELLIJ_BIN = script;
	process.env.ZELLIJ = "0";
	process.env.ZELLIJ_PANE_ID = "0";
	delete process.env.ZELLIJ_SESSION_NAME;
	invalidateSessionCache();
	let outcome = "pending";
	let operation: Promise<void> | undefined;
	try {
		operation = ensureZellij().then(
			() => {
				outcome = "resolved";
			},
			() => {
				outcome = "rejected";
			},
		);
		const settled = await Promise.race([
			operation.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_250)),
		]);
		const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
		if (!settled) process.kill(pid, "SIGKILL");
		await operation;
		let exited = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				exited = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(settled, true, "Hung list-sessions client exceeded its bound.");
		assert.equal(outcome, "rejected");
		assert.equal(await readFile(termPath, "utf8"), "SIGTERM");
		assert.equal(exited, true, `Hung list-sessions process ${pid} remained alive.`);
	} finally {
		await operation?.catch(() => {});
		if (previous.bin === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous.bin;
		if (previous.zellij === undefined) delete process.env.ZELLIJ;
		else process.env.ZELLIJ = previous.zellij;
		if (previous.pane === undefined) delete process.env.ZELLIJ_PANE_ID;
		else process.env.ZELLIJ_PANE_ID = previous.pane;
		if (previous.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previous.session;
		invalidateSessionCache();
	}
});

test("managed-session startup bounds and terminates a hung Zellij client", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-start-session-hung-"));
	const script = join(dir, "zellij");
	const pidPath = join(dir, "pid");
	const termPath = join(dir, "term");
	const sessionName = `pi-subagent-${process.pid}`;
	await writeFile(
		script,
		`#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nif (args[0] === "-s") { fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termPath)}, "SIGTERM")); setInterval(() => {}, 1_000); }\nelse if (args[0] === "list-sessions") { process.stdout.write(${JSON.stringify(`${sessionName}\n`)}); process.exit(0); }\nelse process.exit(2);\n`,
	);
	await chmod(script, 0o755);
	const previous = {
		bin: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		zellij: process.env.ZELLIJ,
		pane: process.env.ZELLIJ_PANE_ID,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_SUBAGENT_ZELLIJ_BIN = script;
	delete process.env.ZELLIJ;
	delete process.env.ZELLIJ_PANE_ID;
	delete process.env.ZELLIJ_SESSION_NAME;
	invalidateSessionCache();
	try {
		assert.equal(await ensureZellij(), sessionName);
		const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
		let exited = false;
		for (let attempt = 0; attempt < 200; attempt++) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				exited = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		if (!exited) process.kill(pid, "SIGKILL");
		assert.equal(await readFile(termPath, "utf8"), "SIGTERM");
		assert.equal(exited, true, `Hung managed-session startup process ${pid} remained alive.`);
	} finally {
		await cleanupManagedSession();
		if (previous.bin === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous.bin;
		if (previous.zellij === undefined) delete process.env.ZELLIJ;
		else process.env.ZELLIJ = previous.zellij;
		if (previous.pane === undefined) delete process.env.ZELLIJ_PANE_ID;
		else process.env.ZELLIJ_PANE_ID = previous.pane;
		if (previous.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previous.session;
		invalidateSessionCache();
	}
});

test("managed-session cleanup bounds and terminates a hung Zellij client", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-kill-session-hung-"));
	const script = join(dir, "zellij");
	const pidPath = join(dir, "pid");
	const termPath = join(dir, "term");
	const sessionName = `pi-subagent-${process.pid}`;
	await writeFile(
		script,
		`#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nif (args[0] === "-s") process.exit(0);\nif (args[0] === "list-sessions") { process.stdout.write(${JSON.stringify(`${sessionName}\n`)}); process.exit(0); }\nif (args[0] !== "kill-session") process.exit(2);\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termPath)}, "SIGTERM"));\nsetInterval(() => {}, 1_000);\n`,
	);
	await chmod(script, 0o755);
	const previous = {
		bin: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		zellij: process.env.ZELLIJ,
		pane: process.env.ZELLIJ_PANE_ID,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_SUBAGENT_ZELLIJ_BIN = script;
	delete process.env.ZELLIJ;
	delete process.env.ZELLIJ_PANE_ID;
	delete process.env.ZELLIJ_SESSION_NAME;
	invalidateSessionCache();
	let operation: Promise<void> | undefined;
	try {
		assert.equal(await ensureZellij(), sessionName);
		operation = cleanupManagedSession();
		const settled = await Promise.race([
			operation.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_250)),
		]);
		const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
		if (!settled) process.kill(pid, "SIGKILL");
		await operation;
		let exited = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				exited = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(settled, true, "Hung kill-session client exceeded its bound.");
		assert.equal(await readFile(termPath, "utf8"), "SIGTERM");
		assert.equal(exited, true, `Hung kill-session process ${pid} remained alive.`);
	} finally {
		await operation?.catch(() => {});
		if (previous.bin === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous.bin;
		if (previous.zellij === undefined) delete process.env.ZELLIJ;
		else process.env.ZELLIJ = previous.zellij;
		if (previous.pane === undefined) delete process.env.ZELLIJ_PANE_ID;
		else process.env.ZELLIJ_PANE_ID = previous.pane;
		if (previous.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previous.session;
		invalidateSessionCache();
	}
});

test("a timed-out non-idempotent new-tab action runs exactly once", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-new-tab-timeout-"));
	const script = join(dir, "zellij");
	const record = join(dir, "actions");
	const pidPath = join(dir, "pid");
	await writeFile(
		script,
		`#!${process.execPath}\nconst fs = require("node:fs");\nif (process.argv[5] !== "new-tab") process.exit(2);\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nfs.appendFileSync(${JSON.stringify(record)}, "new-tab\\n");\nprocess.on("SIGTERM", () => process.exit(0));\nsetInterval(() => {}, 1_000);\n`,
	);
	await chmod(script, 0o755);
	const previous = {
		bin: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_SUBAGENT_ZELLIJ_BIN = script;
	process.env.ZELLIJ_SESSION_NAME = "test";
	invalidateSessionCache();
	try {
		await assert.rejects(
			newTab("name", "/tmp", ["pi"], {}),
			/zellij action new-tab timed out after 2500ms/,
		);
		assert.deepEqual((await readFile(record, "utf8")).trim().split("\n"), [
			"new-tab",
		]);
		const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
		let exited = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				exited = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(exited, true, `Timed-out new-tab process ${pid} remained alive.`);
	} finally {
		if (previous.bin === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous.bin;
		if (previous.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previous.session;
		invalidateSessionCache();
	}
});

test("a SIGTERM-resistant Zellij action receives SIGKILL and exits", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-sigkill-"));
	const script = join(dir, "zellij");
	const pidPath = join(dir, "pid");
	const termPath = join(dir, "term");
	await writeFile(
		script,
		`#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termPath)}, "ignored"));\nsetInterval(() => {}, 1_000);\n`,
	);
	await chmod(script, 0o755);
	await assert.rejects(
		actionInSession(script, "disposable", ["close-pane", "--pane-id", "terminal_42"]),
		/timed out after 2500ms/,
	);
	const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
	for (let attempt = 0; attempt < 100; attempt++) {
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		if (!alive) {
			assert.equal(await readFile(termPath, "utf8"), "ignored");
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`SIGTERM-resistant action process ${pid} remained alive.`);
});

test("failed Zellij actions preserve stdout and stderr as separate fields", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-streams-"));
	const script = join(dir, "zellij");
	await writeFile(
		script,
		"#!/bin/sh\nprintf 'stdout-only-detail\\n'\nprintf 'stderr-only-detail\\n' >&2\nexit 7\n",
	);
	await chmod(script, 0o755);
	await assert.rejects(
		actionInSession(script, "disposable", ["close-pane"]),
		(error: Error) => {
			assert.match(error.message, /stdout: "stdout-only-detail"/);
			assert.match(error.message, /stderr: "stderr-only-detail"/);
			assert.doesNotMatch(error.message, /stdout-only-detail\\nstderr-only-detail/);
			return true;
		},
	);
});

test("session cache is reused and invalidates once after a missing-session error", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-cache-"));
	const script = join(dir, "zellij");
	const state = join(dir, "state.json");
	const actions = join(dir, "actions");
	const parentPane = JSON.stringify([
		{
			id: 0,
			tab_id: 0,
			is_plugin: false,
			exited: false,
			pane_command: "pi",
			pane_cwd: process.cwd(),
		},
	]);
	const unrelatedPane = JSON.stringify([
		{
			id: 0,
			tab_id: 0,
			is_plugin: false,
			exited: false,
			pane_command: "pi",
			pane_cwd: "/other",
		},
	]);
	await writeFile(
		script,
		`#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nlet state = { resolutions: 0, tabs: 0 };\ntry { state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8")); } catch {}\nconst save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));\nif (args[0] === "list-sessions") { state.resolutions++; save(); process.stdout.write(state.resolutions === 1 ? "old\\n" : "old\\nnew\\n"); process.exit(0); }\nconst session = args[1];\nconst action = args[3];\nif (action === "list-panes") { const parent = state.resolutions === 1 ? session === "old" : session === "new"; process.stdout.write(parent ? ${JSON.stringify(parentPane)} : ${JSON.stringify(unrelatedPane)}); process.exit(0); }\nif (action === "new-tab") { state.tabs++; save(); fs.appendFileSync(${JSON.stringify(actions)}, session + "\\n"); if (state.tabs === 3) { process.stderr.write("Session old not found\\n"); process.exit(2); } process.stdout.write(String(6 + state.tabs) + "\\n"); process.exit(0); }\nprocess.exit(2);\n`,
	);
	await chmod(script, 0o755);
	const previous = {
		bin: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		zellij: process.env.ZELLIJ,
		pane: process.env.ZELLIJ_PANE_ID,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_SUBAGENT_ZELLIJ_BIN = script;
	process.env.ZELLIJ = "0";
	process.env.ZELLIJ_PANE_ID = "0";
	process.env.ZELLIJ_SESSION_NAME = "old";
	invalidateSessionCache();
	try {
		assert.equal((await newTab("one", process.cwd(), ["pi"], {})).sessionName, "old");
		assert.equal((await newTab("two", process.cwd(), ["pi"], {})).sessionName, "old");
		await assert.rejects(newTab("three", process.cwd(), ["pi"], {}), /Session old not found/);
		assert.equal((await newTab("four", process.cwd(), ["pi"], {})).sessionName, "new");
		assert.deepEqual(JSON.parse(await readFile(state, "utf8")), {
			resolutions: 2,
			tabs: 4,
		});
		assert.deepEqual((await readFile(actions, "utf8")).trim().split("\n"), [
			"old",
			"old",
			"old",
			"new",
		]);
	} finally {
		if (previous.bin === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous.bin;
		if (previous.zellij === undefined) delete process.env.ZELLIJ;
		else process.env.ZELLIJ = previous.zellij;
		if (previous.pane === undefined) delete process.env.ZELLIJ_PANE_ID;
		else process.env.ZELLIJ_PANE_ID = previous.pane;
		if (previous.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previous.session;
		invalidateSessionCache();
	}
});

test("newTab ignores a stale session name after a session rename", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fake-zellij-rename-"));
	const script = join(dir, "zellij");
	const record = join(dir, "target");
	const currentCwd = process.cwd();
	const tartarusPanes = JSON.stringify([
		{
			id: 0,
			tab_id: 0,
			is_plugin: false,
			exited: false,
			pane_command: "pi",
			pane_cwd: currentCwd,
		},
	]);
	const worldHomePanes = JSON.stringify([
		{
			id: 0,
			tab_id: 0,
			is_plugin: false,
			exited: false,
			pane_command: "pi",
			pane_cwd: "/work/other",
		},
	]);
	await writeFile(
		script,
		`#!/bin/sh
if [ "$1" = list-sessions ]; then printf 'tartarus\\nworld-home\\n'; exit 0; fi
if [ "$3" != action ]; then exit 2; fi
if [ "$4" = list-panes ] && [ "$2" = tartarus ]; then printf '%s\\n' ${JSON.stringify(tartarusPanes)}; exit 0; fi
if [ "$4" = list-panes ] && [ "$2" = world-home ]; then printf '%s\\n' ${JSON.stringify(worldHomePanes)}; exit 0; fi
if [ "$4" = new-tab ]; then printf '%s' "$2" > ${JSON.stringify(record)}; printf '7\\n'; exit 0; fi
exit 2
`,
	);
	await chmod(script, 0o755);
	const previous = {
		bin: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		zellij: process.env.ZELLIJ,
		pane: process.env.ZELLIJ_PANE_ID,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_SUBAGENT_ZELLIJ_BIN = script;
	process.env.ZELLIJ = "0";
	process.env.ZELLIJ_PANE_ID = "0";
	process.env.ZELLIJ_SESSION_NAME = "world-home";
	invalidateSessionCache();
	try {
		assert.deepEqual(
			await newTab("name", "/tmp", ["pi"], {
				PI_SUBAGENT_CHILD: "1",
			}),
			{ tabId: 7, sessionName: "tartarus" },
		);
		assert.equal(await readFile(record, "utf8"), "tartarus");
	} finally {
		if (previous.bin === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous.bin;
		if (previous.zellij === undefined) delete process.env.ZELLIJ;
		else process.env.ZELLIJ = previous.zellij;
		if (previous.pane === undefined) delete process.env.ZELLIJ_PANE_ID;
		else process.env.ZELLIJ_PANE_ID = previous.pane;
		if (previous.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previous.session;
	}
});
