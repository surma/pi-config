import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import goalExtension from "../../extensions/goal.ts";

type Handler = (event: any, ctx: any) => unknown;
type Notification = { message: string; level: string };

type Harness = ReturnType<typeof harness>;

function goalBranch(options: {
	cost?: number;
	limit?: number;
	status?: "active" | "paused" | "complete";
} = {}) {
	const id = "goal_test";
	const entries: any[] = [
		{
			type: "custom",
			customType: "goal-set",
			data: { id, objective: "Finish the test objective", tokenBudget: null, createdAt: 1 },
		},
	];
	if (options.status && options.status !== "active") {
		entries.push({
			type: "custom",
			customType: "goal-status",
			data: { id, status: options.status, updatedAt: 2 },
		});
	}
	if (options.limit !== undefined) {
		entries.push({
			type: "custom",
			customType: "goal-cost-limit-set",
			data: { id, costLimitUsd: options.limit, updatedAt: 2 },
		});
	}
	if (options.cost !== undefined) {
		entries.push({
			type: "message",
			message: { role: "assistant", content: [], usage: { cost: { total: options.cost } } },
		});
	}
	return entries;
}

function assistant(toolCalls: number, cost = 0) {
	return {
		role: "assistant",
		content: Array.from({ length: toolCalls }, (_, index) => ({
			type: "toolCall",
			id: `tool-${index}`,
			name: index === 0 ? "compaction_handoff" : "read",
			arguments: {},
		})),
		usage: { cost: { total: cost } },
	};
}

function harness(options: { idle?: boolean; branch?: any[] } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const sends: Array<{ message: any; options: any }> = [];
	const notifications: Notification[] = [];
	const entries: any[] = options.branch ?? goalBranch();
	let idle = options.idle ?? true;
	let signal: AbortSignal | undefined;

	const pi: any = {
		on(name: string, handler: Handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer() {},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(message: any, sendOptions: any) {
			sends.push({ message, options: sendOptions });
			if (sendOptions?.triggerTurn && idle) idle = false;
		},
	};
	goalExtension(pi);

	const ctx: any = {
		mode: "json",
		hasUI: false,
		get signal() {
			return signal;
		},
		isIdle() {
			return idle;
		},
		getContextUsage() {
			throw new Error("goal must not inspect context usage");
		},
		sessionManager: {
			getBranch() {
				return entries;
			},
		},
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setWidget() {},
		},
	};

	async function emit(name: string, event: any = {}, eventCtx = ctx) {
		for (const handler of handlers.get(name) ?? []) await handler(event, eventCtx);
	}

	return {
		commands,
		ctx,
		emit,
		handlers,
		notifications,
		sends,
		setIdle(value: boolean) {
			idle = value;
		},
		setSignal(value: AbortSignal | undefined) {
			signal = value;
		},
		tools,
	};
}

async function startedHarness(options: Parameters<typeof harness>[0] = {}) {
	const result = harness(options);
	await result.emit("session_start", { reason: "startup" });
	return result;
}

async function settle(h: Harness) {
	h.setIdle(true);
	await h.emit("agent_settled");
}

test("agent_end records intent and idle settlement dispatches synchronously", async () => {
	const h = await startedHarness({ idle: false });
	await h.emit("agent_end", { messages: [assistant(1)] });
	assert.equal(h.sends.length, 0);

	h.setIdle(true);
	const settlement = h.emit("agent_settled");
	assert.equal(h.sends.length, 1, "sendMessage must run synchronously in the settlement handler");
	assert.equal(h.ctx.isIdle(), false, "triggerTurn must synchronously start the continuation run");
	assert.equal(h.sends[0]?.message.customType, "goal-continuation");
	assert.deepEqual(h.sends[0]?.options, { triggerTurn: true });
	await settlement;

	await h.emit("agent_settled");
	assert.equal(h.sends.length, 1, "duplicate settlement must not duplicate dispatch");
});

test("a busy settlement retains pending intent for the next settlement", async () => {
	const h = await startedHarness({ idle: false });
	await h.emit("agent_end", { messages: [assistant(1)] });
	await h.emit("agent_settled");
	assert.equal(h.sends.length, 0);

	await settle(h);
	assert.equal(h.sends.length, 1);
});

test("multiple low-level agent_end events retain goal origin and dispatch once", async () => {
	const h = await startedHarness();
	await h.commands.get("goal").handler("resume", h.ctx);
	assert.equal(h.sends.length, 1);

	await h.emit("agent_end", { messages: [assistant(0)] });
	const beforeStart = h.handlers.get("before_agent_start")?.[0];
	assert.equal(
		await beforeStart?.({ systemPrompt: "base" }, h.ctx),
		undefined,
		"goal origin must survive into a low-level retry",
	);
	await h.emit("agent_end", { messages: [assistant(1)] });
	assert.equal(h.sends.length, 1);

	await settle(h);
	assert.equal(h.sends.length, 2);
	await h.emit("agent_settled");
	assert.equal(h.sends.length, 2);
});

