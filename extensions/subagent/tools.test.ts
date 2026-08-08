import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Check } from "@sinclair/typebox/value";
import subagentExtension, {
	closeAndDrainIpcMutations,
	withTerminalCleanupLock,
} from "./index.ts";
import {
	canonicalOwnerSessionFile,
	hasLeaseAuthority,
	LEASE_RENEW_INTERVAL_MS,
	LEASE_STALE_GRACE_MS,
	LEASE_TTL_MS,
	leasePath,
	managedSessionPath,
} from "./owner.ts";
import { persistRunResult, runResultPaths } from "./result-store.ts";
import { activeDedicatedSession } from "./zellij-manager.ts";

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
		Check(startSchema, {
			task: "work",
			model: "p/m",
			thinking: "max",
		}),
		true,
		"subagent_start accepts max thinking",
	);
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
	const previousZellij = process.env.PI_SUBAGENT_ZELLIJ_BIN;
	delete process.env.ZELLIJ_SESSION_NAME;
	delete process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_ZELLIJ_BIN = join(
		tmpdir(),
		"missing-pi-subagent-zellij",
	);
	try {
		const result = await requireTool(setup(), "subagent_start").execute(
			"x",
			{ task: "work", model: "p/m", thinking: "max" },
			undefined,
			undefined,
			context,
		);
		assert.match(result.content[0]?.text ?? "", /zellij|guardian|spawn|ENOENT/i);
	} finally {
		if (previousSession === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previousSession;
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		if (previousZellij === undefined)
			delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previousZellij;
	}
});

test("unresolved startup cleanup retains its exact lease until a later retry succeeds", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-startup-authority-"));
	const agentDirectory = join(directory, "agent");
	const binary = join(directory, "zellij");
	const state = join(directory, "sessions");
	const sessionFile = join(directory, "owner.jsonl");
	const sessionId = "startup-authority-owner";
	const ownerIdentity = {
		ownerSessionFile: await canonicalOwnerSessionFile(sessionFile),
		ownerSessionId: sessionId,
	};
	const old = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		zellij: process.env.PI_SUBAGENT_ZELLIJ_BIN,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_ZELLIJ_BIN = binary;
	const handlers = new Map<string, TestHandler>();
	const ctx = {
		mode: "json",
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId,
		},
	} as unknown as ExtensionContext;
	let recovered = false;
	try {
		setup(handlers);
		await assert.rejects(
			handlers.get("session_start")?.({ reason: "startup" }, ctx) as Promise<void>,
			/startup failed|ENOENT|cleanup remains pending/i,
		);
		const retainedLease = JSON.parse(
			await readFile(leasePath(agentDirectory, ownerIdentity), "utf8"),
		) as { controllerInstanceId: string; expiresAt: number };
		assert.equal(typeof retainedLease.controllerInstanceId, "string");
		assert.ok(retainedLease.expiresAt > Date.now());
		assert.equal(
			(await readFile(managedSessionPath(agentDirectory, ownerIdentity), "utf8")).includes("cleanup_pending"),
			true,
		);

		await writeFile(
			binary,
			`#!/bin/sh
if [ "$1" = attach ]; then printf '%s\\n' "$3" > ${JSON.stringify(state)}; exit 0; fi
if [ "$1" = list-sessions ]; then cat ${JSON.stringify(state)} 2>/dev/null; exit 0; fi
if [ "$1" = delete-session ]; then rm -f ${JSON.stringify(state)}; exit 0; fi
exit 2
`,
		);
		await chmod(binary, 0o755);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		recovered = true;
		assert.ok(activeDedicatedSession());
	} finally {
		if (!recovered) {
			await writeFile(
				binary,
				`#!/bin/sh
if [ "$1" = attach ]; then printf '%s\\n' "$3" > ${JSON.stringify(state)}; exit 0; fi
if [ "$1" = list-sessions ]; then cat ${JSON.stringify(state)} 2>/dev/null; exit 0; fi
if [ "$1" = delete-session ]; then rm -f ${JSON.stringify(state)}; exit 0; fi
exit 2
`,
			);
			await chmod(binary, 0o755);
			await handlers.get("session_start")?.({ reason: "startup" }, ctx).catch(() => {});
		}
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx).catch(() => {});
		if (old.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDir;
		if (old.zellij === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = old.zellij;
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
	const zellijSessions = join(directory, "zellij-sessions");
	await writeFile(
		zellij,
		`#!/bin/sh
if [ "$1" = attach ]; then printf '%s\\n' "$3" > ${JSON.stringify(zellijSessions)}; exit 0; fi
if [ "$1" = list-sessions ]; then cat ${JSON.stringify(zellijSessions)} 2>/dev/null; exit 0; fi
if [ "$1" = delete-session ]; then rm -f ${JSON.stringify(zellijSessions)}; exit 0; fi
if [ "$4" = list-panes ]; then printf '%s\\n' ${JSON.stringify(panes)}; exit 0; fi
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
			{ reason: "quit" },
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

const nativeSetTimeout = globalThis.setTimeout;

class FakeWatchdogScheduler {
	private nextId = 1;
	private readonly timers = new Map<
		number,
		{ at: number; callback: (...args: unknown[]) => void; args: unknown[] }
	>();
	private readonly originalNow = performance.now;
	private readonly originalSetTimeout = globalThis.setTimeout;
	private readonly originalClearTimeout = globalThis.clearTimeout;
	now = 0;

	install(): void {
		performance.now = () => this.now;
		globalThis.setTimeout = ((
			callback: (...args: unknown[]) => void,
			delay = 0,
			...args: unknown[]
		) => {
			const id = this.nextId++;
			this.timers.set(id, {
				at: this.now + Math.max(0, Number(delay) || 0),
				callback,
				args,
			});
			return {
				id,
				unref() {
					return this;
				},
			};
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((timer: { id?: number } | number | undefined) => {
			const id = typeof timer === "number" ? timer : timer?.id;
			if (id !== undefined) this.timers.delete(id);
		}) as typeof clearTimeout;
	}

	advanceBy(milliseconds: number): void {
		this.now += milliseconds;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= this.now)
				.sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
			if (!due) return;
			const [id, timer] = due;
			this.timers.delete(id);
			timer.callback(...timer.args);
		}
	}

	get pendingTimers(): number {
		return this.timers.size;
	}

	get scheduledDelays(): number[] {
		return [...this.timers.values()]
			.map((timer) => timer.at - this.now)
			.sort((a, b) => a - b);
	}

	restore(): void {
		this.timers.clear();
		performance.now = this.originalNow;
		globalThis.setTimeout = this.originalSetTimeout;
		globalThis.clearTimeout = this.originalClearTimeout;
	}
}

async function flushController(
	predicate: () => Promise<boolean> | boolean,
	attempts = 1_000,
): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => nativeSetTimeout(resolve, 1));
	}
	assert.fail("controller did not reach the expected deterministic state");
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
	cleanupRequired?: boolean;
	childCount?: number;
	observeUi?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
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
	const zellijSessions = join(directory, "zellij-sessions");
	const defaultZellijScript = `#!/bin/sh
if [ "$1" = attach ]; then printf '%s\\n' "$3" > ${JSON.stringify(zellijSessions)}; exit 0; fi
if [ "$1" = list-sessions ]; then cat ${JSON.stringify(zellijSessions)} 2>/dev/null; exit 0; fi
if [ "$1" = delete-session ]; then rm -f ${JSON.stringify(zellijSessions)}; exit 0; fi
if [ "$4" = list-panes ]; then printf '%s\\n' ${JSON.stringify(panes)}; exit 0; fi
if [ "$4" = new-tab ]; then printf '7\\n'; exit 0; fi
if [ "$4" = close-pane ] || [ "$4" = send-keys ]; then exit 0; fi
exit 2
`;
	await writeFile(zellij, defaultZellijScript);
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
	const children = Array.from({ length: opts.childCount ?? 1 }, (_, index) => ({
		childId: index === 0 ? childId : `${childId}-${index + 1}`,
		incarnation: index === 0 ? incarnation : `${incarnation}-${index + 1}`,
		socketPath: index === 0 ? socketPath : join(directory, `bridge-${index + 1}.sock`),
		paneId: index + 2,
		sessionDir:
			index === 0
				? sessionDir
				: join(agentDirectory, "sessions", "subagents", `${childId}-${index + 1}`),
	}));
	for (const child of children) await mkdir(child.sessionDir, { recursive: true, mode: 0o700 });
	const registryEntries = children.map((child) => ({
		childId: child.childId,
		task: "task",
		cwd: directory,
		tabId: 1,
		paneId: child.paneId,
		zellijSessionName: "",
		terminalCleanupPending: opts.cleanupRequired,
		terminalCleanupError: opts.cleanupRequired ? "prior cleanup failure" : undefined,
		sessionDir: child.sessionDir,
		socketPath: child.socketPath,
		sessionFile: opts.hasSessionFile ? sessionFilePath : undefined,
		requestedModel: "p/m",
		requestedThinking: "off",
		processState: opts.processState ?? "alive",
		runState: "idle",
		runId: opts.runId ?? 0,
		lastSettledRunId: opts.lastSettledRunId ?? 0,
		createdAt: 1 + child.paneId,
		lastActivityAt: 1,
		ownerSessionFile,
		ownerSessionId,
		controllerInstanceId,
		incarnation: child.incarnation,
	}));
	// Provision the fake dedicated lifecycle before publishing fake children,
	// so every fixture pane carries the exact manager-owned session name.
	await writeFile(registryPath, "[]\n", { mode: 0o600 });
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
	let uiRefreshCount = 0;
	const zellijStatuses: (string | undefined)[] = [];
	const ctx = {
		mode: opts.mode ?? (opts.observeUi ? "tui" : "json"),
		cwd: directory,
		modelRegistry: {
			getAll: () => [{ provider: "p", id: "m" }],
			getAvailable: () => [{ provider: "p", id: "m" }],
		},
		sessionManager: {
			getSessionFile: () => ownerSessionFile,
			getSessionId: () => ownerSessionId,
		},
		ui: {
			setWidget: () => {
				uiRefreshCount++;
			},
			setStatus: (key: string, value: string | undefined) => {
				if (key === "subagent-zellij") zellijStatuses.push(value);
			},
		},
	} as unknown as ExtensionContext;
	const tools = setup(handlers, sentMessages);
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	const dedicatedSessionName = activeDedicatedSession();
	assert.ok(dedicatedSessionName);
	for (const entry of registryEntries) entry.zellijSessionName = dedicatedSessionName;
	await writeFile(registryPath, `${JSON.stringify(registryEntries)}\n`, { mode: 0o600 });
	await handlers.get("session_start")?.({ reason: "reload" }, ctx);
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
		children,
		zellijStatuses,
		getUiRefreshCount: () => uiRefreshCount,
		resetUiRefreshCount: () => {
			uiRefreshCount = 0;
		},
		cleanup: async () => {
			await writeFile(zellij, defaultZellijScript);
			await chmod(zellij, 0o755);
			await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
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

for (const mode of ["tui", "rpc", "json", "print"] as const) {
	test(`persisted ${mode} mode provisions and clears an exact dedicated-session status`, async () => {
		const controller = await setupControllerWithChild({
			hasSessionFile: true,
			mode,
		});
		try {
			assert.match(
				controller.zellijStatuses.at(-1) ?? "",
				/^pi[A-Za-z0-9_-]{22}$/,
			);
		} finally {
			await controller.cleanup();
		}
		assert.equal(controller.zellijStatuses.at(-1), undefined);
	});
}

test("reload restores the same exact dedicated-session status", async () => {
	const controller = await setupControllerWithChild({
		hasSessionFile: true,
		mode: "tui",
	});
	const sessionName = controller.zellijStatuses.at(-1);
	try {
		assert.match(
			sessionName ?? "",
			/^pi[A-Za-z0-9_-]{22}$/,
		);
		await controller.handlers.get("session_shutdown")?.(
			{ reason: "reload" },
			controller.ctx,
		);
		assert.equal(controller.zellijStatuses.at(-1), sessionName);
		await controller.handlers.get("session_start")?.(
			{ reason: "reload" },
			controller.ctx,
		);
		assert.equal(controller.zellijStatuses.at(-1), sessionName);
	} finally {
		await controller.cleanup();
	}
	assert.equal(controller.zellijStatuses.at(-1), undefined);
});

test("a parent without a persisted session starts no guardian or Zellij client", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-no-owner-session-"));
	const binary = join(directory, "zellij");
	const calls = join(directory, "calls");
	await writeFile(
		binary,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit 99\n`,
	);
	await chmod(binary, 0o755);
	const previous = process.env.PI_SUBAGENT_ZELLIJ_BIN;
	process.env.PI_SUBAGENT_ZELLIJ_BIN = binary;
	const handlers = new Map<string, TestHandler>();
	const statuses: (string | undefined)[] = [];
	const ctx = {
		mode: "json",
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => undefined,
		},
		ui: {
			setStatus: (key: string, value: string | undefined) => {
				if (key === "subagent-zellij") statuses.push(value);
			},
		},
	} as unknown as ExtensionContext;
	try {
		setup(handlers);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		assert.equal(await readFile(calls, "utf8").catch(() => ""), "");
		assert.deepEqual(statuses, [undefined]);
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_BIN;
		else process.env.PI_SUBAGENT_ZELLIJ_BIN = previous;
	}
});

