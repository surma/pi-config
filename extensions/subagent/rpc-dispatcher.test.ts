import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import childSubagentExtension from "./child.ts";
import { createLifecycleState, requestKill } from "./lifecycle.ts";
import {
	attachSubagentRpcProcess,
	dispatchSubagentRpcEvent,
	type RpcDispatchHandle,
	type RpcDispatchOptions,
} from "./rpc-dispatcher.ts";

function assistant(timestamp: number, text: string, stopReason = "stop", responseId?: string, errorMessage?: string) {
	return {
		role: "assistant",
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		timestamp,
		responseId,
		content: [{ type: "text", text }],
		stopReason,
		errorMessage,
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } },
	};
}

function createHandle(): RpcDispatchHandle {
	return {
		...createLifecycleState(),
		resultText: "",
		currentAssistantText: "",
		latestAssistantText: "",
		assistantMessageGeneration: 0,
		finalizedAssistantIdentities: [],
		assistantTextTruncated: false,
		activeTools: new Map(),
		recentTools: [],
		knownToolCallIds: [],
		isStreaming: false,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		completionSettled: false,
	};
}

function harness(handle = createHandle()) {
	let clock = 0;
	let settled = 0;
	let finalized = 0;
	const diagnostics: string[] = [];
	const refreshes: boolean[] = [];
	const options: RpcDispatchOptions = {
		now: () => ++clock,
		assistantDisplayMax: 1024,
		toolOutputTailMax: 32,
		maxRecentTools: 8,
		update: (streaming = false) => refreshes.push(streaming),
		diagnostic: (message) => diagnostics.push(message),
		onAssistantFinalized: () => finalized++,
		onSettled: () => {
			settled++;
			handle.completionSettled = true;
		},
	};
	return { handle, options, diagnostics, refreshes, get settled() { return settled; }, get finalized() { return finalized; } };
}

function emitMessage(h: ReturnType<typeof harness>, message: ReturnType<typeof assistant>, updateText = message.content[0]!.text) {
	dispatchSubagentRpcEvent(h.handle, { type: "message_start", message: { ...message, content: [] } }, h.options);
	dispatchSubagentRpcEvent(
		h.handle,
		{ type: "message_update", message: { ...message, content: [{ type: "text", text: updateText }] }, assistantMessageEvent: { type: "text_delta" } },
		h.options,
	);
	dispatchSubagentRpcEvent(h.handle, { type: "message_end", message }, h.options);
}

test("production dispatcher handles failed retry, duplicate boundaries, success, and settlement", () => {
	const h = harness();
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options), true);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options), false);
	assert.equal(h.handle.runs.length, 1);

	const failed = assistant(10, "temporary failure", "error", "response-failed", "overloaded");
	emitMessage(h, failed, "temporary");
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_end", messages: [failed], willRetry: true }, h.options), true);
	assert.equal(h.handle.lifecycle, "retrying");
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_end", messages: [failed], willRetry: false }, h.options), false);
	assert.equal(h.handle.lifecycle, "retrying");

	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options), true);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_end", messages: [failed], willRetry: false }, h.options), false);
	assert.equal(h.handle.runs[1]?.phase, "active");
	const succeeded = assistant(11, "short", "stop", "response-success");
	emitMessage(h, succeeded);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_end", messages: [succeeded], willRetry: false }, h.options), true);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_settled" }, h.options), true);

	assert.equal(h.handle.state, "done");
	assert.equal(h.handle.finalError, undefined);
	assert.equal(h.handle.resultText, "short");
	assert.equal(h.handle.latestAssistantText, "short");
	assert.equal(h.handle.usage.turns, 2);
	assert.equal(h.finalized, 2);
	assert.equal(h.settled, 1);
	assert.ok(h.refreshes.includes(true));
	assert.match(h.diagnostics.join("\n"), /duplicate agent_start/);
	assert.match(h.diagnostics.join("\n"), /duplicate or late agent_end/);
	assert.match(h.diagnostics.join("\n"), /does not match the active run/);

	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_end", messages: [failed], willRetry: true }, h.options), false);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_settled" }, h.options), false);
	assert.equal(h.handle.state, "done");
	assert.equal(h.settled, 1);
});

