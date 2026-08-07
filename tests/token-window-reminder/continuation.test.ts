import assert from "node:assert/strict";
import test from "node:test";
import tokenWindowReminder from "../../extensions/token-window-reminder.ts";

type Handler = (event: any, ctx: any) => unknown;

type Harness = ReturnType<typeof harness>;

function assistant(callId: string, args: Record<string, unknown> = {}, stopReason = "toolUse") {
	return {
		role: "assistant",
		stopReason,
		timestamp: 123,
		content: [
			{
				type: "toolCall",
				id: callId,
				name: "compaction_handoff",
				arguments: {
					goal: "Keep the test objective",
					work_in_progress: "Write the focused tests",
					next_steps: "Run the focused test script",
					key_context: "The handoff summary must remain in provider context",
					...args,
				},
			},
		],
	};
}

function result(callId: string, isError = false) {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "compaction_handoff",
		isError,
		content: [{ type: "text", text: "Hand-off recorded" }],
	};
}

function harness(branch: any[] = []) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const entries = branch;
	const sends: Array<{ content: unknown; options: unknown }> = [];
	let signal: AbortSignal | undefined;

	const pi: any = {
		on(name: string, handler: Handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendUserMessage(content: unknown, options: unknown) {
			sends.push({ content, options });
		},
	};
	tokenWindowReminder(pi);

	const ctx: any = {
		hasUI: false,
		isIdle: () => false,
		get signal() {
			return signal;
		},
		getContextUsage: () => null,
		sessionManager: {
			getBranch: () => entries,
		},
		ui: {
			notify() {},
		},
	};

	async function emit(name: string, event: any = {}, eventCtx = ctx) {
		let resultValue: unknown;
		for (const handler of handlers.get(name) ?? []) resultValue = await handler(event, eventCtx);
		return resultValue;
	}

	return {
		ctx,
		emit,
		handlers,
		setSignal(value: AbortSignal | undefined) {
			signal = value;
		},
		sends,
		start() {
			return emit("session_start", { reason: "startup" });
		},
		tools,
		entries,
	};
}

async function emitHandoff(h: Harness, callId: string, args: Record<string, unknown> = {}, stopReason = "toolUse") {
	await h.emit("turn_end", {
		message: assistant(callId, args, stopReason),
		toolResults: [result(callId)],
	});
}

test("the schema keeps continue optional and the runtime default queues exactly one message", async () => {
	const h = harness();
	await h.start();
	const tool = h.tools.get("compaction_handoff");
	assert.equal(tool.parameters.properties.continue.type, "boolean");
	assert.equal(tool.parameters.required?.includes("continue") ?? false, false);

	const toolResult = await tool.execute("call-omitted", {
		goal: "goal",
		work_in_progress: "work",
		next_steps: "next",
		key_context: "context",
	});
	assert.equal(toolResult.terminate, true);

	await emitHandoff(h, "call-omitted");
	assert.deepEqual(h.sends, [{ content: "continue", options: { deliverAs: "followUp" } }]);
	await emitHandoff(h, "call-omitted");
	assert.equal(h.sends.length, 1);
});

test("continue true queues the same exact message once", async () => {
	const h = harness();
	await h.start();
	await emitHandoff(h, "call-true", { continue: true });
	assert.deepEqual(h.sends, [{ content: "continue", options: { deliverAs: "followUp" } }]);
});

test("continue false keeps the virtual reset but leaves Pi idle", async () => {
	const h = harness();
	await h.start();
	const toolResult = await h.tools.get("compaction_handoff").execute("call-false", {
		goal: "goal",
		work_in_progress: "work",
		next_steps: "next",
		key_context: "context",
		continue: false,
	});
	assert.equal(toolResult.terminate, true);

	await emitHandoff(h, "call-false", { continue: false });
	assert.equal(h.sends.length, 0);

	const contextResult = await h.emit("context", {
		messages: [assistant("call-false", { continue: false }), result("call-false")],
	});
	assert.equal(contextResult.messages[0].role, "custom");
	assert.match(contextResult.messages[0].content, /Keep the test objective/);
	assert.equal(contextResult.messages.length, 1);
});

test("failure and abort never queue continuation", async (t) => {
	await t.test("failed tool result", async () => {
		const h = harness();
		await h.start();
		await h.emit("turn_end", {
			message: assistant("call-failure"),
			toolResults: [result("call-failure", true)],
		});
		assert.equal(h.sends.length, 0);
		assert.equal(await h.emit("context", { messages: [assistant("call-failure"), result("call-failure", true)] }), undefined);
	});

	await t.test("failed assistant response", async () => {
		const h = harness();
		await h.start();
		await emitHandoff(h, "call-error", {}, "error");
		assert.equal(h.sends.length, 0);
	});

	await t.test("aborted turn", async () => {
		const h = harness();
		await h.start();
		const controller = new AbortController();
		controller.abort();
		h.setSignal(controller.signal);
		await emitHandoff(h, "call-aborted", {}, "aborted");
		assert.equal(h.sends.length, 0);
	});
});

test("duplicate lifecycle events do not replay a processed handoff", async () => {
	const h = harness();
	await h.start();
	await emitHandoff(h, "call-duplicate");
	await emitHandoff(h, "call-duplicate");
	assert.equal(h.sends.length, 1);
});

test("session restoration and lifecycle reset do not replay history", async () => {
	const restoredAssistant = assistant("call-restored");
	const h = harness([
		{ type: "message", message: restoredAssistant },
		{ type: "message", message: result("call-restored") },
	]);
	await h.start();
	await emitHandoff(h, "call-restored");
	assert.equal(h.sends.length, 0);

	await h.emit("session_tree", {});
	await emitHandoff(h, "call-restored");
	assert.equal(h.sends.length, 0);

	h.entries.length = 0;
	await h.emit("session_tree", {});
	await emitHandoff(h, "call-new-lifecycle");
	assert.equal(h.sends.length, 1);

	await h.emit("session_shutdown", {});
	await emitHandoff(h, "call-after-shutdown");
	assert.equal(h.sends.length, 1);
});

test("the transformed next context contains the handoff summary before the continue message", async () => {
	const h = harness();
	await h.start();
	const contextResult = await h.emit("context", {
		messages: [
			{ role: "user", content: "old work" },
			assistant("call-context", { continue: true }),
			result("call-context"),
			{ role: "user", content: "continue" },
		],
	});

	assert.equal(contextResult.messages.length, 2);
	assert.equal(contextResult.messages[0].role, "custom");
	assert.match(contextResult.messages[0].content, /## Goal/);
	assert.match(contextResult.messages[0].content, /Keep the test objective/);
	assert.deepEqual(contextResult.messages[1], { role: "user", content: "continue" });
});