test("reload retains the lifecycle without referenced guardian pipe handles", async () => {
	const activeHandles = () =>
		(
			process as unknown as {
				_getActiveHandles(): object[];
			}
		)._getActiveHandles();
	const handlesBeforeController = new Set(activeHandles());
	const controller = await setupControllerWithChild({ hasSessionFile: true });
	try {
		await controller.handlers.get("session_shutdown")?.(
			{ reason: "reload" },
			controller.ctx,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		const leakedHandles = activeHandles().filter(
			(handle) => !handlesBeforeController.has(handle),
		);
		assert.deepEqual(
			leakedHandles.map((handle) => handle.constructor.name),
			[],
			"reload must not leave referenced guardian stdin/stdout pipe handles",
		);
	} finally {
		await controller.cleanup();
	}
});

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

function captureFrames(socket: net.Socket): Record<string, unknown>[] {
	const frames: Record<string, unknown>[] = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim()) frames.push(JSON.parse(line) as Record<string, unknown>);
		}
	});
	return frames;
}

function childFrameBase(
	s: {
		childId: string;
		ownerSessionFile: string;
		ownerSessionId: string;
		controllerInstanceId: string;
		incarnation: string;
	},
	connectionId: string,
): Record<string, unknown> {
	return {
		childId: s.childId,
		connectionId,
		ownerSessionFile: s.ownerSessionFile,
		ownerSessionId: s.ownerSessionId,
		launchControllerInstanceId: s.controllerInstanceId,
		incarnation: s.incarnation,
	};
}

async function connectHello(
	s: Awaited<ReturnType<typeof setupControllerWithChild>>,
	connectionId: string,
	pid = 100,
): Promise<{ socket: net.Socket; frames: Record<string, unknown>[] }> {
	const socket = await connectSocket(s.socketPath);
	const frames = captureFrames(socket);
	socket.write(
		makeFrame("hello", childFrameBase(s, connectionId), {
			sessionId: "child-session",
			sessionFile: s.sessionFilePath,
			sessionFileExists: true,
			pid,
			model: { provider: "p", id: "m" },
			thinkingLevel: "off",
			reason: "startup",
		}),
	);
	await flushController(() =>
		requireTool(s.tools, "subagent_status")
			.execute("x", { id: s.childId })
			.then((result) => result.details.pid === pid),
	);
	return { socket, frames };
}

async function finishWatchdogSweep(scheduler: FakeWatchdogScheduler): Promise<void> {
	await flushController(() => scheduler.pendingTimers === 1);
}

