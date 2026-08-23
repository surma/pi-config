import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Check } from "@sinclair/typebox/value";
import subagentExtension from "./index.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface TestResult {
	content: { text: string }[];
	details: Record<string, unknown>;
}

interface TestTool {
	name: string;
	description: string;
	parameters: unknown;
	execute(...args: unknown[]): Promise<TestResult>;
	renderResult?: (...args: unknown[]) => { render(width: number): string[] };
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

// ---------------------------------------------------------------------------
// Tests that survive the Zellij-to-RPC migration
// ---------------------------------------------------------------------------
// NOTE: The original tools.test.ts had ~47 tests. ~40 of them tested
// Zellij tab management, IPC socket handshake, heartbeat, terminal cleanup,
// reconnect grace, and dedicated session state. All of those features were
// removed in the RPC migration. The tests below cover tool registration,
// schema validation, prompt guidance, nested-delegation blocking,
// unknown-handle rejection, and result rendering — all of which remain
// relevant in the new subprocess-based model.
//
// TODO: Write RPC-specific integration tests that cover subprocess spawning,
// JSONL stdio event dispatch, terminate escalation, and resume via session
// file reload.
// ---------------------------------------------------------------------------

test("exactly nine public tools are registered", () => {
	const tools = setup();
	assert.deepEqual(
		[...tools.keys()],
		[
			"subagent_start",
			"subagent_list",
			"subagent_status",
			"subagent_result",
			"subagent_steer",
			"subagent_follow_up",
			"subagent_interrupt",
			"subagent_kill",
			"subagent_resume",
		],
	);
	const startParameters = requireTool(tools, "subagent_start").parameters as {
		properties: {
			task: { minLength?: number };
			model: { minLength?: number };
			thinking: unknown;
		};
		required?: string[];
	};
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

test("prompt guidance requires notification-driven completion", async () => {
	const handlers = new Map<string, TestHandler>();
	const tools = setup(handlers);
	const prompt = (await handlers.get("before_agent_start")?.({
		systemPrompt: "base",
	})) as { systemPrompt: string };
	assert.match(prompt.systemPrompt, /notifications arrive automatically/);
	assert.match(prompt.systemPrompt, /subagent_result/);
	assert.match(prompt.systemPrompt, /start a follow-up turn/);
	assert.match(prompt.systemPrompt, /Rely on these notifications for completion/);
	assert.match(prompt.systemPrompt, /Do not poll subagent_status/);
	assert.match(prompt.systemPrompt, /use sleep commands to wait for completion/);
	assert.match(prompt.systemPrompt, /subagent_status only for live diagnostics/);
	assert.match(prompt.systemPrompt, /never as a completion check/);
	assert.doesNotMatch(prompt.systemPrompt, /subagent_wait/);
	assert.match(
		requireTool(tools, "subagent_start").description,
		/Do not poll subagent_status or use sleep commands/,
	);
	assert.match(
		requireTool(tools, "subagent_status").description,
		/Do not poll this tool for completion/,
	);
	assert.match(requireTool(tools, "subagent_result").description, /never falls back/);
});

test("all nine tool schemas accept valid parameters and reject invalid parameters", () => {
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

test("subagent_result previews collapsed output and expands it on demand", () => {
	const renderer = requireTool(setup(), "subagent_result").renderResult;
	assert.ok(renderer);
	const result = {
		content: [
			{
				type: "text",
				text: ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"].join("\n"),
			},
		],
	};
	const theme = { fg: (_color: string, text: string) => text };

	const collapsed = renderer(result, { expanded: false }, theme, {});
	assert.equal(
		collapsed.render(120).map((line: string) => line.trimEnd()).join("\n"),
		"line 1\nline 2\nline 3\nline 4\nline 5\n...",
	);

	const expanded = renderer(result, { expanded: true }, theme, {});
	assert.equal(
		expanded.render(120).map((line: string) => line.trimEnd()).join("\n"),
		"line 1\nline 2\nline 3\nline 4\nline 5\nline 6",
	);
});
