import assert from "node:assert/strict";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Check } from "@sinclair/typebox/value";
import subagentExtension from "./index.ts";
import { leasePath, ownerRegistryPath } from "./owner.ts";

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
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, "{\\"type\\":\\"session\\"}\\n");
}
let run = Number.parseInt(process.env.PI_SUBAGENT_RUN_ID_BASE || "0", 10) || 0;
let activeAbortRun;
let buffer = "";
function output(record) { process.stdout.write(JSON.stringify(record) + "\\n"); }
function respond(command, data) {
  output({ type: "response", id: command.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) });
}
function turn(message) {
  run += 1;
  const runId = run;
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
}
function command(command) {
  if (command.type === "get_state") {
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
	"subagent_status",
	"subagent_steer",
	"subagent_follow_up",
	"subagent_interrupt",
	"subagent_kill",
	"subagent_resume",
];

test("the extension registers all eight tools and three commands", () => {
	const commands: string[] = [];
	const { tools } = setup(new Map(), [], commands);
	assert.deepEqual([...tools.keys()], toolNames);
	assert.deepEqual(commands, ["subagents", "subagents-toggle", "subagents-kill-all"]);
	const start = requireTool(tools, "subagent_start").parameters as {
		properties: {
			task: { minLength?: number };
			model: { minLength?: number };
			thinking: unknown;
			outputPath: { minLength?: number };
		};
		required?: string[];
	};
	assert.equal(start.properties.task.minLength, 1);
	assert.equal(start.properties.model.minLength, 1);
	assert.equal(start.properties.outputPath.minLength, 1);
	assert.deepEqual(new Set(start.required), new Set(["task", "model", "thinking"]));
});

test("tool schemas accept valid values and reject invalid values", () => {
	const { tools } = setup();
	const cases: [string, unknown, unknown][] = [
		[
			"subagent_start",
			{ task: "work", model: "provider/model", thinking: "high", outputPath: "out.txt" },
			{ task: "work", model: "provider/model", thinking: "high", outputPath: "" },
		],
		["subagent_list", {}, { includeFinished: "yes" }],
		["subagent_status", { id: "child", messageOffset: 0, numMessages: 20 }, { id: "child", numMessages: 21 }],
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

test("RPC child lifecycle supports settlement wakes, output collisions, transcript paging, reload, and resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-tools-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	const outputPath = join(directory, "deliverable.txt");
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
		const started = await requireTool(tools, "subagent_start").execute(
			"start-request",
			{
				task: "initial",
				model: "provider/model",
				thinking: "off",
				name: "worker",
				outputPath: "deliverable.txt",
			},
			undefined,
			undefined,
			ctx,
		);
		const childId = String(started.details.handle.id);
		assert.match(started.content[0]?.text || "", /RPC child process/);
		assert.equal(started.details.handle.processState, "alive");
		assert.equal(started.details.handle.runId, 1);
		assert.equal(started.details.handle.runState, "idle");
		assert.equal(started.details.handle.runOutcome, "succeeded");
		assert.equal(started.details.handle.settlement.status, "settled");
		assert.equal(started.details.handle.output.path, outputPath);
		assert.equal(started.details.handle.rpcReady, true);

		await waitFor(async () => {
			const status = await requireTool(tools, "subagent_status").execute("status", { id: childId });
			return status.details.output.status === "written";
		});
		assert.equal(await readFile(outputPath, "utf8"), "result-1 initial");

		const status = await requireTool(tools, "subagent_status").execute("status", {
			id: childId,
			messageOffset: 0,
			numMessages: 2,
		});
		assert.equal(status.details.processState, "alive");
		assert.equal(status.details.rpcReady, true);
		assert.equal(status.details.transcript.status, "available");
		assert.equal(status.details.transcript.nextMessageOffset, 0);
		const sessionPath = String(status.details.sessionPath);
		await appendFile(
			sessionPath,
			`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n` +
			`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "world" }] } })}\n` +
			`${JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "hidden" }] } })}\n`,
		);
		const page = await requireTool(tools, "subagent_status").execute("page", {
			id: childId,
			messageOffset: 0,
			numMessages: 2,
		});
		assert.deepEqual(page.details.transcript.messages.map((message: any) => message.text), ["hello", "world"]);
		assert.equal(page.details.transcript.nextMessageOffset, 2);

		await waitFor(() => sent.length >= 1);
		const firstNotification = sent[0];
		assert.equal(firstNotification.message.customType, "subagent-settlement");
		assert.equal(firstNotification.message.content, `Subagent ${childId} reached idle after run 1. Check subagent_status with messages=3.`);
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

		const follow = await requireTool(tools, "subagent_follow_up").execute("follow", {
			id: childId,
			message: "second",
		});
		assert.equal(follow.details.accepted, true);
		assert.equal(follow.details.command, "prompt");
		assert.equal(follow.details.handle.runId, 2);
		await waitFor(() => sent.some((message) => message.message.details?.settlements?.some((record: any) => record.runId === 2)));
		await waitFor(async () => {
			const current = await requireTool(tools, "subagent_status").execute("status", { id: childId });
			return current.details.output.status === "collision";
		});
		assert.equal(await readFile(outputPath, "utf8"), "result-1 initial");

		await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
		const reloaded = setup(new Map(), sent);
		shutdownHandlers = reloaded.handlers;
		await reloaded.handlers.get("session_start")?.({ reason: "reload" }, ctx);
		const reloadedList = await requireTool(reloaded.tools, "subagent_list").execute("list-after-reload", {});
		assert.equal(reloadedList.details.handles.length, 1);
		assert.equal(reloadedList.details.handles[0]?.runId, 2);
		assert.equal(reloadedList.details.handles[0]?.output.status, "collision");
		assert.equal(reloadedList.details.handles[0]?.processState, "alive");
		assert.equal(reloadedList.details.handles[0]?.state, "done");
		assert.equal(reloadedList.details.handles[0]?.lifecycle, "idle");

		await requireTool(reloaded.tools, "subagent_kill").execute("kill", { id: childId });
		const resumed = await requireTool(reloaded.tools, "subagent_resume").execute("resume", {
			id: childId,
			task: "resumed",
		});
		assert.match(resumed.content[0]?.text || "", /new RPC process incarnation/);
		assert.equal(resumed.details.handle.processState, "alive");
		assert.equal(resumed.details.handle.runId, 3);
		assert.equal(resumed.details.handle.settlement.status, "settled");
		await requireTool(reloaded.tools, "subagent_kill").execute("kill-again", { id: childId });

		const invocations = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		assert.equal(invocations.length, 2);
		assert.equal(invocations[0]?.includes("--session"), false);
		assert.equal(invocations[1]?.[invocations[1].indexOf("--session") + 1], resumed.details.handle.sessionPath);
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

test("resume does not spawn when registry persistence fails", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-resume-persist-"));
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
	const ctx = context(parentSession, "resume-persist-parent", directory);
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const started = await requireTool(tools, "subagent_start").execute(
			"start",
			{ task: "initial", model: "provider/model", thinking: "off" },
			undefined,
			undefined,
			ctx,
		);
		const childId = String(started.details.handle.id);
		await requireTool(tools, "subagent_kill").execute("kill", { id: childId });
		const registry = ownerRegistryPath(agentDirectory, {
			ownerSessionFile: parentSession,
			ownerSessionId: "resume-persist-parent",
		});
		await rm(registry, { force: true });
		await mkdir(registry);
		const resumed = await requireTool(tools, "subagent_resume").execute("resume", {
			id: childId,
			task: "must not spawn",
		});
		assert.match(resumed.content[0]?.text || "", /Could not persist/);
		assert.equal(resumed.details.handle.processState, "stopped");
		assert.equal(resumed.details.handle.incarnation, started.details.handle.incarnation);
		const invocations = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		assert.equal(invocations.length, 1);
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

test("failed settlement writes caller output and reports a failed run", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-failure-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	const outputPath = join(directory, "failed.txt");
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
			{ task: "fail", model: "provider/model", thinking: "max", outputPath },
			undefined,
			undefined,
			ctx,
		);
		const childId = String(started.details.handle.id);
		await waitFor(async () => {
			const status = await requireTool(tools, "subagent_status").execute("status", { id: childId });
			return status.details.output.status === "written";
		});
		const status = await requireTool(tools, "subagent_status").execute("status", { id: childId });
		assert.equal(status.details.runOutcome, "failed");
		assert.equal(status.details.settlement.status, "settled");
		assert.match(status.details.error, /quota exceeded/);
		assert.equal(await readFile(outputPath, "utf8"), "failed-1 fail");
		await waitFor(() => sent.some((message) => message.message.details?.outcome === "failed"));
		await requireTool(tools, "subagent_kill").execute("kill", { id: childId });
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

test("native assistant abort errors settle as one aborted wake with empty output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-rpc-abort-error-"));
	const agentDirectory = join(directory, "agent");
	const parentSession = join(directory, "parent.jsonl");
	const logPath = join(directory, "invocations.jsonl");
	const outputPath = join(directory, "aborted.txt");
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
				task: "abort",
				model: "provider/model",
				thinking: "high",
				outputPath,
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
			const status = await requireTool(tools, "subagent_status").execute("status", { id: childId });
			return (
				status.details.runOutcome === "aborted" &&
				status.details.settlement.status === "settled" &&
				status.details.output.status === "written"
			);
		});
		const status = await requireTool(tools, "subagent_status").execute("status", { id: childId });
		assert.equal(status.details.processState, "alive");
		assert.equal(status.details.runOutcome, "aborted");
		assert.equal(status.details.settlement.status, "settled");
		assert.equal(status.details.error, undefined);
		assert.equal(status.details.finalError, undefined);
		assert.equal(status.details.tentativeError, undefined);
		assert.equal(status.details.output.path, outputPath);
		assert.equal(status.details.output.status, "written");
		assert.equal(await readFile(outputPath, "utf8"), "");
		await waitFor(() => sent.length >= 1);
		assert.equal(sent.length, 1);
		assert.deepEqual(
			sent.map((message) => message.message.details?.outcome),
			["aborted"],
		);
		assert.equal(sent[0]?.message.customType, "subagent-settlement");
		assert.equal(
			sent[0]?.message.content,
			`Subagent ${childId} reached idle after run 1. Check subagent_status with messages=3.`,
		);
		assert.equal(sent[0]?.message.details?.settlements?.length, 1);
		assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "steer" });
		await requireTool(tools, "subagent_kill").execute("kill", { id: childId });
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

test("process close before settlement records terminal evidence without a success wake", async () => {
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
			{ task: "close", model: "provider/model", thinking: "off" },
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
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(sent.length, 0);
		const status = await requireTool(tools, "subagent_status").execute("status", { id: childId });
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
	const ctx = context(parentSession, "lease-parent", directory);
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
		const owner = {
			ownerSessionFile: parentSession,
			ownerSessionId: "lease-parent",
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
		await waitFor(async () => {
			const status = await requireTool(tools, "subagent_status").execute("status", { id: childId });
			return status.details.processState === "stopped";
		});
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
	for (const name of [
		"subagent_status",
		"subagent_steer",
		"subagent_follow_up",
		"subagent_interrupt",
		"subagent_kill",
		"subagent_resume",
	]) {
		const params =
			name === "subagent_steer" || name === "subagent_follow_up"
				? { id: "missing", message: "x" }
				: { id: "missing" };
		const result = await requireTool(tools, name).execute("unknown", params);
		assert.match(result.content[0]?.text || "", /Unknown/);
	}
});