async function advanceWatchdog(
	scheduler: FakeWatchdogScheduler,
	milliseconds = 5_000,
): Promise<void> {
	scheduler.advanceBy(milliseconds);
	await finishWatchdogSweep(scheduler);
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
		const laterSettlements = () =>
			s.sentMessages.slice(1).flatMap((notification) => {
				const details = notification.message.details as {
					settlements: { runId: number; outcome: string }[];
				};
				return details.settlements;
			});
		await eventually(() =>
			[2, 3].every((runId) =>
				laterSettlements().some((settlement) => settlement.runId === runId),
			),
		);
		assert.deepEqual(
			laterSettlements().map(({ runId, outcome }) => ({
				runId,
				outcome,
			})),
			[
				{ runId: 2, outcome: "failed" },
				{ runId: 3, outcome: "aborted" },
			],
		);
		const notificationsBeforeRun4 = s.sentMessages.length;

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
		await eventually(() => s.sentMessages.length > notificationsBeforeRun4);
		const notificationCount = s.sentMessages.length;
		await s.handlers.get("session_shutdown")?.({ reason: "reload" }, s.ctx);
		await s.handlers.get("session_start")?.({ reason: "reload" }, s.ctx);
		await new Promise((resolve) => setTimeout(resolve, 75));
		assert.equal(s.sentMessages.length, notificationCount);
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
	const zellijSessions = join(directory, "zellij-sessions");
	await writeFile(
		zellij,
		`#!/bin/sh
if [ "$1" = attach ]; then printf '%s\\n' "$3" > ${JSON.stringify(zellijSessions)}; exit 0; fi
if [ "$1" = list-sessions ]; then cat ${JSON.stringify(zellijSessions)} 2>/dev/null; exit 0; fi
if [ "$1" = delete-session ]; then rm -f ${JSON.stringify(zellijSessions)}; exit 0; fi
if [ "$4" = list-panes ]; then printf '%s\\n' ${JSON.stringify(foreignPanes)}; exit 0; fi
exit 2
`,
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

test("ambiguous new-tab failure retires the whole session and leaves no live child", async () => {
	const s = await setupControllerWithChild({ processState: "stopped" });
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	const childPidPath = join(dirname(s.zellijScript), "ambiguous-child-pid");
	const sessions = join(dirname(s.zellijScript), "zellij-sessions");
	process.env.PI_SUBAGENT_DEPTH = "0";
	let childPid: number | undefined;
	try {
		await writeFile(
			s.zellijScript,
			`#!${process.execPath}
const { existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("new-tab")) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1_000);
} else if (args[0] === "delete-session") {
  if (existsSync(${JSON.stringify(childPidPath)})) {
    try { process.kill(Number(readFileSync(${JSON.stringify(childPidPath)}, "utf8")), "SIGTERM"); } catch {}
  }
  rmSync(${JSON.stringify(sessions)}, { force: true });
  process.exit(0);
} else if (args[0] === "list-sessions") {
  if (existsSync(${JSON.stringify(sessions)})) process.stdout.write(readFileSync(${JSON.stringify(sessions)}, "utf8"));
  process.exit(0);
} else process.exit(2);
`,
		);
		await chmod(s.zellijScript, 0o755);
		const result = await requireTool(s.tools, "subagent_start").execute(
			"x",
			{ task: "work", model: "p/m", thinking: "off" },
			undefined,
			undefined,
			s.ctx,
		);
		assert.match(result.content[0]?.text || "", /timed out/);
		childPid = Number(await readFile(childPidPath, "utf8"));
		await eventually(() => {
			try { process.kill(childPid, 0); return false; }
			catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
		});
		assert.equal(activeDedicatedSession(), undefined);
		const entries = JSON.parse(await readFile(s.registryPath, "utf8")) as Record<string, unknown>[];
		assert.equal(entries.some((entry) => entry.processState === "alive"), false);
		assert.equal(entries.some((entry) => entry.terminalCleanupPending === true), false);
	} finally {
		if (childPid !== undefined) {
			try { process.kill(childPid, "SIGKILL"); } catch {}
		}
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		await s.cleanup();
	}
});

test("resume rejects a stopped child with required terminal cleanup", async () => {
	const s = await setupControllerWithChild({
		hasSessionFile: true,
		processState: "stopped",
		cleanupRequired: true,
	});
	try {
		const result = await requireTool(s.tools, "subagent_resume").execute("x", {
			id: s.childId,
		});
		assert.match(result.content[0]?.text || "", /required terminal cleanup/);
		assert.equal((result.details.handle as { terminalCleanup?: { status?: string } }).terminalCleanup?.status, "pending");
	} finally {
		await s.cleanup();
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
			`#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nconst actionIndex = args.indexOf("action");\nif (actionIndex < 0) process.exit(2);\nconst action = args[actionIndex + 1];\nif (action === "new-tab") { fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(args)); process.stdout.write("3\\n"); process.exit(0); }\nif (action === "list-panes") { if (!fs.existsSync(${JSON.stringify(statePath)})) { process.stdout.write("[]\\n"); process.exit(0); } const launched = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); process.stdout.write(JSON.stringify([{ id: 4, tab_id: 3, is_plugin: false, exited: false, pane_command: "pi", terminal_command: launched.join(" ") }]) + "\\n"); process.exit(0); }\nprocess.exit(2);\n`,
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
		const sessionIndex = launchArgs.lastIndexOf("--session");
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

test("failed replacement retirement renews old authority after the lease-expiry window before retry", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	const sessions = join(dirname(s.zellijScript), "zellij-sessions");
	const oldOwner = {
		ownerSessionFile: s.ownerSessionFile,
		ownerSessionId: s.ownerSessionId,
	};
	const oldLeasePath = leasePath(s.agentDirectory, oldOwner);
	const replacementCtx = {
		...s.ctx,
		sessionManager: {
			getSessionFile: () => `/tmp/replacement-delayed-${Date.now()}.jsonl`,
			getSessionId: () => "replacement-delayed-owner",
		},
	} as unknown as ExtensionContext;
	try {
		await writeFile(
			s.zellijScript,
			`#!/bin/sh
if [ "$1" = attach ]; then printf '%s\\n' "$3" > ${JSON.stringify(sessions)}; exit 0; fi
if [ "$1" = list-sessions ]; then cat ${JSON.stringify(sessions)} 2>/dev/null; exit 0; fi
if [ "$1" = delete-session ]; then exit 2; fi
exit 2
`,
		);
		await chmod(s.zellijScript, 0o755);
		const shuttingDown = s.handlers.get("session_shutdown")?.({ reason: "new" }, s.ctx);
		assert.equal(s.zellijStatuses.at(-1), undefined);
		await shuttingDown;

		const delayedAt = Date.now();
		const lease = JSON.parse(await readFile(oldLeasePath, "utf8")) as Record<
			string,
			unknown
		>;
		lease.expiresAt = delayedAt - LEASE_STALE_GRACE_MS - 1;
		lease.renewedAt = delayedAt - LEASE_TTL_MS - LEASE_STALE_GRACE_MS - 1;
		await writeFile(oldLeasePath, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
		assert.equal(
			await hasLeaseAuthority(
				s.agentDirectory,
				oldOwner,
				String(lease.controllerInstanceId),
				delayedAt,
			),
			false,
		);

		await writeFile(
			s.zellijScript,
			`#!/bin/sh
if [ "$1" = attach ]; then printf '%s\\n' "$3" > ${JSON.stringify(sessions)}; exit 0; fi
if [ "$1" = list-sessions ]; then cat ${JSON.stringify(sessions)} 2>/dev/null; exit 0; fi
if [ "$1" = delete-session ]; then rm -f ${JSON.stringify(sessions)}; exit 0; fi
exit 2
`,
		);
		await chmod(s.zellijScript, 0o755);
		await s.handlers.get("session_start")?.({ reason: "new" }, replacementCtx);
		assert.match(
			activeDedicatedSession() ?? "",
			/^pi[A-Za-z0-9_-]{22}$/,
		);
		await assert.rejects(readFile(oldLeasePath, "utf8"), /ENOENT/);
	} finally {
		await s.cleanup();
	}
});

test("quit does not query panes during controller teardown", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true, processState: "stopped" });
	try {
		await s.handlers.get("session_shutdown")?.({ reason: "quit" }, s.ctx);
		const entries = JSON.parse(await readFile(s.registryPath, "utf8")) as Record<string, unknown>[];
		assert.equal(entries[0]?.terminalCleanupPending, false);
	} finally {
		await s.cleanup();
	}
});

test("controller restart retries durable cleanup after a prior final failure", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true, processState: "stopped" });
	const replacementHandlers = new Map<string, TestHandler>();
	try {
		await s.handlers.get("session_shutdown")?.({ reason: "reload" }, s.ctx);
		const entries = JSON.parse(await readFile(s.registryPath, "utf8")) as Record<string, unknown>[];
		entries[0]!.terminalCleanupPending = true;
		entries[0]!.terminalCleanupError = "three prior cleanup failures";
		await writeFile(s.registryPath, `${JSON.stringify(entries)}\n`);
		const record = join(s.agentDirectory, "zellij-actions");
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(record)}\nif [ "$4" = close-pane ]; then exit 0; fi\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		const replacementTools = setup(replacementHandlers);
		await replacementHandlers.get("session_start")?.({ reason: "reload" }, s.ctx);
		await eventually(() =>
			requireTool(replacementTools, "subagent_status")
				.execute("x", { id: s.childId })
				.then((result) => result.details.terminalCleanup?.status === "complete"),
		);
		await eventually(async () => {
			const persisted = JSON.parse(await readFile(s.registryPath, "utf8")) as Record<
				string,
				unknown
			>[];
			return persisted[0]?.terminalCleanupPending === false;
		});
		const retried = JSON.parse(await readFile(s.registryPath, "utf8")) as Record<string, unknown>[];
		assert.match(await readFile(record, "utf8"), /terminal_2/);
		assert.equal(retried[0]?.terminalCleanupPending, false);
		assert.equal((await requireTool(replacementTools, "subagent_status").execute("x", { id: s.childId })).details.terminalCleanup?.status, "complete");
	} finally {
		await replacementHandlers.get("session_shutdown")?.({ reason: "reload" }, s.ctx);
		await s.cleanup();
	}
});

