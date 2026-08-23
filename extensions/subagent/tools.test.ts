import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Check } from "@sinclair/typebox/value";
import subagentExtension from "./index.ts";
import { leasePath, ownerRegistryPath } from "./owner.ts";
import { persistRunResult, readRunResult } from "./result-store.ts";

interface TestResult {
	content: { type?: string; text: string }[];
	details: Record<string, any>;
}

interface TestTool {
	name: string;
	description: string;
	parameters: unknown;
	execute(...args: any[]): Promise<TestResult>;
}

type TestHandler = (...args: any[]) => unknown;
interface SentMessage {
	message: Record<string, unknown>;
	options: Record<string, unknown>;
}

function setup(
	handlers = new Map<string, TestHandler>(),
	sentMessages: SentMessage[] = [],
	commands: string[] = [],
): { tools: Map<string, TestTool>; handlers: Map<string, TestHandler> } {
	const tools = new Map<string, TestTool>();
	const api = {
		on: (name: string, handler: TestHandler) => handlers.set(name, handler),
		registerTool: (value: unknown) => {
			const tool = value as TestTool;
			tools.set(tool.name, tool);
		},
		registerCommand: (name: string) => commands.push(name),
		getActiveTools: () => ["read"],
		getThinkingLevel: () => "off",
		sendMessage: (message: unknown, options: unknown) => {
			sentMessages.push({
			message: message as Record<string, unknown>,
			options: options as Record<string, unknown>,
		});
		},
	};
	const marker = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;
	try {
		subagentExtension(api as unknown as ExtensionAPI);
	} finally {
		if (marker === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = marker;
	}
	return { tools, handlers };
}

function requireTool(tools: Map<string, TestTool>, name: string): TestTool {
	const tool = tools.get(name);
	if (!tool) throw new Error(`Missing test tool ${name}.`);
	return tool;
}

function context(sessionFile: string, sessionId: string): ExtensionContext {
	return {
		mode: "json",
		cwd: "/tmp",
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId,
		},
		model: { provider: "provider", id: "model" },
		modelRegistry: {
			getAll: () => [{ provider: "provider", id: "model" }],
			getAvailable: () => [{ provider: "provider", id: "model" }],
		},
	} as unknown as ExtensionContext;
}