test("production dispatcher preserves final failures and rejects delayed finalized message records", () => {
	const h = harness();
	dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options);
	const failed = assistant(20, "final failure", "error", "response-final", "quota exhausted");
	emitMessage(h, failed, "partial failure");
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "message_update", message: { ...failed, content: [{ type: "text", text: "stale" }] } }, h.options), false);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "message_start", message: failed }, h.options), false);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "message_end", message: { ...failed, content: [{ type: "text", text: "duplicate" }] } }, h.options), false);
	assert.equal(h.handle.currentAssistantText, "final failure");
	assert.equal(h.handle.resultText, "final failure");
	assert.equal(h.handle.usage.turns, 1);

	dispatchSubagentRpcEvent(h.handle, { type: "agent_end", messages: [failed], willRetry: false }, h.options);
	dispatchSubagentRpcEvent(h.handle, { type: "agent_settled" }, h.options);
	assert.equal(h.handle.state, "error");
	assert.equal(h.handle.finalError, "quota exhausted");
	assert.equal(h.settled, 1);
});

test("production dispatcher correlates parallel tool progress and final output", () => {
	const h = harness();
	dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options);
	for (const [toolCallId, toolName] of [["a", "bash"], ["b", "read"]] as const) {
		dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_start", toolCallId, toolName, args: {} }, h.options);
	}
	dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_update", toolCallId: "a", partialResult: { content: [{ type: "text", text: "a-progress" }] } }, h.options);
	dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_update", toolCallId: "b", partialResult: { content: [{ type: "text", text: "b-progress" }] } }, h.options);
	dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_end", toolCallId: "b", result: { content: [{ type: "text", text: "b-done" }] }, isError: false }, h.options);
	dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_end", toolCallId: "a", result: { content: [{ type: "text", text: "a-done" }] }, isError: true }, h.options);
	assert.deepEqual(h.handle.recentTools.map((tool) => [tool.toolCallId, tool.output, tool.isError]), [
		["b", "b-done", false],
		["a", "a-done", true],
	]);
	assert.equal(h.handle.activeTools.size, 0);
	assert.equal(h.handle.currentTool, undefined);
});

test("production dispatcher bounds retained tool-call identity history", () => {
	const h = harness();
	dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options);
	for (let index = 0; index < 300; index++) {
		const toolCallId = `tool-${index}`;
		dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_start", toolCallId, toolName: "read", args: {} }, h.options);
		dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_end", toolCallId, toolName: "read", result: { content: [] }, isError: false }, h.options);
	}
	assert.equal(h.handle.knownToolCallIds.length, 256);
	assert.equal(h.handle.knownToolCallIds[0], "tool-44");
	assert.equal(h.handle.knownToolCallIds.at(-1), "tool-299");
});

class FakeChild extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	pid = 1234;
	kill(): boolean { return true; }
}

test("production JSONL dispatch ignores a stale prior-run tool start after a late post-end start", () => {
	const handle = createHandle();
	const h = harness(handle);
	const child = new FakeChild();
	attachSubagentRpcProcess(handle, child as unknown as ChildProcessWithoutNullStreams, {
		...h.options,
		onResponse: () => assert.fail("unexpected response"),
		appendStderr: () => {},
		signalProcess: () => assert.fail("unexpected forced signal"),
	});
	const succeeded = assistant(29, "preserved tool-run output", "stop", "response-stale-tool");
	child.stdout.write([
		{ type: "agent_start" },
		{ type: "tool_execution_start", toolCallId: "old", toolName: "bash", args: {} },
		{ type: "tool_execution_end", toolCallId: "old", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false },
		{ type: "message_start", message: { ...succeeded, content: [] } },
		{ type: "message_end", message: succeeded },
		{ type: "agent_end", messages: [succeeded], willRetry: false },
		{ type: "agent_start" },
		{ type: "tool_execution_start", toolCallId: "old", toolName: "bash", args: {} },
		{ type: "agent_settled" },
	].map((record) => JSON.stringify(record)).join("\n") + "\n");

	assert.equal(handle.state, "done");
	assert.equal(handle.resultText, "preserved tool-run output");
	assert.equal(handle.runs.length, 1);
	assert.equal(handle.activeTools.size, 0);
	assert.equal(h.settled, 1);
	child.emit("close", 0, null);
	assert.equal(handle.state, "done");
	assert.equal(handle.finalError, undefined);
	assert.equal(h.settled, 1);
	assert.doesNotMatch(h.diagnostics.join("\n"), /Process exited before agent_settled/);
});