test("status and wait do not query Zellij", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	try {
		const record = join(s.agentDirectory, "zellij-actions");
		await writeFile(s.zellijScript, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(record)}\nexit 2\n`);
		await chmod(s.zellijScript, 0o755);
		await requireTool(s.tools, "subagent_status").execute("x", { id: s.childId });
		await requireTool(s.tools, "subagent_wait").execute("x", { id: s.childId, timeoutSeconds: 1 });
		assert.doesNotMatch(await readFile(record, "utf8").catch(() => ""), /list-panes/);
	} finally {
		await s.cleanup();
	}
});

test("active interrupt retains its settlement cursor after direct Esc", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	let socket: net.Socket | undefined;
	try {
		const record = join(s.agentDirectory, "zellij-actions");
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nif [ "$4" = send-keys ]; then exit 0; fi\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		socket = await connectSocket(s.socketPath);
		const frame = (type: string, extra: Record<string, unknown> = {}) =>
			makeFrame(type, {
				childId: s.childId,
				connectionId: "interrupt-connection",
				ownerSessionFile: s.ownerSessionFile,
				ownerSessionId: s.ownerSessionId,
				launchControllerInstanceId: s.controllerInstanceId,
				incarnation: s.incarnation,
			}, extra);
		socket.write(frame("hello", {
			sessionId: "child-session",
			sessionFile: s.sessionFilePath,
			sessionFileExists: true,
			pid: 100,
			model: { provider: "p", id: "m" },
			thinkingLevel: "off",
			reason: "startup",
		}));
		socket.write(frame("event", { event: "agent_start", runId: 1 }));
		await eventually(() => requireTool(s.tools, "subagent_status").execute("x", { id: s.childId }).then((result) => result.details.runState === "running"));
		const interrupted = requireTool(s.tools, "subagent_interrupt").execute("x", { id: s.childId });
		await eventually(() => readFile(record, "utf8").then((value) => value.includes("Esc"), () => false));
		const result = await interrupted;
		assert.equal(result.details.interrupted, false);
		assert.match(result.content[0]?.text || "", /settlement acknowledgement timed out/);
	} finally {
		socket?.destroy();
		await s.cleanup();
	}
});

test("a socket closure starts reconnect grace without a Zellij query", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	let socket: net.Socket | undefined;
	try {
		const record = join(s.agentDirectory, "zellij-actions");
		await writeFile(s.zellijScript, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(record)}\nexit 2\n`);
		await chmod(s.zellijScript, 0o755);
		socket = await connectSocket(s.socketPath);
		socket.write(makeFrame("hello", {
			childId: s.childId,
			connectionId: "connection-a",
			ownerSessionFile: s.ownerSessionFile,
			ownerSessionId: s.ownerSessionId,
			launchControllerInstanceId: s.controllerInstanceId,
			incarnation: s.incarnation,
		}, {
			sessionId: "child-session",
			sessionFile: s.sessionFilePath,
			sessionFileExists: true,
			pid: 100,
			model: { provider: "p", id: "m" },
			thinkingLevel: "off",
			reason: "startup",
		}));
		await eventually(() => requireTool(s.tools, "subagent_status").execute("x", { id: s.childId }).then((result) => result.details.pid === 100));
		socket.destroy();
		await eventually(() => requireTool(s.tools, "subagent_status").execute("x", { id: s.childId }).then((result) => result.details.ipcLiveness?.state === "reconnecting"));
		const status = await requireTool(s.tools, "subagent_status").execute("x", { id: s.childId });
		assert.equal(status.details.processState, "alive");
		assert.equal(status.details.ipcLiveness?.state, "reconnecting");
		assert.doesNotMatch(await readFile(record, "utf8").catch(() => ""), /list-panes/);
	} finally {
		socket?.destroy();
		await s.cleanup();
	}
});

test("controller watchdog sends fenced heartbeats without activity, persistence, UI, or Zellij polling", async () => {
	const scheduler = new FakeWatchdogScheduler();
	scheduler.install();
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	let socket: net.Socket | undefined;
	const originalRename = nodeFs.rename.bind(nodeFs);
	let registryWrites = 0;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true, observeUi: true });
		const connected = await connectHello(s, "heartbeat-connection");
		socket = connected.socket;
		const frames = connected.frames;
		const actionLog = join(s.agentDirectory, "watchdog-zellij-actions");
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(actionLog)}\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		for (let turn = 0; turn < 20; turn++)
			await new Promise<void>((resolve) => setImmediate(resolve));
		const before = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		s.resetUiRefreshCount();
		nodeFs.rename = (async (from: string, to: string) => {
			if (to === s?.registryPath) registryWrites++;
			return originalRename(from, to);
		}) as typeof nodeFs.rename;

		await advanceWatchdog(scheduler);
		await advanceWatchdog(scheduler);
		await flushController(() => frames.some((frame) => frame.type === "ping"));
		const pings = frames.filter((frame) => frame.type === "ping");
		assert.equal(pings.length, 1);
		const ping = pings[0]!;
		assert.equal(typeof ping.id, "string");
		assert.equal(ping.ownerSessionFile, s.ownerSessionFile);
		assert.equal(ping.ownerSessionId, s.ownerSessionId);
		assert.equal(ping.launchControllerInstanceId, s.controllerInstanceId);
		assert.equal(ping.incarnation, s.incarnation);
		let status = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		assert.equal(status.details.ipcLiveness?.state, "awaiting_pong");
		assert.equal(status.details.lastActivityAt, before.details.lastActivityAt);

		socket.write(
			makeFrame("pong", childFrameBase(s, "heartbeat-connection"), {
				id: ping.id,
			}),
		);
		await flushController(() =>
			requireTool(s!.tools, "subagent_status")
				.execute("x", { id: s!.childId })
				.then((result) => result.details.ipcLiveness?.state === "healthy"),
		);
		status = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		assert.equal(status.details.processState, "alive");
		assert.equal(status.details.lastActivityAt, before.details.lastActivityAt);

		const answered = new Set([String(ping.id)]);
		for (let interval = 0; interval < 6; interval++) {
			await advanceWatchdog(scheduler);
			const next = frames.find(
				(frame) => frame.type === "ping" && !answered.has(String(frame.id)),
			);
			if (next) {
				answered.add(String(next.id));
				socket.write(
					makeFrame("pong", childFrameBase(s, "heartbeat-connection"), {
						id: next.id,
					}),
				);
				await flushController(() =>
					requireTool(s!.tools, "subagent_status")
						.execute("x", { id: s!.childId })
						.then((result) => result.details.ipcLiveness?.state === "healthy"),
				);
			}
		}
		assert.equal(registryWrites, 0);
		assert.equal(s.getUiRefreshCount(), 0);
		assert.equal(
			(await requireTool(s.tools, "subagent_status").execute("x", { id: s.childId }))
				.details.lastActivityAt,
			before.details.lastActivityAt,
		);
		assert.doesNotMatch(await readFile(actionLog, "utf8").catch(() => ""), /list-panes/);
	} finally {
		nodeFs.rename = originalRename;
		socket?.destroy();
		if (s) await s.cleanup();
		scheduler.restore();
	}
});