test("goal-origin zero-tool anti-spin stops until ordinary input", async () => {
	const h = await startedHarness();
	await h.commands.get("goal").handler("resume", h.ctx);
	await h.emit("agent_end", { messages: [assistant(0)] });
	await settle(h);
	assert.equal(h.sends.length, 1, "zero-tool continuation must not spin");

	await h.emit("input", { source: "interactive", text: "keep going" });
	const beforeStart = h.handlers.get("before_agent_start")?.[0];
	const promptResult = (await beforeStart?.({ systemPrompt: "base" }, h.ctx)) as
		| { systemPrompt?: string }
		| undefined;
	assert.match(promptResult?.systemPrompt ?? "", /Active Thread Goal/);
	await h.emit("agent_end", { messages: [assistant(0)] });
	await settle(h);
	assert.equal(h.sends.length, 2, "ordinary input clears suppression and permits one continuation");
});

test("abort and cost limit prevent settlement dispatch", async (t) => {
	await t.test("abort", async () => {
		const h = await startedHarness({ idle: false });
		const controller = new AbortController();
		controller.abort();
		h.setSignal(controller.signal);
		await h.emit("agent_end", { messages: [assistant(1)] });
		await settle(h);
		assert.equal(h.sends.length, 0);
	});

	await t.test("cost", async () => {
		const h = await startedHarness({ idle: false, branch: goalBranch({ cost: 0.8, limit: 1 }) });
		await h.emit("agent_end", { messages: [assistant(1, 0.2)] });
		await settle(h);
		assert.equal(h.sends.length, 0);
		assert.match(h.notifications.at(-1)?.message ?? "", /Goal cost limit reached/);
	});
});

test("complete, clear, and pause cancel pending continuation", async (t) => {
	await t.test("complete", async () => {
		const h = await startedHarness({ idle: false });
		await h.tools.get("update_goal").execute("id", { status: "complete" });
		await h.emit("agent_end", { messages: [assistant(1)] });
		await settle(h);
		assert.equal(h.sends.length, 0);
	});

	await t.test("clear", async () => {
		const h = await startedHarness({ idle: false });
		await h.tools.get("clear_goal").execute();
		await h.emit("agent_end", { messages: [assistant(1)] });
		await settle(h);
		assert.equal(h.sends.length, 0);
	});

	await t.test("pause", async () => {
		const h = await startedHarness({ idle: false });
		await h.emit("agent_end", { messages: [assistant(1)] });
		await h.commands.get("goal").handler("pause", h.ctx);
		await settle(h);
		assert.equal(h.sends.length, 0);
	});
});

test("create_goal becomes active without dispatching before agent_end", async () => {
	const h = await startedHarness({ idle: false, branch: [] });
	await h.tools.get("create_goal").execute("id", { objective: "Created by tool" });
	assert.equal(h.sends.length, 0);
	await h.emit("agent_end", { messages: [assistant(1)] });
	assert.equal(h.sends.length, 0);
	await settle(h);
	assert.equal(h.sends.length, 1);
});

test("resume feedback distinguishes immediate, deferred, and cost-blocked outcomes", async (t) => {
	await t.test("idle", async () => {
		const h = await startedHarness({ branch: goalBranch({ status: "paused" }) });
		await h.commands.get("goal").handler("resume", h.ctx);
		assert.equal(h.sends.length, 1);
		assert.equal(h.notifications.at(-1)?.message, "Goal continuation started.");
		const result = await h.tools.get("get_goal").execute();
		assert.equal(JSON.parse(result.content[0].text).goal.status, "active");
	});

	await t.test("busy", async () => {
		const h = await startedHarness({ idle: false });
		await h.commands.get("goal").handler("resume", h.ctx);
		assert.equal(h.sends.length, 0);
		assert.equal(h.notifications.at(-1)?.message, "Goal continuation will start when current work settles.");
		await settle(h);
		assert.equal(h.sends.length, 1);
	});

	await t.test("cost blocked", async () => {
		const h = await startedHarness({ branch: goalBranch({ cost: 1, limit: 1 }) });
		await h.commands.get("goal").handler("resume", h.ctx);
		assert.equal(h.sends.length, 0);
		assert.match(h.notifications.at(-1)?.message ?? "", /Goal cost limit reached/);
		assert.equal(h.notifications.some(({ message }) => /started|will start|queued/i.test(message)), false);
	});
});

test("reload, tree navigation, and shutdown clear transient intent", async () => {
	for (const boundary of ["session_start", "session_tree", "session_shutdown"] as const) {
		const h = await startedHarness({ idle: false });
		await h.emit("agent_end", { messages: [assistant(1)] });
		await h.emit(boundary, boundary === "session_start" ? { reason: "reload" } : {});
		await settle(h);
		assert.equal(h.sends.length, 0, boundary);
	}
});

test("productive virtual handoff never inspects context usage", async () => {
	const h = await startedHarness({ idle: false });
	await h.emit("agent_end", { messages: [assistant(1)] });
	await settle(h);
	assert.equal(h.sends.length, 1);
});

test("goal source has no compaction observation, usage gate, or continuation timer", () => {
	const source = readFileSync(new URL("../../extensions/goal.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /compaction-settings|getContextUsage|session_compact/);
	assert.doesNotMatch(source, /continuationTimer|setTimeout\s*\(|clearTimeout\s*\(/);
});