test("production JSONL dispatch rejects an older same-timestamp finalized identity after a newer one", () => {
	const handle = createHandle();
	const h = harness(handle);
	const child = new FakeChild();
	attachSubagentRpcProcess(handle, child as unknown as ChildProcessWithoutNullStreams, {
		...h.options,
		onResponse: () => assert.fail("unexpected response"),
		appendStderr: () => {},
		signalProcess: () => assert.fail("unexpected forced signal"),
	});
	const first = assistant(100, "first answer", "stop", "a");
	const second = assistant(100, "second answer", "stop", "b");
	child.stdout.write([
		{ type: "agent_start" },
		{ type: "message_start", message: { ...first, content: [] } },
		{ type: "message_end", message: first },
		{ type: "agent_end", messages: [first], willRetry: false },
		{ type: "agent_start" },
		{ type: "message_start", message: { ...second, content: [] } },
		{ type: "message_end", message: second },
		{ type: "agent_end", messages: [second], willRetry: false },
		{ type: "agent_start" },
		{ type: "message_start", message: { ...first, content: [] } },
		{ type: "agent_settled" },
	].map((record) => JSON.stringify(record)).join("\n") + "\n");

	assert.equal(handle.state, "done");
	assert.equal(handle.resultText, "second answer");
	assert.equal(handle.usage.turns, 2);
	assert.equal(handle.runs.length, 2);
	assert.equal(h.finalized, 2);
	assert.equal(h.settled, 1);
	assert.match(h.diagnostics.join("\n"), /duplicate, delayed, or unidentifiable assistant message_start/);
	assert.doesNotMatch(h.diagnostics.join("\n"), /corroborated current run/);
	child.emit("close", 0, null);
	assert.equal(handle.state, "done");
	assert.equal(handle.finalError, undefined);
	assert.equal(h.settled, 1);
	assert.doesNotMatch(h.diagnostics.join("\n"), /Process exited before agent_settled/);
});

test("production JSONL dispatch settles through a late duplicate post-end start without close fallback", () => {
	const handle = createHandle();
	const h = harness(handle);
	const child = new FakeChild();
	attachSubagentRpcProcess(handle, child as unknown as ChildProcessWithoutNullStreams, {
		...h.options,
		onResponse: () => assert.fail("unexpected response"),
		appendStderr: () => {},
		signalProcess: () => assert.fail("unexpected forced signal"),
	});
	const succeeded = assistant(30, "preserved final output", "stop", "response-late-start");
	child.stdout.write([
		{ type: "agent_start" },
		{ type: "message_start", message: { ...succeeded, content: [] } },
		{ type: "message_end", message: succeeded },
		{ type: "agent_end", messages: [succeeded], willRetry: false },
		{ type: "agent_start" },
		{ type: "agent_settled" },
	].map((record) => JSON.stringify(record)).join("\n") + "\n");

	assert.equal(handle.state, "done");
	assert.equal(handle.resultText, "preserved final output");
	assert.equal(handle.runs.length, 1);
	assert.equal(h.settled, 1);
	child.emit("close", 0, null);
	assert.equal(handle.state, "done");
	assert.equal(handle.finalError, undefined);
	assert.equal(h.settled, 1);
	assert.doesNotMatch(h.diagnostics.join("\n"), /Process exited before agent_settled/);
});

test("production dispatcher accepts a new tool-only corroborator and rejects duplicate tool records", () => {
	const h = harness();
	const first = assistant(35, "first answer", "stop", "response-tool-first");
	dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options);
	dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_start", toolCallId: "old", toolName: "read", args: {} }, h.options);
	dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_end", toolCallId: "old", toolName: "read", result: { content: [] }, isError: false }, h.options);
	emitMessage(h, first);
	dispatchSubagentRpcEvent(h.handle, { type: "agent_end", messages: [first], willRetry: false }, h.options);

	dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_update", toolCallId: "old", toolName: "read", partialResult: { content: [] } }, h.options), false);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_end", toolCallId: "old", toolName: "read", result: { content: [] }, isError: false }, h.options), false);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_start", toolCallId: "old", toolName: "read", args: {} }, h.options), false);
	assert.equal(h.handle.runs[1]?.corroborated, false);
	assert.equal(h.handle.activeTools.size, 0);

	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_start", toolCallId: "new", toolName: "bash", args: {} }, h.options), true);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_start", toolCallId: "new", toolName: "bash", args: {} }, h.options), false);
	assert.equal(h.handle.runs[1]?.corroborated, true);
	assert.equal(h.handle.activeTools.size, 1);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_settled" }, h.options), false);
	assert.equal(h.settled, 0);

	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_update", toolCallId: "new", toolName: "bash", partialResult: { content: [{ type: "text", text: "progress" }] } }, h.options), true);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_end", toolCallId: "new", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false }, h.options), true);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_update", toolCallId: "new", toolName: "bash", partialResult: { content: [] } }, h.options), false);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_end", toolCallId: "new", toolName: "bash", result: { content: [] }, isError: false }, h.options), false);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "tool_execution_start", toolCallId: "new", toolName: "bash", args: {} }, h.options), false);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_settled" }, h.options), false);
	assert.equal(h.handle.recentTools.filter((tool) => tool.toolCallId === "new").length, 1);

	const continuation = assistant(36, "tool continuation", "stop", "response-tool-continuation");
	emitMessage(h, continuation);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_end", messages: [continuation], willRetry: false }, h.options), true);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_settled" }, h.options), true);
	assert.equal(h.handle.state, "done");
	assert.equal(h.handle.resultText, "tool continuation");
	assert.equal(h.settled, 1);
});

