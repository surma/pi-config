import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	readFile,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Check } from "@sinclair/typebox/value";
import subagentExtension, {
	attachRuntime,
	MAX_CALLER_TASK_LENGTH,
	MAX_QUEUED_CHILD_OPERATIONS,
	noteRuntimeClose,
	routeRuntimeRecord,
} from "./index.ts";
import { MAX_SUBAGENT_EVENT_QUEUE_RECORDS } from "./dispatch-event.ts";
import { RpcChildTransport, type RpcProcessClose } from "./rpc.js";

// The test process can inherit the delegated-child marker from the parent harness.
delete process.env.PI_SUBAGENT_DEPTH;

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
	message: Record<string, any>;
	options: Record<string, any>;
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
				message: message as Record<string, any>,
				options: options as Record<string, any>,
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

function context(
	sessionFile: string,
	sessionId: string,
	cwd = dirname(sessionFile),
): ExtensionContext {
	return {
		mode: "json",
		cwd,
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

async function fakePi(
	directory: string,
	logPath: string,
	mode = "success",
): Promise<string> {
	const binary = join(directory, "fake-pi.mjs");
	await writeFile(
		binary,
		`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(logPath)};
const mode = ${JSON.stringify(mode)};
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const sessionIndex = args.indexOf("--session");
let sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
const sessionDir = process.env.PI_SUBAGENT_SESSION_DIR;
if (!sessionFile && sessionDir) sessionFile = join(sessionDir, "child-session.jsonl");
if (sessionFile) {
  mkdirSync(join(sessionFile, ".."), { recursive: true });
  if (!existsSync(sessionFile)) {
    const timestamp = new Date().toISOString();
    writeFileSync(sessionFile,
      JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp, cwd: process.cwd() }) + "\\n" +
      JSON.stringify({ type: "model_change", id: "model", parentId: null, timestamp, provider: "provider", modelId: "model" }) + "\\n" +
      JSON.stringify({ type: "thinking_level_change", id: "thinking", parentId: "model", timestamp, thinkingLevel: "off" }) + "\\n");
  }
}
const healthPath = process.env.PI_SUBAGENT_HEALTH_PATH;
if (healthPath && mode !== "extension-error") {
  mkdirSync(join(healthPath, ".."), { recursive: true });
  writeFileSync(healthPath, "pi-subagent-child-extension-ready/v1\\n", { encoding: "utf8", mode: 0o600 });
}
const runCursorPath = sessionDir ? join(sessionDir, "run-cursor.json") : undefined;
let run = 0;
if (runCursorPath && existsSync(runCursorPath)) {
  try {
    const cursor = JSON.parse(readFileSync(runCursorPath, "utf8"));
    if (Number.isSafeInteger(cursor.runCursor) && cursor.runCursor >= 0) run = cursor.runCursor;
  } catch {}
}
function persistRunCursor(runCursor) {
  if (!runCursorPath) return;
  writeFileSync(runCursorPath, JSON.stringify({ runCursor }) + "\\n", { mode: 0o600 });
}
let activeAbortRun;
let buffer = "";
function output(record) { process.stdout.write(JSON.stringify(record) + "\\n"); }
function respond(command, data) {
  output({ type: "response", id: command.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) });
}
function turn(message) {
  run += 1;
  const runId = run;
  persistRunCursor(runId);
  const responseId = "response-" + run;
  output({ type: "agent_start", runId });
  if (mode === "close") {
    process.stderr.write("fake close diagnostic\\n");
    setTimeout(() => process.exit(17), 5);
    return;
  }
  if (mode === "abort" || mode === "abort-error") {
    activeAbortRun = runId;
    return;
  }
  // Settle with no outcome and no stop reason, then die while nominally idle.
  if (mode === "settle-pending-then-die") {
    output({ type: "agent_settled", runId });
    setTimeout(() => process.exit(11), 20);
    return;
  }
  const failure = mode === "failure";
  const text = (failure ? "failed-" : "result-") + run + " " + String(message || "");
  const assistant = {
    role: "assistant",
    provider: "provider",
    model: "model",
    responseId,
    timestamp: 1000 + run,
    content: [{ type: "text", text }],
    stopReason: failure ? "error" : "stop",
    ...(failure ? { errorMessage: "quota exceeded" } : {}),
    usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.01 } },
  };
  output({ type: "tool_execution_start", toolCallId: "tool-" + run, toolName: "read", args: {} });
  output({ type: "tool_execution_update", toolCallId: "tool-" + run, partialResult: { content: [{ type: "text", text: "partial" }] } });
  output({ type: "tool_execution_end", toolCallId: "tool-" + run, result: { content: [{ type: "text", text: "done" }] }, isError: false });
  output({ type: "message_start", message: { role: "assistant", provider: "provider", model: "model", responseId, timestamp: 1000 + run, content: [] } });
  output({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  output({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  output({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } });
  output({ type: "message_end", message: assistant });
  output({ type: "agent_end", runId, messages: [assistant], willRetry: false });
  output({ type: "agent_settled", runId, runOutcome: failure ? "failed" : "succeeded" });
  // The child settles, reaches idle, then dies without the parent asking.
  if (mode === "settle-then-die") setTimeout(() => process.exit(9), 20);
}
function command(command) {
  if (command.type === "get_state") {
    if (mode === "extension-error") {
      output({ type: "extension_error", extensionPath: "child.ts", error: "child extension failed to load" });
    }
    respond(command, { sessionFile, sessionId: "child-session", model: { provider: "provider", id: "model" }, thinkingLevel: "off" });
  } else if (command.type === "prompt") {
    respond(command);
    turn(command.message);
  } else if (command.type === "abort") {
    respond(command);
    if (activeAbortRun !== undefined) {
      const settledRun = activeAbortRun;
      activeAbortRun = undefined;
      if (mode === "abort-error") {
        const responseId = "response-" + settledRun;
        const assistant = {
          role: "assistant",
          provider: "provider",
          model: "model",
          responseId,
          timestamp: 1000 + settledRun,
          content: [],
          stopReason: "error",
          errorMessage: "This operation was aborted",
          usage: { input: 3, output: 0, cacheRead: 1, cacheWrite: 0, cost: { total: 0.01 } },
        };
        setTimeout(() => {
          output({ type: "tool_execution_start", toolCallId: "tool-" + settledRun, toolName: "bash", args: { command: "sleep 60" } });
          output({ type: "tool_execution_update", toolCallId: "tool-" + settledRun, partialResult: { content: [{ type: "text", text: "running" }] } });
          output({ type: "tool_execution_end", toolCallId: "tool-" + settledRun, result: { content: [{ type: "text", text: "Command aborted" }] }, isError: true });
          output({ type: "message_start", message: { role: "assistant", provider: "provider", model: "model", responseId, timestamp: 1000 + settledRun, content: [] } });
          output({ type: "message_end", message: assistant });
          output({ type: "agent_end", runId: settledRun, messages: [assistant], willRetry: false });
          output({ type: "agent_settled", runId: settledRun });
        }, 20);
      } else {
        setTimeout(() => output({ type: "agent_settled", runId: settledRun, runOutcome: "aborted" }), 20);
      }
    }
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

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate()) && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 10));
	if (!(await predicate())) throw new Error("condition timed out");
}

const toolNames = [
	"subagent_start",
	"subagent_list",
	"subagent_inspect",
	"subagent_steer",
	"subagent_interrupt",
	"subagent_remove",
];

function testRuntime(records: Record<string, unknown>[] = []): any {
	const runtime: any = {
		id: "runtime-test",
		incarnation: "incarnation-test",
		queuedRecords: records,
		queueState: { overflowed: false },
		diagnostics: [],
		fenced: false,
		draining: false,
		drainFailures: 0,
		forceCloseCalls: 0,
	};
	runtime.transport = {
		isClosed: false,
		forceClose(close: Record<string, unknown>) {
			this.isClosed = true;
			runtime.forceCloseCalls++;
			noteRuntimeClose(runtime, close as unknown as RpcProcessClose);
		},
	};
	return runtime;
}

test("runtime reload queue preserves critical lifecycle records and fences updates", async () => {
	const runtime = testRuntime();
	assert.equal(routeRuntimeRecord(runtime, { type: "agent_start" }), true);
	assert.equal(routeRuntimeRecord(runtime, { type: "message_start" }), true);
	let rejected = false;
	for (let index = 0; index < MAX_SUBAGENT_EVENT_QUEUE_RECORDS; index++) {
		if (!routeRuntimeRecord(runtime, { type: "message_update", index })) {
			rejected = true;
			break;
		}
	}
	assert.equal(rejected, true);
	assert.equal(runtime.fenced, true);
	assert.equal(runtime.queuedRecords.length <= MAX_SUBAGENT_EVENT_QUEUE_RECORDS, true);
	assert.equal(routeRuntimeRecord(runtime, { type: "message_end" }), true);
	assert.equal(routeRuntimeRecord(runtime, { type: "agent_end" }), true);
	assert.equal(routeRuntimeRecord(runtime, { type: "agent_settled" }), true);
	const expected = runtime.queuedRecords.map((record: Record<string, unknown>) => record.type);
	const seen: unknown[] = [];
	attachRuntime(
		runtime,
		(record) => seen.push(record.type),
		() => {},
	);
	await waitFor(() => seen.length === expected.length);
	await waitFor(() => runtime.forceCloseCalls === 1);
	assert.deepEqual(seen, expected);
	assert.equal(runtime.queuedRecords.length, 0);
	assert.equal(runtime.transport.isClosed, true);
	const seenBeforeFence = seen.length;
	assert.equal(routeRuntimeRecord(runtime, { type: "message_update", index: "late" }), false);
	assert.equal(seen.length, seenBeforeFence);
	assert.equal(
		(runtime.diagnostics as string[]).filter((message) => message.includes("overflow is terminal")).length,
		1,
	);
});

test("a failed runtime drain retains its record and retries in a later turn", async () => {
	const runtime = testRuntime([
		{ type: "first" },
		{ type: "second" },
	]);
	let failFirst = true;
	const seen: string[] = [];
	let closed = 0;
	noteRuntimeClose(runtime, { code: 0, signal: null, osCloseObserved: true, forced: false });
	attachRuntime(
		runtime,
		(record) => {
			if (record.type === "first" && failFirst) {
				failFirst = false;
				throw new Error("transient consumer failure");
			}
			seen.push(String(record.type));
		},
		() => {
			closed++;
		},
	);
	assert.equal(closed, 0);
	await waitFor(() => closed === 1, 500);
	assert.deepEqual(seen, ["second", "first"]);
	assert.equal(runtime.queuedRecords.length, 0);
});

test("runtime close waits for the queued lifecycle drain", async () => {
	const runtime = testRuntime([
		{ type: "agent_start" },
		{ type: "agent_end" },
		{ type: "agent_settled" },
	]);
	const seen: string[] = [];
	let closed = 0;
	attachRuntime(
		runtime,
		(record) => seen.push(String(record.type)),
		() => {
			closed++;
		},
	);
	noteRuntimeClose(runtime, { code: 17, signal: null, osCloseObserved: true, forced: false });
	assert.equal(closed, 0);
	await waitFor(() => closed === 1, 500);
	assert.deepEqual(seen, ["agent_start", "agent_end", "agent_settled"]);
	assert.equal(runtime.queuedRecords.length, 0);
});

test("the extension registers all six tools and three commands", () => {
	const commands: string[] = [];
	const { tools } = setup(new Map(), [], commands);
	assert.deepEqual([...tools.keys()], toolNames);
	assert.deepEqual(commands, ["subagents", "subagents-toggle", "subagents-kill-all"]);
	const start = requireTool(tools, "subagent_start").parameters as {
		properties: {
			prompt: { minLength?: number; maxLength?: number };
			model: { minLength?: number };
			thinking: unknown;
		};
		required?: string[];
	};
	assert.equal(start.properties.prompt.minLength, 1);
	assert.equal(start.properties.prompt.maxLength, MAX_CALLER_TASK_LENGTH);
	assert.equal(start.properties.model.minLength, 1);
	assert.deepEqual(new Set(start.required), new Set(["prompt", "model", "thinking"]));
	const inspect = requireTool(tools, "subagent_inspect").parameters as {
		properties: { n?: { maximum?: number; default?: number } };
	};
	assert.equal(inspect.properties.n?.default, 1);
	assert.equal(inspect.properties.n?.maximum, 50);
});

test("tool schemas accept valid values and reject invalid values", () => {
	const { tools } = setup();
	const cases: [string, unknown, unknown][] = [
		[
			"subagent_start",
			{ prompt: "work", model: "provider/model", thinking: "high" },
			{ prompt: "", model: "provider/model", thinking: "high" },
		],
		["subagent_list", {}, { includeFinished: true }],
		["subagent_inspect", { id: "child", n: 20 }, { id: "child", n: 51 }],
		["subagent_steer", { id: "child", message: "guidance" }, { id: "child", message: "" }],
		["subagent_interrupt", { id: "child" }, {}],
		["subagent_remove", { id: "child" }, {}],
	];
	for (const [name, valid, invalid] of cases) {
		const schema = requireTool(tools, name).parameters as TSchema;
		assert.equal(Check(schema, valid), true, `${name} valid`);
		assert.equal(Check(schema, invalid), false, `${name} invalid`);
	}
	const longTask = "x".repeat(MAX_CALLER_TASK_LENGTH + 1);
	assert.equal(
		Check(requireTool(tools, "subagent_start").parameters as TSchema, {
			prompt: longTask,
			model: "provider/model",
			thinking: "off",
		}),
		false,
	);
});

test("nested children cannot start another delegated child", async () => {
	const previous = process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "1";
	try {
		const { tools } = setup();
		const result = await requireTool(tools, "subagent_start").execute(
			"request",
			{ prompt: "work", model: "provider/model", thinking: "high" },
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

test("aborted tool calls reject without a normal result", async () => {
	const { tools } = setup();
	const signal = AbortSignal.abort(new Error("caller canceled"));
	await assert.rejects(
		requireTool(tools, "subagent_inspect").execute(
			"aborted",
			{ id: "missing" },
			signal,
		),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
});

test("parent signals reach RPC transport requests", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-signal-forwarding-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\\n");
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
	const ctx = context(parentSession, "signal-forwarding-parent", directory);
	const prototype = RpcChildTransport.prototype as unknown as {
		send: (...args: any[]) => Promise<unknown>;
	};
	const originalSend = prototype.send;
	let observedSignal: AbortSignal | undefined;
	prototype.send = function (...args: any[]): Promise<unknown> {
		observedSignal = args[2] as AbortSignal | undefined;
		return originalSend.apply(this, args);
	};
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start",
			{ prompt: "initial", model: "provider/model", thinking: "off" },
			undefined,
			undefined,
			ctx,
		);
		const signal = new AbortController().signal;
		await requireTool(tools, "subagent_steer").execute(
			"follow-up",
			{ id: started.details.handle.id, message: "next" },
			signal,
			undefined,
			ctx,
		);
		assert.equal(observedSignal, signal);
	} finally {
		prototype.send = originalSend;
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		if (old.agentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDirectory;
		if (old.pi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = old.pi;
		if (old.depth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = old.depth;
	}
});

test("a canceled queue waiter cannot overlap a live predecessor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-queue-fence-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\\n");
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
	const ctx = context(parentSession, "queue-fence-parent", directory);
	const prototype = RpcChildTransport.prototype as unknown as {
		send: (...args: any[]) => Promise<unknown>;
	};
	const originalSend = prototype.send;
	let delayFirstPrompt = false;
	const promptCalls: unknown[] = [];
	prototype.send = function (...args: any[]): Promise<unknown> {
		const body = args[0] as Record<string, unknown>;
		if (body.type === "prompt") {
			promptCalls.push(body);
			if (delayFirstPrompt) {
				delayFirstPrompt = false;
				return new Promise((resolve, reject) => {
					setTimeout(() => {
						void originalSend.apply(this, args).then(resolve, reject);
					}, 150);
				});
			}
		}
		return originalSend.apply(this, args);
	};
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start",
			{ prompt: "initial", model: "provider/model", thinking: "off" },
			undefined,
			undefined,
			ctx,
		);
		const childId = started.details.handle.id;
		promptCalls.length = 0;
		delayFirstPrompt = true;
		const first = requireTool(tools, "subagent_steer").execute(
			"first",
			{ id: childId, message: "first" },
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const controller = new AbortController();
		const canceled = requireTool(tools, "subagent_steer").execute(
			"canceled",
			{ id: childId, message: "canceled" },
			controller.signal,
		);
		const successor = requireTool(tools, "subagent_steer").execute(
			"successor",
			{ id: childId, message: "successor" },
		);
		setTimeout(() => controller.abort(new Error("caller canceled")), 25);
		await assert.rejects(
			canceled,
			(error: unknown) => error instanceof Error && error.name === "AbortError",
		);
		assert.equal(promptCalls.length, 1);
		await Promise.all([first, successor]);
		assert.equal(promptCalls.length, 2);
		await requireTool(tools, "subagent_remove").execute("kill", { id: childId });
	} finally {
		prototype.send = originalSend;
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		if (old.agentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDirectory;
		if (old.pi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = old.pi;
		if (old.depth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = old.depth;
	}
});

test("same-child operation queues reject work beyond the finite bound", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-operation-limit-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\\n");
	const binary = await fakePi(directory, logPath, "queue-message");
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
	const ctx = context(parentSession, "operation-limit-parent", directory);
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start",
			{ prompt: "initial", model: "provider/model", thinking: "off" },
			undefined,
			undefined,
			ctx,
		);
		const childId = String(started.details.handle.id);
		const controllers = Array.from(
			{ length: MAX_QUEUED_CHILD_OPERATIONS + 2 },
			() => new AbortController(),
		);
		let settled = 0;
		let rejectedByLimit = 0;
		const operations = controllers.map((controller, index) =>
			requireTool(tools, "subagent_steer")
				.execute(
					`operation-${index}`,
					{ id: childId, message: `operation-${index}` },
					controller.signal,
				)
				.then(
					(result) => {
						settled++;
						if (result.details.accepted === false) rejectedByLimit++;
					},
					() => {
						settled++;
					},
				),
		);
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.ok(rejectedByLimit > 0, "the operation queue accepted unlimited waiters");
		assert.ok(settled < operations.length, "the live predecessor did not hold queued work");
		for (const controller of controllers) controller.abort(new Error("cancel queued work"));
		await Promise.all(operations);
		await requireTool(tools, "subagent_remove").execute("kill", { id: childId });
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

test("RPC child lifecycle supports settlement wakes, transcript paging, runtime-only reload, and session-only resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-tools-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	const controllerDirectory = join(agentDirectory, "sessions", "subagents", "controllers");
	await writeFile(parentSession, "parent\n");
	const binary = await fakePi(directory, logPath);
	const old = {
		agentDirectory: process.env.PI_CODING_AGENT_DIR,
		pi: process.env.PI_SUBAGENT_PI_BIN,
		depth: process.env.PI_SUBAGENT_DEPTH,
		mode: process.env.FAKE_PI_MODE,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_PI_BIN = binary;
	delete process.env.PI_SUBAGENT_DEPTH;
	process.env.FAKE_PI_MODE = "success";
	const handlers = new Map<string, TestHandler>();
	const sent: SentMessage[] = [];
	const { tools } = setup(handlers, sent);
	const ctx = context(parentSession, "parent-session", directory);
	let shutdownHandlers = handlers;
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		await assert.rejects(
			readdir(controllerDirectory),
			(error: any) => error?.code === "ENOENT",
		);
		const started = await requireTool(tools, "subagent_start").execute(
			"start-request",
			{
				prompt: "initial",
				model: "provider/model",
				thinking: "off",
				name: "worker",
			},
			undefined,
			undefined,
			ctx,
		);
		const childId = String(started.details.handle.id);
		assert.match(started.content[0]?.text || "", /You will be notified when it stops/);
		assert.equal(started.details.handle.processState, "alive");
		assert.equal(started.details.handle.runId, 1);
		assert.equal(started.details.handle.runState, "idle");
		assert.equal(started.details.handle.runOutcome, "succeeded");
		assert.equal(started.details.handle.settlement.status, "settled");
		assert.equal(started.details.handle.rpcReady, true);

		const status = await requireTool(tools, "subagent_inspect").execute("status", {
			id: childId,
			n: 2,
		});
		assert.equal(status.details.processState, "alive");
		assert.equal(status.details.rpcReady, true);
		assert.equal(status.details.transcript.status, "available");
		const sessionPath = String(status.details.sessionPath);
		await appendFile(
			sessionPath,
			`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n` +
			`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "world" }] } })}\n` +
			`${JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "hidden" }] } })}\n`,
		);
		const page = await requireTool(tools, "subagent_inspect").execute("page", {
			id: childId,
			n: 2,
		});
		assert.deepEqual(page.details.transcript.messages.map((message: any) => message.text), ["hello", "world"]);
		assert.equal(page.details.transcript.messagesInWindow, 2);
		assert.match(page.content[0]?.text || "", /Last 2 messages/);
		assert.match(page.content[0]?.text || "", /\] assistant\nworld/);
		assert.match(page.content[0]?.text || "", new RegExp(`log ${sessionPath}`));

		await waitFor(() => sent.length >= 1);
		const firstNotification = sent[0];
		assert.equal(firstNotification.message.customType, "subagent-settlement");
		assert.equal(firstNotification.message.content, `Subagent ${childId} (worker) stopped: it finished its turn. Read its last message with subagent_inspect.`);
		assert.equal(firstNotification.options.triggerTurn, true);
		assert.equal(firstNotification.options.deliverAs, "steer");
		const firstDetails = firstNotification.message.details;
		assert.equal(firstDetails.childId, childId);
		assert.equal(firstDetails.runId, 1);
		assert.equal(firstDetails.outcome, "succeeded");
		assert.deepEqual(firstDetails.settlements.map((record: any) => [record.childId, record.runId]), [[childId, 1]]);

		const listed = await requireTool(tools, "subagent_list").execute("list", {});
		assert.equal(listed.details.handles.length, 1);
		assert.match(listed.content[0]?.text || "", new RegExp(childId));

		const follow = await requireTool(tools, "subagent_steer").execute("follow", {
			id: childId,
			message: "second",
		});
		assert.equal(follow.details.accepted, true);
		assert.equal(follow.details.command, "prompt");
		assert.equal(follow.details.handle.runId, 2);
		await waitFor(() => sent.some((message) => message.message.details?.settlements?.some((record: any) => record.runId === 2)));

		await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
		const reloaded = setup(new Map(), sent);
		shutdownHandlers = reloaded.handlers;
		await reloaded.handlers.get("session_start")?.({ reason: "reload" }, ctx);
		const reloadedList = await requireTool(reloaded.tools, "subagent_list").execute("list-after-reload", {});
		assert.equal(reloadedList.details.handles.length, 1);
		assert.equal(reloadedList.details.handles[0]?.runId, 2);
		assert.equal(reloadedList.details.handles[0]?.processState, "alive");
		assert.equal(reloadedList.details.handles[0]?.state, "done");
		assert.equal(reloadedList.details.handles[0]?.lifecycle, "idle");

		await requireTool(reloaded.tools, "subagent_remove").execute("kill", { id: childId });
		await reloaded.handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
		const afterKillReload = setup(new Map(), sent);
		shutdownHandlers = afterKillReload.handlers;
		await afterKillReload.handlers.get("session_start")?.({ reason: "reload" }, ctx);
		const emptyAfterReload = await requireTool(afterKillReload.tools, "subagent_list").execute("empty-after-reload", {});
		assert.equal(emptyAfterReload.details.handles.length, 0);
		await assert.rejects(
			readdir(controllerDirectory),
			(error: any) => error?.code === "ENOENT",
		);
		const invocations = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		assert.equal(invocations.length, 1);
		assert.equal(invocations[0]?.includes("--session"), false);
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
		if (old.mode === undefined) delete process.env.FAKE_PI_MODE;
		else process.env.FAKE_PI_MODE = old.mode;
	}
});

test("startup ignores stale controller files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-stale-controller-files-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\n");
	const ownerSessionFile = await realpath(parentSession);
	const ownerKey = createHash("sha1").update(ownerSessionFile).digest("hex").slice(0, 24);
	const legacyDirectory = join(agentDirectory, "sessions", "subagents", "controllers", ownerKey);
	await mkdir(legacyDirectory, { recursive: true });
	const now = Date.now();
	await writeFile(
		join(legacyDirectory, "lease.json"),
		`${JSON.stringify({
			ownerSessionFile,
			ownerSessionId: "stale-controller-owner",
			controllerInstanceId: "foreign-controller",
			acquiredAt: now,
			expiresAt: now + 60 * 60 * 1_000,
			pid: process.pid,
			renewedAt: now,
		})}\n`,
	);
	await writeFile(join(legacyDirectory, "registry.json"), "[]\n");
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
	const ctx = context(parentSession, "stale-controller-owner", directory);
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start",
			{ prompt: "initial", model: "provider/model", thinking: "off" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(started.details.handle.processState, "alive");
		assert.equal((await requireTool(tools, "subagent_list").execute("list", {})).details.handles.length, 1);
		await requireTool(tools, "subagent_remove").execute("kill", { id: started.details.handle.id });
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

test("failed settlement reports a failed run", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-failure-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\n");
	const binary = await fakePi(directory, logPath, "failure");
	const old = {
		agentDirectory: process.env.PI_CODING_AGENT_DIR,
		pi: process.env.PI_SUBAGENT_PI_BIN,
		mode: process.env.FAKE_PI_MODE,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_PI_BIN = binary;
	process.env.FAKE_PI_MODE = "failure";
	const handlers = new Map<string, TestHandler>();
	const sent: SentMessage[] = [];
	const { tools } = setup(handlers, sent);
	const ctx = context(parentSession, "failure-parent", directory);
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start",
			{ prompt: "fail", model: "provider/model", thinking: "max" },
			undefined,
			undefined,
			ctx,
		);
		const childId = String(started.details.handle.id);
		await waitFor(async () => {
			const status = await requireTool(tools, "subagent_inspect").execute("status", { id: childId });
			return status.details.settlement.status === "settled";
		});
		const status = await requireTool(tools, "subagent_inspect").execute("status", { id: childId });
		assert.equal(status.details.runOutcome, "failed");
		assert.equal(status.details.settlement.status, "settled");
		assert.match(status.details.error, /quota exceeded/);
		await waitFor(() => sent.some((message) => message.message.details?.outcome === "failed"));
		await requireTool(tools, "subagent_remove").execute("kill", { id: childId });
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		if (old.agentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDirectory;
		if (old.pi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = old.pi;
		if (old.mode === undefined) delete process.env.FAKE_PI_MODE;
		else process.env.FAKE_PI_MODE = old.mode;
	}
});

test("native assistant abort errors settle as one aborted wake", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-abort-error-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\n");
	const binary = await fakePi(directory, logPath, "abort-error");
	const old = {
		agentDirectory: process.env.PI_CODING_AGENT_DIR,
		pi: process.env.PI_SUBAGENT_PI_BIN,
		mode: process.env.FAKE_PI_MODE,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_PI_BIN = binary;
	process.env.FAKE_PI_MODE = "abort";
	const handlers = new Map<string, TestHandler>();
	const sent: SentMessage[] = [];
	const { tools } = setup(handlers, sent);
	const ctx = context(parentSession, "abort-parent", directory);
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start",
			{
				prompt: "abort",
				model: "provider/model",
				thinking: "high",
			},
			undefined,
			undefined,
			ctx,
		);
		const childId = String(started.details.handle.id);
		assert.equal(started.details.handle.runState, "running");
		const interrupted = await requireTool(tools, "subagent_interrupt").execute("interrupt", { id: childId });
		assert.equal(interrupted.details.accepted, true);
		assert.equal(interrupted.details.interrupted, true);
		assert.equal(interrupted.details.handle.processState, "alive");
		assert.equal(interrupted.details.handle.settlement.status, "pending");
		await waitFor(async () => {
			const status = await requireTool(tools, "subagent_inspect").execute("status", { id: childId });
			return (
				status.details.runOutcome === "aborted" &&
				status.details.settlement.status === "settled"
			);
		});
		const status = await requireTool(tools, "subagent_inspect").execute("status", { id: childId });
		assert.equal(status.details.processState, "alive");
		assert.equal(status.details.runOutcome, "aborted");
		assert.equal(status.details.settlement.status, "settled");
		assert.equal(status.details.error, undefined);
		assert.equal(status.details.finalError, undefined);
		assert.equal(status.details.tentativeError, undefined);
		await waitFor(() => sent.length >= 1);
		assert.equal(sent.length, 1);
		assert.deepEqual(
			sent.map((message) => message.message.details?.outcome),
			["aborted"],
		);
		assert.equal(sent[0]?.message.customType, "subagent-settlement");
		assert.equal(
			sent[0]?.message.content,
			`Subagent ${childId} stopped: you interrupted it. Read its last message with subagent_inspect.`,
		);
		assert.equal(sent[0]?.message.details?.settlements?.length, 1);
		assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "steer" });
		await requireTool(tools, "subagent_remove").execute("kill", { id: childId });
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		if (old.agentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDirectory;
		if (old.pi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = old.pi;
		if (old.mode === undefined) delete process.env.FAKE_PI_MODE;
		else process.env.FAKE_PI_MODE = old.mode;
	}
});

test("extension health failure rejects promptly on extension_error without a marker", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-extension-health-error-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\n");
	const binary = await fakePi(directory, logPath, "extension-error");
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
	const ctx = context(parentSession, "extension-health-error-parent", directory);
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const startedAt = Date.now();
		const result = await requireTool(tools, "subagent_start").execute(
			"start",
			{ prompt: "health", model: "provider/model", thinking: "off" },
			undefined,
			undefined,
			ctx,
		);
		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed < 1_000, `health failure took ${elapsed}ms`);
		assert.match(result.content[0]?.text || "", /health confirmation failed/);
		assert.match(result.content[0]?.text || "", /child\.ts: child extension failed to load/);
		const invocations = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		assert.equal(invocations.length, 1);
		assert.equal(invocations[0]?.includes("--mode"), true);
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

test("process close before settlement records terminal evidence and wakes the owner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-close-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\n");
	const binary = await fakePi(directory, logPath, "close");
	const old = {
		agentDirectory: process.env.PI_CODING_AGENT_DIR,
		pi: process.env.PI_SUBAGENT_PI_BIN,
		mode: process.env.FAKE_PI_MODE,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_PI_BIN = binary;
	process.env.FAKE_PI_MODE = "close";
	const handlers = new Map<string, TestHandler>();
	const sent: SentMessage[] = [];
	const { tools } = setup(handlers, sent);
	const ctx = context(parentSession, "close-parent", directory);
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start",
			{ prompt: "close", model: "provider/model", thinking: "off" },
			undefined,
			undefined,
			ctx,
		);
		const childId = String(started.details.handle.id);
		assert.equal(started.details.handle.processState, "stopped");
		assert.equal(started.details.handle.settlement.status, "closed_without_settlement");
		assert.equal(started.details.handle.runOutcome, "pending");
		assert.equal(started.details.handle.exitCode, 17);
		assert.match(started.details.handle.stderrTail, /fake close diagnostic/);
		assert.match(started.details.handle.error, /before agent_settled/);
		await waitFor(() => sent.length >= 1);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.message.details?.eventKind, "process_died");
		assert.equal(sent[0]?.message.details?.outcome, "died");
		assert.match(sent[0]?.message.content || "", /stopped: its process died/);
		assert.match(sent[0]?.message.content || "", /exit 17/);
		assert.match(sent[0]?.message.content || "", /fake close diagnostic/);
		assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "steer" });
		const status = await requireTool(tools, "subagent_inspect").execute("status", { id: childId });
		assert.equal(status.details.settlement.status, "closed_without_settlement");
		assert.equal(status.details.exitCode, 17);
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		if (old.agentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDirectory;
		if (old.pi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = old.pi;
		if (old.mode === undefined) delete process.env.FAKE_PI_MODE;
		else process.env.FAKE_PI_MODE = old.mode;
	}
});

test("an idle child that dies later does not wake the owner a second time", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-settle-die-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\n");
	const binary = await fakePi(directory, logPath, "settle-then-die");
	const old = {
		agentDirectory: process.env.PI_CODING_AGENT_DIR,
		pi: process.env.PI_SUBAGENT_PI_BIN,
		mode: process.env.FAKE_PI_MODE,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_PI_BIN = binary;
	process.env.FAKE_PI_MODE = "settle-then-die";
	const handlers = new Map<string, TestHandler>();
	const sent: SentMessage[] = [];
	const { tools } = setup(handlers, sent);
	const ctx = context(parentSession, "settle-die-parent", directory);
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start",
			{ prompt: "work", model: "provider/model", thinking: "off", name: "worker" },
			undefined,
			undefined,
			ctx,
		);
		const childId = String(started.details.handle.id);
		await waitFor(async () => {
			const status = await requireTool(tools, "subagent_inspect").execute("s", { id: childId });
			return status.details.processState === "stopped";
		});
		await waitFor(() => sent.length >= 1);
		// The settlement already told the owner. The later death adds nothing.
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.message.details?.eventKind, "run_settled");
		assert.equal(sent[0]?.message.details?.outcome, "succeeded");
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		if (old.agentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDirectory;
		if (old.pi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = old.pi;
		if (old.mode === undefined) delete process.env.FAKE_PI_MODE;
		else process.env.FAKE_PI_MODE = old.mode;
	}
});

test("a child that dies after an uncorroborated settlement still wakes the owner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-pending-die-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	await writeFile(parentSession, "parent\n");
	const binary = await fakePi(directory, logPath, "settle-pending-then-die");
	const old = {
		agentDirectory: process.env.PI_CODING_AGENT_DIR,
		pi: process.env.PI_SUBAGENT_PI_BIN,
		mode: process.env.FAKE_PI_MODE,
	};
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_PI_BIN = binary;
	process.env.FAKE_PI_MODE = "settle-pending-then-die";
	const handlers = new Map<string, TestHandler>();
	const sent: SentMessage[] = [];
	const { tools } = setup(handlers, sent);
	const ctx = context(parentSession, "pending-die-parent", directory);
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start",
			{ prompt: "work", model: "provider/model", thinking: "off" },
			undefined,
			undefined,
			ctx,
		);
		const childId = String(started.details.handle.id);
		await waitFor(async () => {
			const status = await requireTool(tools, "subagent_inspect").execute("s", { id: childId });
			return status.details.processState === "stopped";
		});
		// An uncorroborated agent_settled queues no wake, so the death must not stay silent.
		await waitFor(() => sent.length >= 1);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.message.details?.eventKind, "process_died");
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		if (old.agentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDirectory;
		if (old.pi === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = old.pi;
		if (old.mode === undefined) delete process.env.FAKE_PI_MODE;
		else process.env.FAKE_PI_MODE = old.mode;
	}
});

test("unknown handles return stable errors without contacting a child", async () => {
	const { tools } = setup();
	for (const name of [
		"subagent_inspect",
		"subagent_steer",
		"subagent_interrupt",
		"subagent_remove",
	]) {
		const params =
			name === "subagent_steer" ? { id: "missing", message: "x" } : { id: "missing" };
		const result = await requireTool(tools, name).execute("unknown", params);
		assert.match(result.content[0]?.text || "", /Unknown/);
	}
});