test("wrong and missing pong identifiers expire once and directly close the stable pane", async () => {
	const scheduler = new FakeWatchdogScheduler();
	scheduler.install();
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	let socket: net.Socket | undefined;
	const originalRename = nodeFs.rename.bind(nodeFs);
	let terminalStateWrites = 0;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true });
		const connected = await connectHello(s, "expiry-connection");
		socket = connected.socket;
		const actionLog = join(s.agentDirectory, "heartbeat-death-actions");
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(actionLog)}\nif [ "$4" = close-pane ]; then exit 0; fi\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		nodeFs.rename = (async (from: string, to: string) => {
			if (to === s?.registryPath) {
				const entries = JSON.parse(await readFile(from, "utf8")) as Record<
					string,
					unknown
				>[];
				if (
					entries[0]?.processState === "stopped" &&
					entries[0]?.terminalCleanupPending === true
				)
					terminalStateWrites++;
			}
			return originalRename(from, to);
		}) as typeof nodeFs.rename;
		await advanceWatchdog(scheduler);
		await advanceWatchdog(scheduler);
		await flushController(() => connected.frames.some((frame) => frame.type === "ping"));
		const ping = connected.frames.find((frame) => frame.type === "ping")!;
		socket.write(makeFrame("pong", childFrameBase(s, "expiry-connection"), { id: "wrong" }));
		socket.write(makeFrame("pong", childFrameBase(s, "expiry-connection")));
		socket.write(
			makeFrame(
				"pong",
				{ ...childFrameBase(s, "expiry-connection"), connectionId: "wrong-connection" },
				{ id: ping.id },
			),
		);
		socket.write(
			makeFrame(
				"pong",
				{ ...childFrameBase(s, "expiry-connection"), incarnation: "wrong-incarnation" },
				{ id: ping.id },
			),
		);
		socket.write(
			makeFrame("event", childFrameBase(s, "expiry-connection"), {
				event: "session_shutdown",
			}),
		);
		for (let turn = 0; turn < 20; turn++)
			await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(
			(await requireTool(s.tools, "subagent_status").execute("x", { id: s.childId }))
				.details.ipcLiveness?.heartbeatPending,
			true,
		);
		await advanceWatchdog(scheduler);
		await advanceWatchdog(scheduler);
		const waitForDeath = requireTool(s.tools, "subagent_wait").execute("x", {
			id: s.childId,
			timeoutSeconds: 60,
		});
		scheduler.advanceBy(5_000);
		await flushController(async () => {
			const status = await requireTool(s!.tools, "subagent_status").execute("x", {
				id: s!.childId,
			});
			const actions = await readFile(actionLog, "utf8").catch(() => "");
			return (
				status.details.processState === "stopped" &&
				status.details.terminalCleanup?.status === "complete" &&
				actions.includes("terminal_2")
			);
		});
		const waitResult = await waitForDeath;
		assert.equal(waitResult.details.outcome, "completed");
		const status = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		assert.equal(status.details.ipcLiveness?.deathReason, "heartbeat_timeout");
		assert.equal(status.details.terminalCleanup?.status, "complete");
		assert.equal(terminalStateWrites, 1);
		assert.deepEqual((await readFile(actionLog, "utf8")).trim().split("\n"), [
			"--session",
			s.zellijStatuses.find((value): value is string => value !== undefined),
			"action",
			"close-pane",
			"--pane-id",
			"terminal_2",
		]);
		assert.doesNotMatch(await readFile(actionLog, "utf8"), /list-panes/);
		socket.write(
			makeFrame("hello", childFrameBase(s, "expiry-connection"), {
				sessionId: "late-session",
				sessionFile: s.sessionFilePath,
				sessionFileExists: true,
				pid: 999,
				model: { provider: "p", id: "m" },
				thinkingLevel: "off",
				reason: "startup",
			}),
		);
		for (let turn = 0; turn < 10; turn++)
			await new Promise<void>((resolve) => setImmediate(resolve));
		const late = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		assert.equal(late.details.processState, "stopped");
		assert.notEqual(late.details.pid, 999);
	} finally {
		nodeFs.rename = originalRename;
		socket?.destroy();
		if (s) await s.cleanup();
		scheduler.restore();
	}
});

test("reconnect grace accepts a new fenced hello, then expires and rejects a late hello", async () => {
	const scheduler = new FakeWatchdogScheduler();
	scheduler.install();
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	let first: net.Socket | undefined;
	let second: net.Socket | undefined;
	let late: net.Socket | undefined;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true });
		const initial = await connectHello(s, "reconnect-a", 100);
		first = initial.socket;
		const actionLog = join(s.agentDirectory, "reconnect-death-actions");
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(actionLog)}\nif [ "$4" = close-pane ]; then exit 0; fi\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		first.destroy();
		await flushController(() =>
			requireTool(s!.tools, "subagent_status")
				.execute("x", { id: s!.childId })
				.then((result) => result.details.ipcLiveness?.state === "reconnecting"),
		);
		await advanceWatchdog(scheduler);
		await advanceWatchdog(scheduler);
		const reconnected = await connectHello(s, "reconnect-b", 101);
		second = reconnected.socket;
		assert.equal(
			(await requireTool(s.tools, "subagent_status").execute("x", { id: s.childId }))
				.details.ipcLiveness?.state,
			"healthy",
		);
		const answered = new Set<string>();
		for (let interval = 0; interval < 4; interval++) {
			await advanceWatchdog(scheduler);
			const ping = reconnected.frames.find(
				(frame) => frame.type === "ping" && !answered.has(String(frame.id)),
			);
			if (ping) {
				answered.add(String(ping.id));
				second.write(
					makeFrame("pong", childFrameBase(s, "reconnect-b"), { id: ping.id }),
				);
				await flushController(() =>
					requireTool(s!.tools, "subagent_status")
						.execute("x", { id: s!.childId })
						.then((result) => result.details.ipcLiveness?.state === "healthy"),
				);
			}
		}
		assert.equal(
			(await requireTool(s.tools, "subagent_status").execute("x", { id: s.childId }))
				.details.processState,
			"alive",
		);
		assert.equal(await readFile(actionLog, "utf8").catch(() => ""), "");

		second.destroy();
		await flushController(() =>
			requireTool(s!.tools, "subagent_status")
				.execute("x", { id: s!.childId })
				.then((result) => result.details.ipcLiveness?.state === "reconnecting"),
		);
		late = await connectSocket(s.socketPath);
		for (let interval = 0; interval < 5; interval++) await advanceWatchdog(scheduler);
		scheduler.advanceBy(5_000);
		await flushController(async () => {
			const status = await requireTool(s!.tools, "subagent_status").execute("x", {
				id: s!.childId,
			});
			return (
				status.details.ipcLiveness?.deathReason === "reconnect_timeout" &&
				(await readFile(actionLog, "utf8").catch(() => "")).includes("terminal_2")
			);
		});
		late.on("error", () => {});
		late.write(
			makeFrame("hello", childFrameBase(s, "late-reconnect"), {
				sessionId: "late-session",
				sessionFile: s.sessionFilePath,
				sessionFileExists: true,
				pid: 999,
				model: { provider: "p", id: "m" },
				thinkingLevel: "off",
				reason: "startup",
			}),
		);
		for (let turn = 0; turn < 10; turn++)
			await new Promise<void>((resolve) => setImmediate(resolve));
		const status = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		assert.equal(status.details.processState, "stopped");
		assert.equal(status.details.ipcLiveness?.deathReason, "reconnect_timeout");
		assert.notEqual(status.details.pid, 999);
		assert.doesNotMatch(await readFile(actionLog, "utf8"), /list-panes/);
	} finally {
		first?.destroy();
		second?.destroy();
		late?.destroy();
		if (s) await s.cleanup();
		scheduler.restore();
	}
});