async function fakePi(directory: string, logPath: string): Promise<string> {
	const binary = join(directory, "fake-pi.mjs");
	await writeFile(
		binary,
		`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(logPath)};
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const sessionIndex = args.indexOf("--session");
let sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
const sessionDir = process.env.PI_SUBAGENT_SESSION_DIR;
if (!sessionFile && sessionDir) sessionFile = join(sessionDir, "child-session.jsonl");
if (sessionFile) {
  mkdirSync(join(sessionFile, ".."), { recursive: true });
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, "{\\"type\\":\\"session\\"}\\n");
}
let run = Number.parseInt(process.env.PI_SUBAGENT_RUN_ID_BASE || "0", 10) || 0;
let buffer = "";
function output(record) { process.stdout.write(JSON.stringify(record) + "\\n"); }
function respond(command, data) {
  output({ type: "response", id: command.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) });
}
function turn(message) {
  run += 1;
  const responseId = "response-" + run;
  const text = "result-" + run + " " + String(message || "");
  const assistant = {
    role: "assistant",
    provider: "provider",
    model: "model",
    responseId,
    timestamp: 1000 + run,
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.01 } },
  };
  output({ type: "agent_start", runId: run });
  output({ type: "tool_execution_start", toolCallId: "tool-" + run, toolName: "read", args: {} });
  output({ type: "tool_execution_update", toolCallId: "tool-" + run, partialResult: { content: [{ type: "text", text: "partial" }] } });
  output({ type: "tool_execution_end", toolCallId: "tool-" + run, result: { content: [{ type: "text", text: "done" }] }, isError: false });
  output({ type: "message_start", message: { role: "assistant", provider: "provider", model: "model", responseId, timestamp: 1000 + run, content: [] } });
  output({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  output({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  output({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } });
  output({ type: "message_end", message: assistant });
  output({ type: "agent_end", messages: [assistant], willRetry: false });
  output({ type: "agent_settled" });
}
function command(command) {
  if (command.type === "get_state") {
    respond(command, { sessionFile, sessionId: "child-session", model: { provider: "provider", id: "model" }, thinkingLevel: "off" });
  } else if (command.type === "prompt") {
    respond(command);
    turn(command.message);
  } else if (command.type === "steer" || command.type === "follow_up" || command.type === "abort") {
    respond(command);
  } else {
    respond(command);
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\\r$/u, "");
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try { command(JSON.parse(line)); } catch (error) { process.stderr.write(String(error) + "\\n"); }
  }
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
	);
	await chmod(binary, 0o755);
	return binary;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 10));
	if (!predicate()) throw new Error("condition timed out");
}

test("the extension registers all nine tools and three commands", () => {
	const commands: string[] = [];
	const { tools } = setup(new Map(), [], commands);
	assert.deepEqual([...tools.keys()], [
		"subagent_start",
		"subagent_list",
		"subagent_status",
		"subagent_result",
		"subagent_steer",
		"subagent_follow_up",
		"subagent_interrupt",
		"subagent_kill",
		"subagent_resume",
	]);
	assert.deepEqual(commands, ["subagents", "subagents-toggle", "subagents-kill-all"]);
	const start = requireTool(tools, "subagent_start").parameters as {
		properties: { task: { minLength?: number }; model: { minLength?: number }; thinking: unknown };
		required?: string[];
	};
	assert.equal(start.properties.task.minLength, 1);
	assert.equal(start.properties.model.minLength, 1);
	assert.deepEqual(new Set(start.required), new Set(["task", "model", "thinking"]));
});

test("tool schemas accept valid values and reject invalid values", () => {
	const { tools } = setup();
	const cases: [string, unknown, unknown][] = [
		["subagent_start", { task: "work", model: "provider/model", thinking: "high" }, { task: "work", model: "provider/model" }],
		["subagent_list", {}, { includeFinished: "yes" }],
		["subagent_status", { id: "child" }, {}],
		["subagent_result", { id: "child", runId: 1 }, { id: "child" }],
		["subagent_steer", { id: "child", message: "guidance" }, { id: "child", message: "" }],
		["subagent_follow_up", { id: "child", message: "next" }, { id: "child", message: "" }],
		["subagent_interrupt", { id: "child" }, {}],
		["subagent_kill", { id: "child" }, {}],
		["subagent_resume", { id: "child" }, {}],
	];
	for (const [name, valid, invalid] of cases) {
		const schema = requireTool(tools, name).parameters as TSchema;
		assert.equal(Check(schema, valid), true, `${name} valid`);
		assert.equal(Check(schema, invalid), false, `${name} invalid`);
	}
});

test("nested children cannot start another delegated child", async () => {
	const previous = process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "1";
	try {
		const { tools } = setup();
		const result = await requireTool(tools, "subagent_start").execute(
			"request",
			{ task: "work", model: "provider/model", thinking: "high" },
			undefined,
			undefined,
			context("/tmp/parent.jsonl", "parent"),
		);
		assert.equal(result.details.nestedDelegationBlocked, true);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previous;
	}
});

test("RPC child lifecycle supports results, notifications, follow-up, kill, and resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-tools-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\n");
	const binary = await fakePi(directory, logPath);
	const old = {
		agentDirectory: process.env.PI_CODING_AGENT_DIR,
		pi: process.env.PI_SUBAGENT_PI_BIN,
		depth: process.env.PI_SUBAGENT_DEPTH,
		log: process.env.RPC_FAKE_LOG,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_PI_BIN = binary;
	delete process.env.PI_SUBAGENT_DEPTH;
	process.env.RPC_FAKE_LOG = logPath;
	const handlers = new Map<string, TestHandler>();
	const sent: SentMessage[] = [];
	const { tools } = setup(handlers, sent);
	const ctx = context(parentSession, "parent-session");
	let childId = "";
	let shutdownHandlers = handlers;
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start-request",
			{ task: "initial", model: "provider/model", thinking: "off", name: "worker" },
			undefined,
			undefined,
			ctx,
		);
		childId = String(started.details.handle.id);
		assert.match(started.content[0]?.text || "", /RPC child process/);
		assert.equal(started.details.handle.processState, "alive");
		assert.equal(started.details.handle.runId, 1);
		assert.equal(started.details.handle.runState, "idle");
		assert.equal(started.details.handle.resultKind, "final");
		assert.equal(started.details.handle.resultPreview, "result-1 initial");
		assert.equal(started.details.handle.rpcReady, true);

		const status = await requireTool(tools, "subagent_status").execute("status", { id: childId });
		assert.equal(status.details.processState, "alive");
		assert.equal(status.details.rpcReady, true);
		const listed = await requireTool(tools, "subagent_list").execute("list", {});
		assert.equal(listed.details.handles.length, 1);
		assert.match(listed.content[0]?.text || "", new RegExp(childId));

		await waitFor(() => sent.length >= 1);
		const firstNotification = sent[0];
		assert.equal(firstNotification.message.customType, "subagent-settlement");
		assert.equal(firstNotification.options.triggerTurn, true);
		const firstSettlement = (firstNotification.message.details as { settlements: { childId: string; runId: number }[] }).settlements;
		assert.deepEqual(firstSettlement.map((record) => [record.childId, record.runId]), [[childId, 1]]);

		const firstResult = await requireTool(tools, "subagent_result").execute("result", { id: childId, runId: 1 });
		assert.equal(firstResult.details.status, "available");
		assert.equal(firstResult.details.outcome, "succeeded");
		assert.equal(firstResult.content[0]?.text, "result-1 initial");

		await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
		const reloaded = setup(new Map(), sent);
		shutdownHandlers = reloaded.handlers;
		await reloaded.handlers.get("session_start")?.({ reason: "reload" }, ctx);
		const reloadedList = await requireTool(reloaded.tools, "subagent_list").execute("list-after-reload", {});
		assert.equal(reloadedList.details.handles.length, 1);
		assert.equal(reloadedList.details.handles[0]?.runId, 1);
		assert.equal(reloadedList.details.handles[0]?.resultPreview, "result-1 initial");
		assert.equal(reloadedList.details.handles[0]?.processState, "alive");

		const steered = await requireTool(reloaded.tools, "subagent_steer").execute("steer-idle", { id: childId, message: "steer-idle" });
		assert.equal(steered.details.accepted, true);
		assert.equal(steered.details.command, "prompt");
		assert.equal(steered.details.handle.runId, 2);
		const secondResult = await requireTool(reloaded.tools, "subagent_result").execute("result", { id: childId, runId: 2 });
		assert.equal(secondResult.content[0]?.text, "result-2 steer-idle");
		await waitFor(() => sent.some((message) => (message.message.details as any)?.settlements?.some((record: any) => record.runId === 2)));

		const follow = await requireTool(reloaded.tools, "subagent_follow_up").execute("follow", { id: childId, message: "follow-up" });
		assert.equal(follow.details.accepted, true);
		assert.equal(follow.details.command, "prompt");
		assert.equal(follow.details.handle.runId, 3);
		const thirdResult = await requireTool(reloaded.tools, "subagent_result").execute("result", { id: childId, runId: 3 });
		assert.equal(thirdResult.content[0]?.text, "result-3 follow-up");
		await waitFor(() => sent.some((message) => (message.message.details as any)?.settlements?.some((record: any) => record.runId === 3)));

		const interrupted = await requireTool(reloaded.tools, "subagent_interrupt").execute("interrupt", { id: childId });
		assert.equal(interrupted.details.interrupted, true);
		const killed = await requireTool(reloaded.tools, "subagent_kill").execute("kill", { id: childId });
		assert.equal(killed.details.terminated, true);
		assert.equal(killed.details.handle.processState, "stopped");

		await persistRunResult(killed.details.handle.sessionDir, {
			runId: 9,
			outcome: "succeeded",
			incarnation: "published-higher-run",
			settledAt: Date.now(),
			result: "published exact run nine",
		});
		const resumed = await requireTool(reloaded.tools, "subagent_resume").execute("resume", { id: childId, task: "resumed" });
		assert.match(resumed.content[0]?.text || "", /new RPC process incarnation/);
		assert.equal(resumed.details.handle.processState, "alive");
		assert.equal(resumed.details.handle.runId, 10);
		assert.equal(resumed.details.handle.resultPreview, "result-10 resumed");
		const resumedResult = await requireTool(reloaded.tools, "subagent_result").execute("result", { id: childId, runId: 10 });
		assert.equal(resumedResult.content[0]?.text, "result-10 resumed");
		const publishedResult = await readRunResult(killed.details.handle.sessionDir, 9);
		assert.equal(publishedResult.status, "available");
		if (publishedResult.status === "available") assert.equal(publishedResult.record.result, "published exact run nine");
		const invocations = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		assert.equal(invocations.length, 2);
		assert.equal(invocations[0]?.includes("--session"), false);
		assert.equal(invocations[1]?.[invocations[1].indexOf("--session") + 1], resumed.details.handle.sessionPath);
		await requireTool(reloaded.tools, "subagent_kill").execute("kill-again", { id: childId });
	} finally {
		try {
			await (shutdownHandlers.get("session_shutdown")?.({ reason: "quit" }, ctx) as Promise<void> | undefined);
		} catch {
			// The test already reports the primary failure.
		}
		if (old.agentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDirectory;
		if (old.pi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = old.pi;
		if (old.depth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = old.depth;
		if (old.log === undefined) delete process.env.RPC_FAKE_LOG;
		else process.env.RPC_FAKE_LOG = old.log;
	}
});

test("lease loss stops local children without rewriting the registry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-lease-loss-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\n");
	const binary = await fakePi(directory, logPath);
	const old = {
		agentDirectory: process.env.PI_CODING_AGENT_DIR,
		pi: process.env.PI_SUBAGENT_PI_BIN,
		depth: process.env.PI_SUBAGENT_DEPTH,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_PI_BIN = binary;
	delete process.env.PI_SUBAGENT_DEPTH;
	const handlers = new Map<string, TestHandler>();
	const { tools } = setup(handlers);
	const ctx = context(parentSession, "parent-session");
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start-request",
			{ task: "initial", model: "provider/model", thinking: "off" },
			undefined,
			undefined,
			ctx,
		);
		const childId = String(started.details.handle.id);
		await requireTool(tools, "subagent_status").execute("status", { id: childId });
		const owner = {
			ownerSessionFile: parentSession,
			ownerSessionId: "parent-session",
		};
		const path = leasePath(agentDirectory, owner);
		const originalLease = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		const registryPath = ownerRegistryPath(agentDirectory, owner);
		const originalRegistry = await readFile(registryPath, "utf8");
		await writeFile(
			path,
			`${JSON.stringify({ ...originalLease, controllerInstanceId: "replacement-controller" })}\n`,
			{ mode: 0o600 },
		);
		const denied = await requireTool(tools, "subagent_steer").execute("steer", {
			id: childId,
			message: "unsafe",
		});
		assert.match(denied.content[0]?.text || "", /lease is not held/i);
		let stopped = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			const status = await requireTool(tools, "subagent_status").execute("status", { id: childId });
			if (status.details.processState === "stopped") {
				stopped = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(stopped, true);
		const registryInvariants = (raw: string) =>
			(JSON.parse(raw) as Record<string, unknown>[]).map(
				({ lastActivityAt: _lastActivityAt, ...entry }) => entry,
			);
		assert.deepEqual(
			registryInvariants(await readFile(registryPath, "utf8")),
			registryInvariants(originalRegistry),
		);
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		if (old.agentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDirectory;
		if (old.pi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = old.pi;
		if (old.depth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = old.depth;
	}
});

test("unknown handles return stable errors without contacting a child", async () => {
	const { tools } = setup();
	for (const name of ["subagent_status", "subagent_result", "subagent_steer", "subagent_follow_up", "subagent_interrupt", "subagent_kill", "subagent_resume"]) {
		const params = name === "subagent_result" ? { id: "missing", runId: 1 } : name === "subagent_steer" || name === "subagent_follow_up" ? { id: "missing", message: "x" } : { id: "missing" };
		const result = await requireTool(tools, name).execute("unknown", params);
		assert.match(result.content[0]?.text || "", /Unknown/);
	}
});
