import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Check } from "@sinclair/typebox/value";
import subagentExtension from "./index.ts";
import { canonicalOwnerSessionFile } from "./owner.ts";
import { persistRunResult, runResultPaths } from "./result-store.ts";

interface TestResult {
	content: { text: string }[];
	details: Record<string, unknown>;
}

interface TestTool {
	name: string;
	description: string;
	parameters: unknown;
	execute(...args: unknown[]): Promise<TestResult>;
}

type TestHandler = (...args: unknown[]) => unknown;
interface SentMessage {
	message: Record<string, unknown>;
	options: Record<string, unknown>;
}

function setup(
	handlers?: Map<string, TestHandler>,
	sentMessages?: SentMessage[],
): Map<string, TestTool> {
	const tools = new Map<string, TestTool>();
	const api = {
		on: (name: string, handler: TestHandler) => handlers?.set(name, handler),
		registerTool: (value: unknown) => {
			const tool = value as TestTool;
			tools.set(tool.name, tool);
		},
		registerCommand: () => {},
		getActiveTools: () => ["read"],
		getThinkingLevel: () => "off",
		sendMessage: (message: unknown, options: unknown) =>
			sentMessages?.push({
				message: message as Record<string, unknown>,
				options: options as Record<string, unknown>,
			}),
	};
	const marker = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;
	try {
		subagentExtension(api as unknown as ExtensionAPI);
	} finally {
		if (marker === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = marker;
	}
	return tools;
}

function requireTool(tools: Map<string, TestTool>, name: string): TestTool {
	const tool = tools.get(name);
	if (!tool) throw new Error(`Missing test tool ${name}.`);
	return tool;
}

const context = {
	cwd: "/tmp",
	model: { provider: "p", id: "m" },
	modelRegistry: {
		getAll: () => [{ provider: "p", id: "m" }],
		getAvailable: () => [{ provider: "p", id: "m" }],
	},
} as unknown as ExtensionContext;

test("exactly ten public tools are registered", () => {
	const tools = setup();
	assert.deepEqual(
		[...tools.keys()],
		[
			"subagent_start",
			"subagent_list",
			"subagent_status",
			"subagent_result",
			"subagent_wait",
			"subagent_steer",
			"subagent_follow_up",
			"subagent_interrupt",
			"subagent_kill",
			"subagent_resume",
		],
	);
	const waitParameters = requireTool(tools, "subagent_wait").parameters as {
		properties: { afterRunId?: unknown };
	};
	const startParameters = requireTool(tools, "subagent_start").parameters as {
		properties: {
			task: { minLength?: number };
			model: { minLength?: number };
			thinking: unknown;
		};
		required?: string[];
	};
	assert.ok(waitParameters.properties.afterRunId);
	assert.equal(startParameters.properties.task.minLength, 1);
	assert.equal(startParameters.properties.model.minLength, 1);
	assert.deepEqual(
		new Set(startParameters.required),
		new Set(["task", "model", "thinking"]),
	);
});

test("start and kill descriptions guide child cleanup", () => {
	const tools = setup();
	assert.match(
		requireTool(tools, "subagent_start").description,
		/subagent_kill/,
	);
	assert.match(
		requireTool(tools, "subagent_start").description,
		/no longer useful/,
	);
	assert.match(
		requireTool(tools, "subagent_kill").description,
		/cleanup action/,
	);
	assert.match(
		requireTool(tools, "subagent_kill").description,
		/completed or abandoned children/,
	);
});

test("prompt guidance distinguishes notifications, results, waits, and status", async () => {
	const handlers = new Map<string, TestHandler>();
	const tools = setup(handlers);
	const prompt = (await handlers.get("before_agent_start")?.({
		systemPrompt: "base",
	})) as { systemPrompt: string };
	assert.match(prompt.systemPrompt, /notifications arrive automatically/);
	assert.match(prompt.systemPrompt, /subagent_result/);
	assert.match(prompt.systemPrompt, /finite timeout only for explicit synchronization/);
	assert.match(prompt.systemPrompt, /subagent_status for live diagnostics/);
	assert.match(prompt.systemPrompt, /Do not poll/);
	assert.match(requireTool(tools, "subagent_result").description, /never falls back/);
});

test("all ten tool schemas accept valid parameters and reject invalid parameters", () => {
	const tools = setup();
	const cases: [string, unknown, unknown][] = [
		[
			"subagent_start",
			{ task: "work", model: "p/m", thinking: "high" },
			{ task: "work", thinking: "high" },
		],
		["subagent_list", {}, { includeFinished: "yes" }],
		["subagent_status", { id: "child" }, {}],
		["subagent_result", { id: "child", runId: 1 }, { id: "child" }],
		[
			"subagent_wait",
			{ id: "child", timeoutSeconds: 1 },
			{ id: "child", timeoutSeconds: 0 },
		],
		[
			"subagent_steer",
			{ id: "child", message: "guidance" },
			{ id: "child", message: "" },
		],
		[
			"subagent_follow_up",
			{ id: "child", message: "next" },
			{ id: "child", message: "" },
		],
		["subagent_interrupt", { id: "child" }, {}],
		["subagent_kill", { id: "child" }, {}],
		["subagent_resume", { id: "child" }, {}],
	];
	for (const [name, valid, invalid] of cases) {
		const schema = requireTool(tools, name).parameters as TSchema;
		assert.equal(Check(schema, valid), true, `${name} valid parameters`);
		assert.equal(Check(schema, invalid), false, `${name} invalid parameters`);
	}
	const startSchema = requireTool(tools, "subagent_start")
		.parameters as TSchema;
	assert.equal(
		Check(startSchema, { task: "work", model: "p/m" }),
		false,
		"subagent_start rejects missing thinking",
	);
	assert.equal(
		Check(startSchema, {
			task: "work",
			model: "p/m",
			thinking: "high",
			tools: ["read"],
		}),
		false,
		"subagent_start rejects child tool configuration",
	);
});

test("start is blocked for nested children before launch", async () => {
	const previous = process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "1";
	try {
		const result = await requireTool(setup(), "subagent_start").execute(
			"x",
			{ task: "work", model: "p/m", thinking: "high" },
			undefined,
			undefined,
			context,
		);
		assert.equal(result.details.nestedDelegationBlocked, true);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previous;
	}
});

test("start fails clearly outside Zellij", async () => {
	const previousSession = process.env.ZELLIJ_SESSION_NAME;
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	delete process.env.ZELLIJ_SESSION_NAME;
	delete process.env.PI_SUBAGENT_DEPTH;
	try {
		const result = await requireTool(setup(), "subagent_start").execute(
			"x",
			{ task: "work", model: "p/m", thinking: "high" },
			undefined,
			undefined,
			context,
		);
		assert.match(
			result.content[0]?.text ?? "",
			/Failed to start a detached Zellij session|zellij is installed/,
		);
	} finally {
		if (previousSession === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previousSession;
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
	}
});

test("wait validates target and timeout", async () => {
	const wait = requireTool(setup(), "subagent_wait");
	const badTarget = await wait.execute("x", {
		id: "a",
		all: true,
		timeoutSeconds: 1,
	});
	assert.match(badTarget.content[0]?.text ?? "", /exactly one/);
	const badTimeout = await wait.execute("x", {
		id: "a",
		timeoutSeconds: Number.POSITIVE_INFINITY,
	});
	assert.match(badTimeout.content[0]?.text ?? "", /finite/);
});

test("follow-up and interrupt reject unknown or stopped handles", async () => {
	const tools = setup();
	const follow = await requireTool(tools, "subagent_follow_up").execute("x", {
		id: "missing",
		message: "next",
	});
	const interrupt = await requireTool(tools, "subagent_interrupt").execute(
		"x",
		{
			id: "missing",
		},
	);
	assert.match(follow.content[0]?.text ?? "", /Unknown/);
	assert.match(interrupt.content[0]?.text ?? "", /Unknown/);
});

test("same-session resume hello clears an active parent run view", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-parent-resume-"));
	const agentDirectory = join(directory, "agent");
	const socketPath = join(directory, "bridge.sock");
	const zellij = join(directory, "zellij");
	const childId = "resume-child";
	const ownerSessionFile = await canonicalOwnerSessionFile("/tmp/owner.jsonl");
	const ownerSessionId = "owner-resume-uuid";
	const controllerInstanceId = "controller-resume";
	const incarnation = "inc-resume";
	const panes = JSON.stringify([
		{
			id: 2,
			tab_id: 1,
			is_plugin: false,
			exited: false,
			pane_command: "pi",
			terminal_command: `env PI_SUBAGENT_CHILD_ID=${childId} PI_SUBAGENT_OWNER_SESSION_FILE=${ownerSessionFile} PI_SUBAGENT_OWNER_SESSION_ID=${ownerSessionId} PI_SUBAGENT_CONTROLLER_INSTANCE_ID=${controllerInstanceId} PI_SUBAGENT_INCARNATION=${incarnation} BRIDGE_SOCKET_PATH=${socketPath} pi`,
		},
	]);
	await writeFile(
		zellij,
		`#!/bin/sh
if [ "$2" = list-panes ]; then printf '%s\\n' ${JSON.stringify(panes)}; exit 0; fi
exit 2
`,
	);
	await chmod(zellij, 0o755);
	await mkdir(join(agentDirectory, "sessions", "subagents"), {
		recursive: true,
	});
	const ownerKey = createHash("sha1")
		.update(ownerSessionFile)
		.digest("hex")
		.slice(0, 24);
	const ownerRegDir = join(
		agentDirectory,
		"sessions",
		"subagents",
		"controllers",
		ownerKey,
	);
	await mkdir(ownerRegDir, { recursive: true, mode: 0o700 });
	await writeFile(
		join(ownerRegDir, "registry.json"),
		`${JSON.stringify([
			{
				childId,
				task: "task",
				cwd: "/tmp",
				tabId: 1,
				paneId: 2,
				sessionDir: directory,
				socketPath,
				sessionFile: "/tmp/same-session.jsonl",
				requestedModel: "p/m",
				requestedThinking: "off",
				processState: "alive",
				runState: "running",
				runId: 8,
				lastSettledRunId: 7,
				createdAt: 1,
				lastActivityAt: 1,
				ownerSessionFile,
				ownerSessionId,
				controllerInstanceId,
				incarnation,
			},
		])}\n`,
	);
	const old = {
		agentDirectory: process.env.PI_CODING_AGENT_DIR,
		zellij: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_ZELLIJ_BIN = zellij;
	process.env.ZELLIJ_SESSION_NAME = "test";
	const handlers = new Map<string, TestHandler>();
	let socket: net.Socket | undefined;
	const sessionContext = {
		mode: "json",
		sessionManager: {
			getSessionFile: () => ownerSessionFile,
			getSessionId: () => ownerSessionId,
		},
	} as unknown as ExtensionContext;
	try {
		const tools = setup(handlers);
		await handlers.get("session_start")?.(
			{ reason: "startup" },
			sessionContext,
		);
		socket = net.createConnection(socketPath);
		await new Promise<void>((resolve, reject) => {
			socket?.once("connect", resolve);
			socket?.once("error", reject);
		});
		socket.write(
			`${JSON.stringify({
				type: "hello",
				schemaVersion: 1,
				childId,
				connectionId: "resumed-connection",
				at: Date.now(),
				ownerSessionFile,
				ownerSessionId,
				launchControllerInstanceId: controllerInstanceId,
				incarnation,
				sessionId: "same-session",
				sessionFile: "/tmp/same-session.jsonl",
				sessionFileExists: true,
				pid: 99,
				model: { provider: "p", id: "m" },
				thinkingLevel: "off",
				reason: "resume",
			})}\n`,
		);
		let result: TestResult | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			result = await requireTool(tools, "subagent_status").execute("x", {
				id: childId,
			});
			if (result.details.pid === 99) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(result?.details.pid, 99);
		assert.equal(result?.details.runState, "idle");
		assert.equal(result?.details.state, "starting");
		assert.equal(result?.details.runId, 8);
		assert.equal(result?.details.lastSettledRunId, 7);
	} finally {
		await handlers.get("session_shutdown")?.(
			{ reason: "reload" },
			sessionContext,
		);
		socket?.destroy();
		if (old.agentDirectory === undefined)
			delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDirectory;
		if (old.zellij === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = old.zellij;
		if (old.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = old.session;
	}
});

interface SerializedHandle {
	pid?: number;
	processState: string;
	runId?: number;
	lastSettledRunId?: number;
	diagnostics?: string[];
}

async function eventually(
	predicate: () => Promise<boolean> | boolean,
	timeout = 3000,
): Promise<void> {
	const end = Date.now() + timeout;
	for (;;) {
		const result = await predicate();
		if (result) return;
		if (Date.now() > end) assert.fail("condition timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function setupControllerWithChild(opts: {
	childId?: string;
	incarnation?: string;
	controllerInstanceId?: string;
	ownerSessionFile?: string;
	processState?: "alive" | "stopped";
	hasSessionFile?: boolean;
	panePresent?: boolean;
	paneIncarnation?: string;
	runId?: number;
	lastSettledRunId?: number;
}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-acc-"));
	const agentDirectory = join(directory, "agent");
	const zellij = join(directory, "zellij");
	const childId = opts.childId ?? `child-${Date.now().toString(36)}`;
	const incarnation = opts.incarnation ?? `inc-${Date.now().toString(36)}`;
	const controllerInstanceId =
		opts.controllerInstanceId ?? `ctrl-${Date.now().toString(36)}`;
	const ownerSessionFile = await canonicalOwnerSessionFile(
		opts.ownerSessionFile ?? `/tmp/owner-${Date.now().toString(36)}.jsonl`,
	);
	const ownerSessionId = `uuid-${Date.now().toString(36)}`;
	const socketPath = join(directory, "bridge.sock");
	const sessionFilePath = join(directory, `${childId}.jsonl`);
	const paneIncarnation = opts.paneIncarnation ?? incarnation;
	const panePresent = opts.panePresent ?? true;
	const paneCommand = `env PI_SUBAGENT_CHILD_ID=${childId} PI_SUBAGENT_OWNER_SESSION_FILE=${ownerSessionFile} PI_SUBAGENT_OWNER_SESSION_ID=${ownerSessionId} PI_SUBAGENT_CONTROLLER_INSTANCE_ID=${controllerInstanceId} PI_SUBAGENT_INCARNATION=${paneIncarnation} BRIDGE_SOCKET_PATH=${socketPath} pi`;
	const panes = panePresent
		? JSON.stringify([
				{
					id: 2,
					tab_id: 1,
					is_plugin: false,
					exited: false,
					pane_command: "pi",
					terminal_command: paneCommand,
				},
			])
		: JSON.stringify([]);
	await writeFile(
		zellij,
		`#!/bin/sh\nif [ "$2" = list-panes ]; then printf '%s\\n' ${JSON.stringify(panes)}; exit 0; fi\nexit 2\n`,
	);
	await chmod(zellij, 0o755);
	const ownerKey = createHash("sha1")
		.update(ownerSessionFile)
		.digest("hex")
		.slice(0, 24);
	const ownerRegDir = join(
		agentDirectory,
		"sessions",
		"subagents",
		"controllers",
		ownerKey,
	);
	const registryPath = join(ownerRegDir, "registry.json");
	await mkdir(ownerRegDir, { recursive: true, mode: 0o700 });
	const sessionDir = join(agentDirectory, "sessions", "subagents", childId);
	await mkdir(sessionDir, { recursive: true, mode: 0o700 });
	if (opts.hasSessionFile)
		await writeFile(sessionFilePath, `{"type":"session"}\n`, {
			mode: 0o600,
		});
	await writeFile(
		registryPath,
		`${JSON.stringify([
			{
				childId,
				task: "task",
				cwd: directory,
				tabId: 1,
				paneId: 2,
				sessionDir,
				socketPath,
				sessionFile: opts.hasSessionFile ? sessionFilePath : undefined,
				requestedModel: "p/m",
				requestedThinking: "off",
				processState: opts.processState ?? "alive",
				runState: "idle",
				runId: opts.runId ?? 0,
				lastSettledRunId: opts.lastSettledRunId ?? 0,
				createdAt: 1,
				lastActivityAt: 1,
				ownerSessionFile,
				ownerSessionId,
				controllerInstanceId,
				incarnation,
			},
		])}\n`,
		{ mode: 0o600 },
	);
	const old = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		zellijBin: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_ZELLIJ_BIN = zellij;
	process.env.ZELLIJ_SESSION_NAME = "test";
	const handlers = new Map<string, TestHandler>();
	const sentMessages: SentMessage[] = [];
	const ctx = {
		mode: "json",
		sessionManager: {
			getSessionFile: () => ownerSessionFile,
			getSessionId: () => ownerSessionId,
		},
	} as unknown as ExtensionContext;
	const tools = setup(handlers, sentMessages);
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	return {
		tools,
		handlers,
		sentMessages,
		ctx,
		agentDirectory,
		zellijScript: zellij,
		ownerSessionFile,
		ownerSessionId,
		childId,
		incarnation,
		controllerInstanceId,
		socketPath,
		registryPath,
		sessionDir,
		sessionFilePath,
		paneCommand,
		cleanup: async () => {
			await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
			if (old.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = old.agentDir;
			if (old.zellijBin === undefined)
				delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
			else process.env.PI_SUBAGENT_ZELLIJ_BIN = old.zellijBin;
			if (old.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
			else process.env.ZELLIJ_SESSION_NAME = old.session;
		},
	};
}

function connectSocket(path: string): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(path);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

function makeFrame(
	type: string,
	base: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): string {
	return `${JSON.stringify({ type, schemaVersion: 1, at: Date.now(), ...base, ...extra })}\n`;
}

test("wait preserves timeout, cancellation, all-child, and stopped-process behavior", async () => {
	const live = await setupControllerWithChild({ hasSessionFile: true });
	try {
		const timedOut = await requireTool(live.tools, "subagent_wait").execute(
			"x",
			{ id: live.childId, timeoutSeconds: 1 },
		);
		assert.equal(timedOut.details.outcome, "timedOut");
		const controller = new AbortController();
		controller.abort();
		const canceled = await requireTool(live.tools, "subagent_wait").execute(
			"x",
			{ id: live.childId, timeoutSeconds: 1 },
			controller.signal,
		);
		assert.equal(canceled.details.outcome, "canceled");
	} finally {
		await live.cleanup();
	}

	const stopped = await setupControllerWithChild({ processState: "stopped" });
	try {
		const stoppedResult = await requireTool(
			stopped.tools,
			"subagent_wait",
		).execute("x", { id: stopped.childId, timeoutSeconds: 1 });
		assert.equal(stoppedResult.details.outcome, "completed");
		const allResult = await requireTool(stopped.tools, "subagent_wait").execute(
			"x",
			{ all: true, timeoutSeconds: 1 },
		);
		assert.equal(allResult.details.outcome, "completed");
	} finally {
		await stopped.cleanup();
	}
});

test("subagent_result returns stable structured artifact states", async () => {
	const unknown = await requireTool(setup(), "subagent_result").execute("x", {
		id: "missing-child",
		runId: 1,
	});
	assert.deepEqual(unknown.details, {
		status: "unknown_child",
		reason: "unknown_child",
		available: false,
		childId: "missing-child",
		runId: 1,
	});

	const s = await setupControllerWithChild({
		processState: "stopped",
		runId: 4,
		lastSettledRunId: 4,
	});
	try {
		const missing = await requireTool(s.tools, "subagent_result").execute(
			"x",
			{ id: s.childId, runId: 1 },
		);
		assert.equal(missing.details.status, "missing");
		assert.equal(missing.details.reason, "artifact_missing");

		const incompletePaths = runResultPaths(s.sessionDir, 2);
		await mkdir(incompletePaths.directory, { recursive: true });
		await writeFile(incompletePaths.resultPath, "partial");
		const incomplete = await requireTool(
			s.tools,
			"subagent_result",
		).execute("x", { id: s.childId, runId: 2 });
		assert.equal(incomplete.details.status, "incomplete");
		assert.equal(incomplete.details.reason, "artifact_incomplete");

		const invalidPaths = runResultPaths(s.sessionDir, 3);
		await mkdir(invalidPaths.directory, { recursive: true });
		await writeFile(invalidPaths.resultPath, "invalid");
		await writeFile(invalidPaths.metadataPath, "not-json");
		const invalid = await requireTool(s.tools, "subagent_result").execute(
			"x",
			{ id: s.childId, runId: 3 },
		);
		assert.equal(invalid.details.status, "invalid_metadata");
		assert.equal(invalid.details.reason, "metadata_invalid");

		await persistRunResult(s.sessionDir, {
			runId: 4,
			outcome: "failed",
			incarnation: s.incarnation,
			settledAt: 40,
			result: "",
		});
		const available = await requireTool(s.tools, "subagent_result").execute(
			"x",
			{ id: s.childId, runId: 4 },
		);
		const repeated = await requireTool(s.tools, "subagent_result").execute(
			"x",
			{ id: s.childId, runId: 4 },
		);
		assert.equal(available.details.status, "available");
		assert.equal(available.details.reason, "result_available");
		assert.equal(available.details.outcome, "failed");
		assert.equal(available.content[0]?.text, "");
		assert.deepEqual(repeated, available);
	} finally {
		await s.cleanup();
	}
});

test("an older settlement cannot repopulate a newer run fallback", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	const originalRename = nodeFs.rename;
	let releaseRename = () => {};
	let renameBlocked = false;
	let socket: net.Socket | undefined;
	try {
		socket = await connectSocket(s.socketPath);
		socket.setEncoding("utf8");
		const f = (type: string, extra: Record<string, unknown> = {}) =>
			socket?.write(
				makeFrame(
					type,
					{
						childId: s.childId,
						connectionId: "race-connection",
						ownerSessionFile: s.ownerSessionFile,
						ownerSessionId: s.ownerSessionId,
						launchControllerInstanceId: s.controllerInstanceId,
						incarnation: s.incarnation,
					},
					extra,
				),
			);
		f("hello", {
			sessionId: "race-session",
			sessionFile: s.sessionFilePath,
			sessionFileExists: true,
			pid: 101,
			model: { provider: "p", id: "m" },
			thinkingLevel: "off",
			reason: "startup",
		});
		await eventually(() =>
			requireTool(s.tools, "subagent_list")
				.execute("x", {})
				.then((result) =>
					(result.details.handles as SerializedHandle[]).some(
						(handle) => handle.pid === 101,
					),
				),
		);

		const firstPaths = runResultPaths(s.sessionDir, 1);
		const renameRelease = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		nodeFs.rename = async (oldPath, newPath) => {
			if (!renameBlocked && String(newPath) === firstPaths.directory) {
				renameBlocked = true;
				await renameRelease;
			}
			return originalRename(oldPath, newPath);
		};
		const firstMessage = {
			role: "assistant",
			api: "test",
			provider: "test",
			model: "m",
			timestamp: Date.now(),
			responseId: "race-run-1",
			content: [{ type: "text", text: "run one output" }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			},
		};
		f("event", { event: "agent_start", runId: 1 });
		f("event", {
			event: "message_start",
			runId: 1,
			message: { ...firstMessage, content: [] },
		});
		f("event", { event: "message_end", runId: 1, message: firstMessage });
		f("event", {
			event: "agent_end",
			runId: 1,
			willRetry: false,
			messages: [firstMessage],
		});
		f("event", {
			event: "agent_settled",
			runId: 1,
			runOutcome: "succeeded",
		});
		await eventually(() => renameBlocked);

		f("event", { event: "agent_start", runId: 2 });
		await eventually(async () => {
			const entries = JSON.parse(await readFile(s.registryPath, "utf8")) as {
				runId?: number;
				runState?: string;
			}[];
			return entries[0]?.runId === 2 && entries[0]?.runState === "running";
		});
		releaseRename();
		const firstResult = await requireTool(
			s.tools,
			"subagent_result",
		).execute("x", { id: s.childId, runId: 1 });
		assert.equal(firstResult.content[0]?.text, "run one output");

		const secondMessage = {
			...firstMessage,
			timestamp: Date.now() + 1,
			responseId: "race-run-2",
			content: [],
		};
		f("event", {
			event: "message_start",
			runId: 2,
			message: secondMessage,
		});
		f("event", { event: "message_end", runId: 2, message: secondMessage });
		f("event", {
			event: "agent_end",
			runId: 2,
			willRetry: false,
			messages: [secondMessage],
		});
		f("event", {
			event: "agent_settled",
			runId: 2,
			runOutcome: "succeeded",
		});
		await eventually(async () => {
			const entries = JSON.parse(await readFile(s.registryPath, "utf8")) as {
				lastSettledRunId?: number;
			}[];
			return entries[0]?.lastSettledRunId === 2;
		});
		const secondResult = await requireTool(
			s.tools,
			"subagent_result",
		).execute("x", { id: s.childId, runId: 2 });
		assert.equal(secondResult.details.status, "available");
		assert.equal(secondResult.content[0]?.text, "");
		assert.equal(await readFile(firstPaths.resultPath, "utf8"), "run one output");
		assert.equal(
			await readFile(runResultPaths(s.sessionDir, 2).resultPath, "utf8"),
			"",
		);
		assert.equal(await readFile(join(s.sessionDir, "result.md"), "utf8"), "");
	} finally {
		releaseRename();
		nodeFs.rename = originalRename;
		socket?.destroy();
		await s.cleanup();
	}
});

test("result visibility: settled wait exposes content and details.result", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	try {
		const socket = await connectSocket(s.socketPath);
		socket.setEncoding("utf8");
		const f = (t: string, x: Record<string, unknown> = {}) =>
			socket.write(
				makeFrame(
					t,
					{
						childId: s.childId,
						connectionId: "c1",
						ownerSessionFile: s.ownerSessionFile,
						ownerSessionId: s.ownerSessionId,
						launchControllerInstanceId: s.controllerInstanceId,
						incarnation: s.incarnation,
					},
					x,
				),
			);
		f("hello", {
			sessionId: "s1",
			sessionFile: s.sessionFilePath,
			sessionFileExists: true,
			pid: 100,
			model: { provider: "p", id: "m" },
			thinkingLevel: "off",
			reason: "startup",
		});
		await eventually(() =>
			requireTool(s.tools, "subagent_list")
				.execute("x", {})
				.then((r) =>
					(r.details.handles as SerializedHandle[]).some((h) => h.pid === 100),
				),
		);
		const messageTimestamp = Date.now();
		const assistantMessage = {
			role: "assistant",
			api: "test",
			provider: "test",
			model: "m",
			timestamp: messageTimestamp,
			responseId: `r-${messageTimestamp}`,
			content: [{ type: "text", text: "final answer" }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			},
		};
		f("event", { event: "agent_start", runId: 1 });
		await eventually(() =>
			requireTool(s.tools, "subagent_status")
				.execute("x", { id: s.childId })
				.then((result) => result.details.runState === "running"),
		);
		const pendingResult = await requireTool(
			s.tools,
			"subagent_result",
		).execute("x", { id: s.childId, runId: 1 });
		assert.equal(pendingResult.details.status, "pending");
		assert.equal(pendingResult.details.reason, "run_active");
		assert.equal(pendingResult.details.outcome, undefined);
		f("event", {
			event: "message_start",
			runId: 1,
			message: { ...assistantMessage, content: [] },
		});
		f("event", {
			event: "message_end",
			runId: 1,
			message: assistantMessage,
		});
		f("event", {
			event: "agent_end",
			willRetry: false,
			messages: [assistantMessage],
			runId: 1,
		});
		f("event", {
			event: "agent_settled",
			runOutcome: "succeeded",
			runId: 1,
		});
		f("snapshot", {
			sessionId: "s1",
			sessionFile: s.sessionFilePath,
			runState: "idle",
			runId: 1,
			runOutcome: "succeeded",
			isStreaming: false,
			assistantTail: "final answer",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turns: 1,
			},
			updatedAt: Date.now(),
		});
		await eventually(() =>
			requireTool(s.tools, "subagent_list")
				.execute("x", {})
				.then((r) =>
					(r.details.handles as SerializedHandle[]).some(
						(h) => h.lastSettledRunId === 1,
					),
				),
		);
		const waitResult = await requireTool(s.tools, "subagent_wait").execute(
			"x",
			{ id: s.childId, timeoutSeconds: 2 },
		);
		assert.equal(waitResult.details.outcome, "completed");
		assert.equal(waitResult.content[0]?.text, "final answer");
		assert.equal(waitResult.details.result, "final answer");
		assert.equal(waitResult.details.runId, 1);
		const allWaitResult = await requireTool(
			s.tools,
			"subagent_wait",
		).execute("x", { all: true, timeoutSeconds: 1 });
		assert.equal(allWaitResult.details.outcome, "completed");
		assert.equal(allWaitResult.details.result, "final answer");
		const firstResult = await requireTool(
			s.tools,
			"subagent_result",
		).execute("x", { id: s.childId, runId: 1 });
		assert.equal(firstResult.content[0]?.text, "final answer");
		assert.equal(firstResult.details.outcome, "succeeded");
		assert.equal(
			await readFile(join(s.sessionDir, "result.md"), "utf8"),
			"final answer",
		);
		await eventually(() => s.sentMessages.length === 1);
		assert.deepEqual(s.sentMessages[0]?.options, {
			triggerTurn: true,
			deliverAs: "steer",
		});
		const firstNotification = s.sentMessages[0]?.message.details as {
			settlements: { runId: number; outcome: string }[];
		};
		assert.equal(firstNotification.settlements.length, 1);
		assert.equal(firstNotification.settlements[0]?.runId, 1);
		assert.equal(firstNotification.settlements[0]?.outcome, "succeeded");

		const settleRun = (
			runId: number,
			text: string,
			outcome: "succeeded" | "failed" | "aborted",
		) => {
			const timestamp = Date.now() + runId;
			const message = {
				...assistantMessage,
				timestamp,
				responseId: `r-${timestamp}`,
				content: [{ type: "text", text }],
				stopReason: outcome === "failed" ? "error" : outcome,
				errorMessage: outcome === "failed" ? "run failed" : undefined,
			};
			f("event", { event: "agent_start", runId });
			f("event", {
				event: "message_start",
				runId,
				message: { ...message, content: [] },
			});
			f("event", { event: "message_end", runId, message });
			f("event", {
				event: "agent_end",
				willRetry: false,
				messages: [message],
				runId,
			});
			f("event", {
				event: "agent_settled",
				runOutcome: outcome,
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				runId,
			});
		};
		const secondWait = requireTool(s.tools, "subagent_wait").execute(
			"x",
			{ id: s.childId, timeoutSeconds: 2, afterRunId: 1 },
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		settleRun(2, "", "failed");
		const secondWaitResult = await secondWait;
		assert.equal(secondWaitResult.details.runId, 2);
		assert.equal(secondWaitResult.details.runOutcome, "failed");
		assert.equal(secondWaitResult.content[0]?.text, "");
		assert.equal(await readFile(join(s.sessionDir, "result.md"), "utf8"), "");
		settleRun(3, "", "aborted");
		await eventually(() =>
			requireTool(s.tools, "subagent_status")
				.execute("x", { id: s.childId })
				.then((result) => result.details.lastSettledRunId === 3),
		);
		const retainedFirst = await requireTool(
			s.tools,
			"subagent_result",
		).execute("x", { id: s.childId, runId: 1 });
		const failedResult = await requireTool(
			s.tools,
			"subagent_result",
		).execute("x", { id: s.childId, runId: 2 });
		assert.equal(retainedFirst.content[0]?.text, "final answer");
		assert.equal(failedResult.content[0]?.text, "");
		assert.equal(failedResult.details.outcome, "failed");
		assert.equal(
			await readFile(join(s.sessionDir, "runs", "1", "result.md"), "utf8"),
			"final answer",
		);
		assert.equal(
			await readFile(join(s.sessionDir, "runs", "2", "result.md"), "utf8"),
			"",
		);
		const missing = await requireTool(s.tools, "subagent_result").execute(
			"x",
			{ id: s.childId, runId: 99 },
		);
		assert.equal(missing.details.available, false);
		assert.equal(missing.details.status, "missing");
		assert.equal(missing.details.reason, "run_not_known");
		await eventually(() => s.sentMessages.length === 2);
		const secondNotification = s.sentMessages[1]?.message.details as {
			settlements: { runId: number; outcome: string }[];
		};
		assert.deepEqual(
			secondNotification.settlements.map(({ runId, outcome }) => ({
				runId,
				outcome,
			})),
			[
				{ runId: 2, outcome: "failed" },
				{ runId: 3, outcome: "aborted" },
			],
		);

		const abortedResult = await requireTool(
			s.tools,
			"subagent_result",
		).execute("x", { id: s.childId, runId: 3 });
		assert.equal(abortedResult.details.outcome, "aborted");
		assert.equal(abortedResult.content[0]?.text, "");
		assert.equal(await readFile(join(s.sessionDir, "result.md"), "utf8"), "");

		settleRun(4, "shutdown result", "succeeded");
		await eventually(() =>
			requireTool(s.tools, "subagent_status")
				.execute("x", { id: s.childId })
				.then((result) => result.details.lastSettledRunId === 4),
		);
		await s.handlers.get("session_shutdown")?.({ reason: "reload" }, s.ctx);
		await s.handlers.get("session_start")?.({ reason: "reload" }, s.ctx);
		await new Promise((resolve) => setTimeout(resolve, 75));
		assert.equal(s.sentMessages.length, 2);
		socket.destroy();
	} finally {
		await s.cleanup();
	}
});

test("foreign and legacy registries are not loaded or modified", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-foreign-"));
	const agentDirectory = join(directory, "agent");
	const zellij = join(directory, "zellij");
	const foreignOwner = `/tmp/foreign-${Date.now().toString(36)}.jsonl`;
	const foreignKey = createHash("sha1")
		.update(foreignOwner)
		.digest("hex")
		.slice(0, 24);
	const foreignRegDir = join(
		agentDirectory,
		"sessions",
		"subagents",
		"controllers",
		foreignKey,
	);
	await mkdir(foreignRegDir, { recursive: true, mode: 0o700 });
	const foreignSessionDir = join(
		agentDirectory,
		"sessions",
		"subagents",
		"foreign-child",
	);
	await mkdir(foreignSessionDir, { recursive: true, mode: 0o700 });
	const foreignEntry = {
		childId: "foreign-child",
		task: "task",
		cwd: directory,
		tabId: 9,
		paneId: 5,
		sessionDir: foreignSessionDir,
		socketPath: join(directory, "fsock"),
		requestedModel: "p/m",
		requestedThinking: "off",
		processState: "alive",
		runState: "idle",
		createdAt: 1,
		lastActivityAt: 1,
		ownerSessionFile: foreignOwner,
		ownerSessionId: "foreign-uuid",
		controllerInstanceId: "foreign-ctrl",
		incarnation: "foreign-inc",
	};
	const foreignRegistry = `${JSON.stringify([foreignEntry])}\n`;
	await writeFile(join(foreignRegDir, "registry.json"), foreignRegistry, {
		mode: 0o600,
	});
	const legacyRegistryPath = join(
		agentDirectory,
		"sessions",
		"subagents",
		"registry.json",
	);
	await writeFile(legacyRegistryPath, foreignRegistry, { mode: 0o600 });
	const foreignPanes = JSON.stringify([
		{
			id: 5,
			tab_id: 9,
			is_plugin: false,
			exited: false,
			pane_command: "pi",
			terminal_command: `env PI_SUBAGENT_CHILD_ID=foreign-child PI_SUBAGENT_OWNER_SESSION_FILE=${foreignOwner} PI_SUBAGENT_OWNER_SESSION_ID=foreign-uuid PI_SUBAGENT_CONTROLLER_INSTANCE_ID=foreign-ctrl PI_SUBAGENT_INCARNATION=foreign-inc BRIDGE_SOCKET_PATH=${join(directory, "fsock")} pi`,
		},
	]);
	await writeFile(
		zellij,
		`#!/bin/sh\nif [ "$2" = list-panes ]; then printf '%s\\n' ${JSON.stringify(foreignPanes)}; exit 0; fi\nexit 2\n`,
	);
	await chmod(zellij, 0o755);
	const myOwner = `/tmp/my-owner-${Date.now().toString(36)}.jsonl`;
	const old = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		zellijBin: process.env.PI_SUBAGENT_ZELLIJ_BIN,
		session: process.env.ZELLIJ_SESSION_NAME,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_ZELLIJ_BIN = zellij;
	process.env.ZELLIJ_SESSION_NAME = "test";
	const handlers = new Map<string, TestHandler>();
	const ctx = {
		mode: "json",
		sessionManager: {
			getSessionFile: () => myOwner,
			getSessionId: () => "my-uuid",
		},
	} as unknown as ExtensionContext;
	try {
		const tools = setup(handlers);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const listResult = await requireTool(tools, "subagent_list").execute(
			"x",
			{},
		);
		assert.equal((listResult.details.handles as unknown[]).length, 0);
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		assert.equal(await readFile(legacyRegistryPath, "utf8"), foreignRegistry);
	} finally {
		if (old.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDir;
		if (old.zellijBin === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = old.zellijBin;
		if (old.session === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = old.session;
	}
});

test("resume rejects live children and empty session files", async () => {
	const live = await setupControllerWithChild({ hasSessionFile: true });
	try {
		const result = await requireTool(live.tools, "subagent_resume").execute(
			"x",
			{
				id: live.childId,
			},
		);
		assert.match(result.content[0]?.text || "", /still alive/);
	} finally {
		await live.cleanup();
	}
	const empty = await setupControllerWithChild({
		hasSessionFile: true,
		processState: "stopped",
	});
	try {
		await writeFile(empty.sessionFilePath, "");
		const result = await requireTool(empty.tools, "subagent_resume").execute(
			"x",
			{
				id: empty.childId,
			},
		);
		assert.match(result.content[0]?.text || "", /No usable child session file/);
	} finally {
		await empty.cleanup();
	}
});

test("resume opens the exact child session with a new fenced incarnation", async () => {
	const s = await setupControllerWithChild({
		hasSessionFile: true,
		processState: "stopped",
		runId: 7,
		lastSettledRunId: 7,
	});
	const statePath = join(s.agentDirectory, "zellij-state.json");
	const previousPi = process.env.PI_SUBAGENT_PI_BIN;
	process.env.PI_SUBAGENT_PI_BIN = "/fake/pi";
	try {
		await writeFile(
			s.zellijScript,
			`#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nif (args[0] !== "action") process.exit(2);\nif (args[1] === "new-tab") { fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(args)); process.stdout.write("3\\n"); process.exit(0); }\nif (args[1] === "list-panes") { if (!fs.existsSync(${JSON.stringify(statePath)})) { process.stdout.write("[]\\n"); process.exit(0); } const launched = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); process.stdout.write(JSON.stringify([{ id: 4, tab_id: 3, is_plugin: false, exited: false, pane_command: "pi", terminal_command: launched.join(" ") }]) + "\\n"); process.exit(0); }\nprocess.exit(2);\n`,
		);
		await chmod(s.zellijScript, 0o755);
		const resumed = requireTool(s.tools, "subagent_resume").execute("x", {
			id: s.childId,
		});
		const key = createHash("sha1")
			.update(s.ownerSessionFile)
			.digest("hex")
			.slice(0, 24);
		const registry = join(
			s.agentDirectory,
			"sessions",
			"subagents",
			"controllers",
			key,
			"registry.json",
		);
		let next: Record<string, unknown> | undefined;
		await eventually(async () => {
			const entries = JSON.parse(await readFile(registry, "utf8")) as Record<
				string,
				unknown
			>[];
			next = entries[0];
			return (
				next?.incarnation !== s.incarnation &&
				typeof next?.socketPath === "string"
			);
		}, 4000);
		const socket = await connectSocket(String(next?.socketPath));
		socket.write(
			makeFrame(
				"hello",
				{
					childId: s.childId,
					connectionId: "resumed-connection",
					ownerSessionFile: s.ownerSessionFile,
					ownerSessionId: s.ownerSessionId,
					launchControllerInstanceId: String(next?.controllerInstanceId),
					incarnation: String(next?.incarnation),
				},
				{
					sessionId: "resumed-child-session",
					sessionFile: s.sessionFilePath,
					sessionFileExists: true,
					pid: 321,
					model: { provider: "p", id: "m" },
					thinkingLevel: "off",
					reason: "resume",
				},
			),
		);
		const result = await resumed;
		assert.match(result.content[0]?.text || "", /Resumed subagent/);
		const launchArgs = JSON.parse(
			await readFile(statePath, "utf8"),
		) as string[];
		const sessionIndex = launchArgs.indexOf("--session");
		assert.equal(launchArgs[sessionIndex + 1], s.sessionFilePath);
		assert.ok(launchArgs.includes("--offline"));
		const envIndex = launchArgs.indexOf("env");
		const commandIndex = launchArgs.findIndex(
			(value, index) => index > envIndex && !value.includes("="),
		);
		const envKeys = launchArgs
			.slice(envIndex + 1, commandIndex)
			.map((value) => value.slice(0, value.indexOf("=")));
		assert.deepEqual(envKeys, [
			"PI_SUBAGENT_CHILD",
			"PI_SUBAGENT_CHILD_ID",
			"PI_SUBAGENT_OWNER_SESSION_FILE",
			"PI_SUBAGENT_OWNER_SESSION_ID",
			"PI_SUBAGENT_CONTROLLER_INSTANCE_ID",
			"PI_SUBAGENT_INCARNATION",
			"PI_SUBAGENT_RUN_ID_BASE",
			"PI_SUBAGENT_SYSTEM_PROMPT",
			"PI_SUBAGENT_DEPTH",
			"PI_SUBAGENT_PROMPT_PATH",
			"PI_SUBAGENT_SESSION_DIR",
			"BRIDGE_SOCKET_PATH",
			"BRIDGE_LOG_PATH",
			"TERM",
		]);
		assert.notEqual(next?.incarnation, s.incarnation);
		const status = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		assert.equal(status.details.runId, 7);
		socket.destroy();
	} finally {
		if (previousPi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = previousPi;
		await s.cleanup();
	}
});

test("a reloaded same-owner controller recovers a child launched by the prior instance", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	const replacementHandlers = new Map<string, TestHandler>();
	try {
		await s.handlers.get("session_shutdown")?.({ reason: "reload" }, s.ctx);
		const replacementTools = setup(replacementHandlers);
		await replacementHandlers.get("session_start")?.(
			{ reason: "reload" },
			s.ctx,
		);
		const listed = await requireTool(replacementTools, "subagent_list").execute(
			"x",
			{},
		);
		const recovered = (listed.details.handles as SerializedHandle[])[0];
		assert.equal(recovered?.processState, "alive");
		await eventually(() =>
			connectSocket(s.socketPath).then(
				(socket) => {
					socket.destroy();
					return true;
				},
				() => false,
			),
		);
	} finally {
		await replacementHandlers.get("session_shutdown")?.(
			{ reason: "reload" },
			s.ctx,
		);
		await s.cleanup();
	}
});

test("new, resume, and fork session replacements do not adopt prior-owner children", async () => {
	for (const reason of ["new", "resume", "fork"] as const) {
		const s = await setupControllerWithChild({ hasSessionFile: true });
		try {
			await s.handlers.get("session_shutdown")?.({ reason }, s.ctx);
			const replacementCtx = {
				...s.ctx,
				sessionManager: {
					getSessionFile: () =>
						`/tmp/replacement-${reason}-${Date.now()}.jsonl`,
					getSessionId: () => `replacement-${reason}`,
				},
			} as unknown as ExtensionContext;
			await s.handlers.get("session_start")?.({ reason }, replacementCtx);
			const listed = await requireTool(s.tools, "subagent_list").execute(
				"x",
				{},
			);
			assert.equal((listed.details.handles as unknown[]).length, 0);
			await s.handlers.get("session_shutdown")?.(
				{ reason: "reload" },
				replacementCtx,
			);
		} finally {
			await s.cleanup();
		}
	}
});

test("quit closes only an owned identity-validated stopped tab", async () => {
	const s = await setupControllerWithChild({
		hasSessionFile: true,
		processState: "stopped",
	});
	const closed = join(s.agentDirectory, "closed-tab");
	try {
		const panes = JSON.stringify([
			{
				id: 2,
				tab_id: 1,
				is_plugin: false,
				exited: true,
				pane_command: "pi",
				terminal_command: s.paneCommand,
			},
		]);
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nif [ "$2" = list-panes ]; then printf '%s\\n' ${JSON.stringify(panes)}; exit 0; fi\nif [ "$2" = close-tab-by-id ]; then printf closed > ${JSON.stringify(closed)}; exit 0; fi\nexit 2\n`,
		);
		await s.handlers.get("session_shutdown")?.({ reason: "quit" }, s.ctx);
		await eventually(() =>
			readFile(closed, "utf8").then(
				(value) => value === "closed",
				() => false,
			),
		);
	} finally {
		await s.cleanup();
	}
});

test("periodic liveness detects a manual close or hard kill without tool activity", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	try {
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nif [ "$2" = list-panes ]; then printf '[]\\n'; exit 0; fi\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		await eventually(async () => {
			const result = await requireTool(s.tools, "subagent_list").execute(
				"x",
				{},
			);
			const handle = (result.details.handles as SerializedHandle[])[0];
			return handle?.processState === "stopped";
		}, 4000);
	} finally {
		await s.cleanup();
	}
});

test("a failed periodic Zellij probe preserves a live child", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	try {
		await writeFile(s.zellijScript, "#!/bin/sh\nexit 2\n");
		await chmod(s.zellijScript, 0o755);
		await new Promise((resolve) => setTimeout(resolve, 1300));
		const failed = await requireTool(s.tools, "subagent_list").execute("x", {});
		const live = (failed.details.handles as SerializedHandle[])[0];
		assert.equal(live?.processState, "alive");
		assert.ok(
			live?.diagnostics?.some((value) =>
				value.includes("Liveness poll failed"),
			),
		);
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nif [ "$2" = list-panes ]; then printf '[]\\n'; exit 0; fi\nexit 2\n`,
		);
		await eventually(async () => {
			const result = await requireTool(s.tools, "subagent_list").execute(
				"x",
				{},
			);
			return (
				(result.details.handles as SerializedHandle[])[0]?.processState ===
				"stopped"
			);
		}, 4000);
	} finally {
		await s.cleanup();
	}
});

test("authority loss denies steering and killing", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	try {
		const key = createHash("sha1")
			.update(s.ownerSessionFile)
			.digest("hex")
			.slice(0, 24);
		await writeFile(
			join(
				s.agentDirectory,
				"sessions",
				"subagents",
				"controllers",
				key,
				"lease.json",
			),
			`${JSON.stringify({
				ownerSessionFile: s.ownerSessionFile,
				ownerSessionId: s.ownerSessionId,
				controllerInstanceId: "replacement-controller",
				acquiredAt: Date.now(),
				expiresAt: Date.now() + 30_000,
				pid: process.pid,
				renewedAt: Date.now(),
			})}\n`,
		);
		const steer = await requireTool(s.tools, "subagent_steer").execute("x", {
			id: s.childId,
			message: "unsafe",
		});
		assert.match(steer.content[0]?.text || "", /lease is not held/i);
		await assert.rejects(
			requireTool(s.tools, "subagent_kill").execute("x", { id: s.childId }),
			/lease is not held/i,
		);
	} finally {
		await s.cleanup();
	}
});

test("old-incarnation hello, snapshot, event, and ack are rejected", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	try {
		const socket = await connectSocket(s.socketPath);
		socket.setEncoding("utf8");
		const f = (t: string, x: Record<string, unknown> = {}) =>
			socket.write(
				makeFrame(
					t,
					{
						childId: s.childId,
						connectionId: "c1",
						ownerSessionFile: s.ownerSessionFile,
						ownerSessionId: s.ownerSessionId,
						launchControllerInstanceId: s.controllerInstanceId,
						incarnation: s.incarnation,
					},
					x,
				),
			);
		f("hello", {
			sessionId: "s1",
			sessionFile: s.sessionFilePath,
			sessionFileExists: true,
			pid: 100,
			model: { provider: "p", id: "m" },
			thinkingLevel: "off",
			reason: "startup",
		});
		await eventually(() =>
			requireTool(s.tools, "subagent_list")
				.execute("x", {})
				.then((r) =>
					(r.details.handles as SerializedHandle[]).some((h) => h.pid === 100),
				),
		);
		const oldSocket = await connectSocket(s.socketPath);
		oldSocket.write(
			makeFrame(
				"hello",
				{
					childId: s.childId,
					connectionId: "old-c",
					ownerSessionFile: s.ownerSessionFile,
					ownerSessionId: s.ownerSessionId,
					launchControllerInstanceId: s.controllerInstanceId,
					incarnation: "wrong-inc",
				},
				{
					sessionId: "s1",
					sessionFile: s.sessionFilePath,
					sessionFileExists: true,
					pid: 999,
					model: { provider: "p", id: "m" },
					thinkingLevel: "off",
					reason: "startup",
				},
			),
		);
		socket.write(
			makeFrame(
				"snapshot",
				{
					childId: s.childId,
					connectionId: "c1",
					ownerSessionFile: s.ownerSessionFile,
					ownerSessionId: s.ownerSessionId,
					launchControllerInstanceId: s.controllerInstanceId,
					incarnation: "wrong-inc",
				},
				{
					sessionId: "s1",
					sessionFile: s.sessionFilePath,
					runState: "running",
					runId: 99,
					runOutcome: "pending",
					isStreaming: false,
					assistantTail: "",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 0,
					},
					updatedAt: Date.now(),
				},
			),
		);
		for (const [type, extra] of [
			["event", { event: "agent_start", runId: 99 }],
			["ack", { id: "old-request", ok: true, queued: false }],
		] as const) {
			socket.write(
				makeFrame(
					type,
					{
						childId: s.childId,
						connectionId: "c1",
						ownerSessionFile: s.ownerSessionFile,
						ownerSessionId: s.ownerSessionId,
						launchControllerInstanceId: s.controllerInstanceId,
						incarnation: "wrong-inc",
					},
					extra,
				),
			);
		}
		await eventually(() =>
			requireTool(s.tools, "subagent_list")
				.execute("x", {})
				.then((r) =>
					(r.details.handles as SerializedHandle[]).some((h) =>
						(h.diagnostics as string[] | undefined)?.some((d) =>
							/Ignored IPC frame|stale/i.test(d),
						),
					),
				),
		);
		const list = await requireTool(s.tools, "subagent_list").execute("x", {});
		const handle = (list.details.handles as SerializedHandle[])[0];
		assert.equal(handle.runId ?? 0, 0);
		assert.equal(handle.pid, 100);
		oldSocket.destroy();
		socket.destroy();
	} finally {
		await s.cleanup();
	}
});