test("a controller stall resets the heartbeat observation window", async () => {
	const scheduler = new FakeWatchdogScheduler();
	scheduler.install();
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	let socket: net.Socket | undefined;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true });
		const connected = await connectHello(s, "stall-connection");
		socket = connected.socket;
		await advanceWatchdog(scheduler);
		scheduler.advanceBy(20_000);
		await finishWatchdogSweep(scheduler);
		let status = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		assert.equal(status.details.processState, "alive");
		assert.equal(status.details.ipcLiveness?.state, "healthy");
		assert.equal(connected.frames.filter((frame) => frame.type === "ping").length, 0);
		assert.ok(
			(status.details.diagnostics as string[]).some((message) =>
				message.includes("Watchdog stall reset"),
			),
		);
		await advanceWatchdog(scheduler);
		assert.equal(connected.frames.filter((frame) => frame.type === "ping").length, 0);
		await advanceWatchdog(scheduler);
		await flushController(() => connected.frames.some((frame) => frame.type === "ping"));
		status = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		assert.equal(status.details.ipcLiveness?.state, "awaiting_pong");
	} finally {
		socket?.destroy();
		if (s) await s.cleanup();
		scheduler.restore();
	}
});

test("a delayed authority check cannot overlap watchdog sweeps", async () => {
	const scheduler = new FakeWatchdogScheduler();
	scheduler.install();
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	let socket: net.Socket | undefined;
	const originalReadFile = nodeFs.readFile.bind(nodeFs);
	let releaseAuthority!: () => void;
	const authorityGate = new Promise<void>((resolve) => {
		releaseAuthority = resolve;
	});
	let delayAuthority = false;
	let authorityReads = 0;
	let activeReads = 0;
	let maximumActiveReads = 0;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true });
		const connected = await connectHello(s, "overlap-connection");
		socket = connected.socket;
		const leaseFile = join(s.registryPath, "..", "lease.json");
		nodeFs.readFile = (async (path: string, ...args: unknown[]) => {
			if (delayAuthority && String(path) === leaseFile) {
				authorityReads++;
				activeReads++;
				maximumActiveReads = Math.max(maximumActiveReads, activeReads);
				await authorityGate;
				activeReads--;
			}
			return (originalReadFile as (...values: unknown[]) => Promise<unknown>)(path, ...args);
		}) as typeof nodeFs.readFile;
		delayAuthority = true;
		scheduler.advanceBy(5_000);
		await flushController(() => authorityReads === 1);
		assert.equal(scheduler.pendingTimers, 0);
		scheduler.advanceBy(25_000);
		for (let turn = 0; turn < 20; turn++)
			await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(authorityReads, 1);
		assert.equal(maximumActiveReads, 1);
		releaseAuthority();
		await finishWatchdogSweep(scheduler);
		assert.equal(scheduler.pendingTimers, 1);
	} finally {
		delayAuthority = false;
		releaseAuthority();
		nodeFs.readFile = originalReadFile;
		socket?.destroy();
		if (s) await s.cleanup();
		scheduler.restore();
	}
});

test("one controller watchdog serves multiple handles", async () => {
	const scheduler = new FakeWatchdogScheduler();
	scheduler.install();
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true, childCount: 3 });
		const listed = await requireTool(s.tools, "subagent_list").execute("x", {});
		const handles = listed.details.handles as Array<{
			ipcLiveness?: { state?: string };
		}>;
		assert.equal(handles.length, 3);
		assert.ok(handles.every((handle) => handle.ipcLiveness?.state === "reconnecting"));
		assert.equal(scheduler.pendingTimers, 1);
		await advanceWatchdog(scheduler);
		assert.equal(scheduler.pendingTimers, 1);
		assert.doesNotMatch(
			await readFile(join(s.agentDirectory, "watchdog-actions"), "utf8").catch(() => ""),
			/list-panes/,
		);
	} finally {
		if (s) await s.cleanup();
		scheduler.restore();
	}
});

test("whole-session mutation shutdown closes ingress and drains the queued IPC chain", async () => {
	let releaseMutation!: () => void;
	const gate = new Promise<void>((resolve) => { releaseMutation = resolve; });
	let mutations = 0;
	let transportClosed = false;
	const state = {
		ipcMutationsClosed: false,
		ipcMutationChain: gate.then(() => { mutations++; }),
	};
	const draining = closeAndDrainIpcMutations(state, async () => {
		transportClosed = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(state.ipcMutationsClosed, true);
	assert.equal(transportClosed, true);
	assert.equal(mutations, 0);
	if (!state.ipcMutationsClosed)
		state.ipcMutationChain = state.ipcMutationChain.then(() => { mutations++; });
	releaseMutation();
	await draining;
	assert.equal(mutations, 1);
});

test("concurrent cleanup callers reserve the lock before an authority await", async () => {
	const state: { terminalCleanupActive?: boolean } = {};
	let releaseAuthority!: () => void;
	const authorityGate = new Promise<void>((resolve) => {
		releaseAuthority = resolve;
	});
	let authorityChecks = 0;
	let actions = 0;
	const cleanup = () =>
		withTerminalCleanupLock(state, async () => {
			authorityChecks++;
			await authorityGate;
			actions++;
		});

	const first = cleanup();
	await flushController(() => authorityChecks === 1);
	const second = cleanup();
	assert.equal(await second, false);
	assert.equal(authorityChecks, 1);
	assert.equal(actions, 0);

	releaseAuthority();
	assert.equal(await first, true);
	assert.equal(actions, 1);
	assert.equal(state.terminalCleanupActive, false);
});

test("cleanup retries at 0ms, 2000ms, and 10000ms, then retains final failure", async () => {
	const scheduler = new FakeWatchdogScheduler();
	scheduler.install();
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	let socket: net.Socket | undefined;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true });
		const connected = await connectHello(s, "cleanup-retry-connection");
		socket = connected.socket;
		const actionLog = join(s.agentDirectory, "cleanup-retry-actions");
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nif [ "$4" = close-pane ]; then printf 'close-pane\\n' >> ${JSON.stringify(actionLog)}; printf 'close failed\\n' >&2; exit 9; fi\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		await advanceWatchdog(scheduler);
		await advanceWatchdog(scheduler);
		await flushController(() => connected.frames.some((frame) => frame.type === "ping"));
		await advanceWatchdog(scheduler);
		await advanceWatchdog(scheduler);
		scheduler.advanceBy(5_000);
		await flushController(async () => {
			const status = await requireTool(s!.tools, "subagent_status").execute("x", {
				id: s!.childId,
			});
			const actions = await readFile(actionLog, "utf8").catch(() => "");
			return (
				status.details.terminalCleanup?.status === "pending" &&
				status.details.terminalCleanup?.attempts === 1 &&
				String(status.details.terminalCleanup?.lastError).includes("close failed") &&
				actions.trim().split("\n").length === 1 &&
				scheduler.scheduledDelays.length === 1 &&
				scheduler.scheduledDelays[0] === 2_000
			);
		});

		scheduler.advanceBy(1_999);
		assert.equal((await readFile(actionLog, "utf8")).trim().split("\n").length, 1);
		scheduler.advanceBy(1);
		await flushController(async () => {
			const status = await requireTool(s!.tools, "subagent_status").execute("x", {
				id: s!.childId,
			});
			return (
				status.details.terminalCleanup?.status === "pending" &&
				status.details.terminalCleanup?.attempts === 2 &&
				(await readFile(actionLog, "utf8")).trim().split("\n").length === 2 &&
				scheduler.scheduledDelays.length === 1 &&
				scheduler.scheduledDelays[0] === 5_000
			);
		});

		scheduler.advanceBy(9_999);
		assert.equal((await readFile(actionLog, "utf8")).trim().split("\n").length, 2);
		scheduler.advanceBy(1);
		await flushController(async () => {
			const status = await requireTool(s!.tools, "subagent_status").execute("x", {
				id: s!.childId,
			});
			const entries = JSON.parse(
				await readFile(s!.registryPath, "utf8"),
			) as Record<string, unknown>[];
			return (
				status.details.terminalCleanup?.status === "failed" &&
				status.details.terminalCleanup?.attempts === 3 &&
				entries[0]?.terminalCleanupPending === true &&
				String(entries[0]?.terminalCleanupError).includes("close failed") &&
				scheduler.pendingTimers === 0
			);
		});
		const final = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		assert.equal(final.details.processState, "stopped");
		assert.equal(final.details.terminalCleanup?.status, "failed");
		assert.equal(final.details.terminalCleanup?.attempts, 3);
		assert.match(String(final.details.terminalCleanup?.lastError), /close failed/);
		assert.match(String(final.details.error), /close failed/);
		assert.equal((await readFile(actionLog, "utf8")).trim().split("\n").length, 3);
		assert.doesNotMatch(await readFile(actionLog, "utf8"), /list-panes/);
	} finally {
		socket?.destroy();
		if (s) await s.cleanup();
		scheduler.restore();
	}
});