test("finalized assistant tombstones do not corroborate a late candidate run", () => {
	const h = harness();
	const first = assistant(37, "first answer", "stop", "response-assistant-old");
	dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options);
	emitMessage(h, first);
	dispatchSubagentRpcEvent(h.handle, { type: "agent_end", messages: [first], willRetry: false }, h.options);

	dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "message_start", message: { ...first, content: [] } }, h.options), false);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "message_update", message: first }, h.options), false);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "message_end", message: first }, h.options), false);
	assert.equal(h.handle.runs[1]?.corroborated, false);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_settled" }, h.options), true);
	assert.equal(h.handle.state, "done");
	assert.equal(h.handle.runs.length, 1);
	assert.equal(h.settled, 1);
});

test("production dispatcher keeps a corroborated queued continuation active until its own end", () => {
	const h = harness();
	const first = assistant(40, "first answer", "stop", "response-first");
	dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options);
	emitMessage(h, first);
	dispatchSubagentRpcEvent(h.handle, { type: "agent_end", messages: [first], willRetry: false }, h.options);

	dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options);
	const continuation = assistant(41, "queued continuation", "stop", "response-continuation");
	emitMessage(h, continuation);
	assert.equal(h.handle.runs[1]?.corroborated, true);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_settled" }, h.options), false);
	assert.equal(h.handle.lifecycle, "running");
	assert.equal(h.settled, 0);

	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_end", messages: [continuation], willRetry: false }, h.options), true);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_settled" }, h.options), true);
	assert.equal(h.handle.state, "done");
	assert.equal(h.handle.resultText, "queued continuation");
	assert.equal(h.handle.runs.length, 2);
	assert.equal(h.settled, 1);
});

test("production JSONL process attachment dispatches responses, flushes close records, and applies close fallback", () => {
	const handle = createHandle();
	const h = harness(handle);
	const child = new FakeChild();
	const responses: Record<string, any>[] = [];
	let stderr = "";
	attachSubagentRpcProcess(handle, child as unknown as ChildProcessWithoutNullStreams, {
		...h.options,
		onResponse: (record) => responses.push(record),
		appendStderr: (text) => { stderr += text; },
		signalProcess: () => assert.fail("unexpected forced signal"),
	});
	child.stdout.write('{"type":"response","id":"1","command":"get_state","success":true}\r\n');
	child.stdout.write("not-json\n");
	child.stdout.write('{"type":"agent_start"}');
	child.stderr.write("child warning");
	child.emit("close", 7, null);

	assert.equal(responses.length, 1);
	assert.equal(handle.runs.length, 1);
	assert.equal(handle.state, "error");
	assert.equal(handle.finalError, "Process exited before agent_settled with code 7");
	assert.equal(handle.exitCode, 7);
	assert.equal(stderr, "child warning");
	assert.equal(h.settled, 1);
	assert.match(h.diagnostics.join("\n"), /Malformed RPC JSON/);
});

test("requested kill settles once through the production dispatcher", () => {
	const h = harness();
	dispatchSubagentRpcEvent(h.handle, { type: "agent_start" }, h.options);
	requestKill(h.handle, 50);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_settled" }, h.options), true);
	assert.equal(h.handle.state, "killed");
	assert.equal(h.handle.finalError, "Killed");
	assert.equal(h.settled, 1);
	assert.equal(dispatchSubagentRpcEvent(h.handle, { type: "agent_settled" }, h.options), false);
	assert.equal(h.settled, 1);
});

test("child extension requests shutdown only at agent_settled", async () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
	const fakePi = {
		on: (name: string, handler: (event: unknown, ctx: any) => unknown) => handlers.set(name, handler),
		setActiveTools: () => {},
	};
	childSubagentExtension(fakePi as any);
	let shutdowns = 0;
	const ctx = { shutdown: () => shutdowns++, getSystemPrompt: () => "prompt" };
	assert.equal(handlers.has("agent_end"), false);
	await handlers.get("agent_settled")?.({}, ctx);
	await handlers.get("agent_settled")?.({}, ctx);
	assert.equal(shutdowns, 1);
});