test("explicit kill closes the stable pane after a failed cooperative interrupt", async () => {
	const scheduler = new FakeWatchdogScheduler();
	scheduler.install();
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true });
		const actionLog = join(s.agentDirectory, "explicit-kill-actions");
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(actionLog)}\nif [ "$4" = send-keys ]; then printf 'interrupt failed\\n' >&2; exit 8; fi\nif [ "$4" = close-pane ]; then exit 0; fi\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		let result: TestResult | undefined;
		const killing = requireTool(s.tools, "subagent_kill")
			.execute("x", { id: s.childId })
			.then((value) => {
				result = value;
			});
		await flushController(async () => {
			const actions = await readFile(actionLog, "utf8").catch(() => "");
			return (
				actions.includes("send-keys") &&
				scheduler.scheduledDelays.length === 2 &&
				scheduler.scheduledDelays[0] === 1_500 &&
				scheduler.scheduledDelays[1] === 5_000
			);
		});
		scheduler.advanceBy(1_500);
		await flushController(() => result !== undefined);
		await killing;
		assert.equal(result?.details.terminated, true);
		assert.equal(
			(result?.details.handle as { terminalCleanup?: { status?: string } })
				.terminalCleanup?.status,
			"complete",
		);
		const actions = await readFile(actionLog, "utf8");
		assert.match(actions, /send-keys/);
		assert.match(actions, /close-pane/);
		assert.match(actions, /terminal_2/);
		assert.doesNotMatch(actions, /list-panes/);
	} finally {
		if (s) await s.cleanup();
		scheduler.restore();
	}
});

test("failed terminal-state persistence prevents cleanup until a durable retry", async () => {
	const scheduler = new FakeWatchdogScheduler();
	scheduler.install();
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	const originalRename = nodeFs.rename.bind(nodeFs);
	let rejectTerminalWrites = true;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true });
		const actionLog = join(s.agentDirectory, "failed-terminal-persistence-actions");
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(actionLog)}\nif [ "$4" = send-keys ] || [ "$4" = close-pane ]; then exit 0; fi\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		nodeFs.rename = (async (from: string, to: string) => {
			if (rejectTerminalWrites && to === s?.registryPath) {
				const entries = JSON.parse(await readFile(from, "utf8")) as Record<
					string,
					unknown
				>[];
				const entry = entries.find((candidate) => candidate.childId === s?.childId);
				if (
					entry?.processState === "stopped" &&
					entry.terminalCleanupPending === true
				)
					throw new Error("terminal registry unavailable");
			}
			return originalRename(from, to);
		}) as typeof nodeFs.rename;

		const killing = requireTool(s.tools, "subagent_kill").execute("x", {
			id: s.childId,
		});
		await flushController(() =>
			readFile(actionLog, "utf8").then(
				(actions) =>
					actions.includes("send-keys") &&
					scheduler.scheduledDelays.includes(1_500),
				() => false,
			),
		);
		scheduler.advanceBy(1_500);
		const result = await killing;
		const pending = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		assert.equal(result.details.terminated, true);
		assert.equal(pending.details.terminalCleanup?.status, "pending");
		assert.doesNotMatch(
			await readFile(actionLog, "utf8"),
			/close-pane/,
			"cleanup started after terminal-state persistence failed",
		);
		assert.ok(
			(pending.details.diagnostics as string[]).some((message) =>
				message.includes("terminal registry unavailable"),
			),
		);

		rejectTerminalWrites = false;
		scheduler.advanceBy(5_000);
		await flushController(async () => {
			const status = await requireTool(s!.tools, "subagent_status").execute("x", {
				id: s!.childId,
			});
			return (
				status.details.terminalCleanup?.status === "complete" &&
				(await readFile(actionLog, "utf8")).includes("close-pane")
			);
		});
	} finally {
		rejectTerminalWrites = false;
		nodeFs.rename = originalRename;
		scheduler.advanceBy(60_000);
		if (s) await s.cleanup();
		scheduler.restore();
	}
});

test("queued registry writes keep their invocation snapshots before terminal persistence", async () => {
	const scheduler = new FakeWatchdogScheduler();
	scheduler.install();
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	let socket: net.Socket | undefined;
	let killing: Promise<TestResult> | undefined;
	const originalRename = nodeFs.rename.bind(nodeFs);
	let releaseFirstWrite!: () => void;
	const firstWriteGate = new Promise<void>((resolve) => {
		releaseFirstWrite = resolve;
	});
	let firstWriteBlocked = false;
	let terminalStateWrites = 0;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true });
		const connected = await connectHello(s, "queued-persistence-connection");
		socket = connected.socket;
		for (let turn = 0; turn < 20; turn++)
			await new Promise<void>((resolve) => setImmediate(resolve));
		const actionLog = join(s.agentDirectory, "queued-persistence-actions");
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(actionLog)}\nif [ "$4" = send-keys ] || [ "$4" = close-pane ]; then exit 0; fi\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		nodeFs.rename = (async (from: string, to: string) => {
			if (to === s?.registryPath) {
				const entries = JSON.parse(await readFile(from, "utf8")) as Record<
					string,
					unknown
				>[];
				const entry = entries.find((candidate) => candidate.childId === s?.childId);
				if (
					entry?.processState === "stopped" &&
					entry.terminalCleanupPending === true
				)
					terminalStateWrites++;
				if (!firstWriteBlocked) {
					firstWriteBlocked = true;
					await firstWriteGate;
				}
			}
			return originalRename(from, to);
		}) as typeof nodeFs.rename;

		const snapshot = (assistantTail: string) =>
			makeFrame(
				"snapshot",
				childFrameBase(s!, "queued-persistence-connection"),
				{
					sessionId: "child-session",
					sessionFile: s!.sessionFilePath,
					runState: "idle",
					runId: 0,
					runOutcome: "pending",
					isStreaming: false,
					assistantTail,
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
			);
		socket.write(snapshot("first"));
		await flushController(() => firstWriteBlocked);
		socket.write(snapshot("second"));
		await flushController(() =>
			requireTool(s!.tools, "subagent_status")
				.execute("x", { id: s!.childId })
				.then((status) => status.details.currentAssistantText === "second"),
		);

		killing = requireTool(s.tools, "subagent_kill").execute("x", {
			id: s.childId,
		});
		await flushController(() =>
			readFile(actionLog, "utf8").then(
				(actions) =>
					actions.includes("send-keys") &&
					scheduler.scheduledDelays.includes(1_500),
				() => false,
			),
		);
		scheduler.advanceBy(1_500);
		await flushController(() =>
			requireTool(s!.tools, "subagent_status")
				.execute("x", { id: s!.childId })
				.then((status) => status.details.processState === "stopped"),
		);
		for (let turn = 0; turn < 20; turn++)
			await new Promise<void>((resolve) => setImmediate(resolve));
		releaseFirstWrite();
		const result = await killing;
		assert.equal(result.details.terminated, true);
		assert.equal(terminalStateWrites, 1);
		assert.match(await readFile(actionLog, "utf8"), /close-pane/);
	} finally {
		releaseFirstWrite();
		scheduler.advanceBy(60_000);
		await killing?.catch(() => {});
		nodeFs.rename = originalRename;
		socket?.destroy();
		if (s) await s.cleanup();
		scheduler.restore();
	}
});

test("explicit kill persists terminal cleanup before watchdog cleanup", async () => {
	const scheduler = new FakeWatchdogScheduler();
	scheduler.install();
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	let killing: Promise<TestResult> | undefined;
	const originalRename = nodeFs.rename.bind(nodeFs);
	let releaseFirstWrite!: () => void;
	const firstWriteGate = new Promise<void>((resolve) => {
		releaseFirstWrite = resolve;
	});
	let firstWriteBlocked = false;
	let terminalStateWrites = 0;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true });
		const actionLog = join(s.agentDirectory, "serialized-kill-actions");
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(actionLog)}\nif [ "$4" = send-keys ] || [ "$4" = close-pane ]; then exit 0; fi\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		nodeFs.rename = (async (from: string, to: string) => {
			if (to === s?.registryPath) {
				const entries = JSON.parse(await readFile(from, "utf8")) as Record<
					string,
					unknown
				>[];
				const entry = entries.find((candidate) => candidate.childId === s?.childId);
				if (
					entry?.processState === "stopped" &&
					entry.terminalCleanupPending === true
				)
					terminalStateWrites++;
				if (!firstWriteBlocked) {
					firstWriteBlocked = true;
					await firstWriteGate;
				}
			}
			return originalRename(from, to);
		}) as typeof nodeFs.rename;

		killing = requireTool(s.tools, "subagent_kill").execute("x", {
			id: s.childId,
		});
		await flushController(() =>
			readFile(actionLog, "utf8").then(
				(actions) =>
					actions.includes("send-keys") &&
					scheduler.scheduledDelays.includes(1_500),
				() => false,
			),
		);
		scheduler.advanceBy(1_500);
		await flushController(() => firstWriteBlocked);
		await flushController(() =>
			requireTool(s!.tools, "subagent_status")
				.execute("x", { id: s!.childId })
				.then((result) => result.details.processState === "stopped"),
		);
		scheduler.advanceBy(0);
		for (let turn = 0; turn < 20; turn++)
			await new Promise<void>((resolve) => nativeSetTimeout(resolve, 1));
		assert.doesNotMatch(
			await readFile(actionLog, "utf8"),
			/close-pane/,
			"cleanup started before the terminal state became durable",
		);

		releaseFirstWrite();
		const result = await killing;
		assert.equal(result.details.terminated, true);
		assert.equal(terminalStateWrites, 1);
		assert.match(await readFile(actionLog, "utf8"), /close-pane/);
	} finally {
		releaseFirstWrite();
		scheduler.advanceBy(60_000);
		await killing?.catch(() => {});
		nodeFs.rename = originalRename;
		if (s) await s.cleanup();
		scheduler.restore();
	}
});

test("a clean child quit stops immediately and completes status and wait", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	let socket: net.Socket | undefined;
	try {
		const connected = await connectHello(s, "clean-quit-connection");
		socket = connected.socket;
		const actionLog = join(s.agentDirectory, "clean-quit-actions");
		await writeFile(
			s.zellijScript,
			`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(actionLog)}\nif [ "$4" = close-pane ]; then exit 0; fi\nexit 2\n`,
		);
		await chmod(s.zellijScript, 0o755);
		const waiting = requireTool(s.tools, "subagent_wait").execute("x", {
			id: s.childId,
			timeoutSeconds: 5,
		});
		socket.end(
			makeFrame("bye", childFrameBase(s, "clean-quit-connection"), {
				reason: "quit",
			}),
		);
		await flushController(async () => {
			const status = await requireTool(s.tools, "subagent_status").execute("x", {
				id: s.childId,
			});
			return (
				status.details.ipcLiveness?.deathReason === "quit" &&
				status.details.terminalCleanup?.status === "complete" &&
				(await readFile(actionLog, "utf8").catch(() => "")).includes("terminal_2")
			);
		});
		assert.equal((await waiting).details.outcome, "completed");
		const status = await requireTool(s.tools, "subagent_status").execute("x", {
			id: s.childId,
		});
		assert.equal(status.details.processState, "stopped");
		assert.equal(status.details.ipcLiveness?.deathReason, "quit");
		assert.equal(status.details.terminalCleanup?.status, "complete");
		assert.doesNotMatch(await readFile(actionLog, "utf8"), /list-panes/);
	} finally {
		socket?.destroy();
		await s.cleanup();
	}
});

test("lease-renewal failure clears the dedicated-session footer", async () => {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let renewalCallback: (() => void) | undefined;
	const fakeTimer = { unref() {} } as unknown as NodeJS.Timeout;
	globalThis.setInterval = ((callback: () => void, delay?: number) => {
		if (delay === LEASE_RENEW_INTERVAL_MS && !renewalCallback) {
			renewalCallback = callback;
			return fakeTimer;
		}
		return originalSetInterval(callback, delay);
	}) as typeof setInterval;
	globalThis.clearInterval = ((timer: NodeJS.Timeout) => {
		if (timer !== fakeTimer) originalClearInterval(timer);
	}) as typeof clearInterval;
	let s: Awaited<ReturnType<typeof setupControllerWithChild>> | undefined;
	let lease: string | undefined;
	let originalLease: string | undefined;
	try {
		s = await setupControllerWithChild({ hasSessionFile: true, observeUi: true });
		lease = leasePath(s.agentDirectory, {
			ownerSessionFile: s.ownerSessionFile,
			ownerSessionId: s.ownerSessionId,
		});
		originalLease = await readFile(lease, "utf8");
		await writeFile(
			lease,
			`${JSON.stringify({
				...JSON.parse(originalLease),
				controllerInstanceId: "replacement-controller",
			})}\n`,
		);
		assert.ok(renewalCallback);
		renewalCallback();
		await eventually(() => s!.zellijStatuses.at(-1) === undefined);
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		if (s && lease && originalLease) {
			await writeFile(lease, originalLease);
			await s.handlers.get("session_start")?.({ reason: "reload" }, s.ctx);
			await s.cleanup();
		}
	}
});

test("authority loss denies steering and killing", async () => {
	const s = await setupControllerWithChild({ hasSessionFile: true });
	const key = createHash("sha1")
		.update(s.ownerSessionFile)
		.digest("hex")
		.slice(0, 24);
	const lease = join(
		s.agentDirectory,
		"sessions",
		"subagents",
		"controllers",
		key,
		"lease.json",
	);
	const originalLease = await readFile(lease, "utf8");
	try {
		await writeFile(
			lease,
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
		assert.equal(s.zellijStatuses.at(-1), undefined);
	} finally {
		await s.handlers.get("session_shutdown")?.({ reason: "reload" }, s.ctx);
		await writeFile(lease, originalLease);
		await s.handlers.get("session_start")?.({ reason: "reload" }, s.ctx);
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
