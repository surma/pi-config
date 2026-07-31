import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type TestHandler = (...args: unknown[]) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function eventually(predicate: () => boolean, timeout = 1500) {
	const end = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > end) assert.fail("condition timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

test("companion stays alive, emits identity/run frames, and accepts follow-up", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-child-bridge-"));
	const socketPath = join(dir, "bridge.sock");
	const received: Record<string, unknown>[] = [];
	let peer: net.Socket | undefined;
	let buffer = "";
	const server = net.createServer((socket) => {
		peer = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const i = buffer.indexOf("\n");
				if (i < 0) break;
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				if (line) {
					const parsed: unknown = JSON.parse(line);
					if (isRecord(parsed)) received.push(parsed);
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const old = {
		id: process.env.PI_SUBAGENT_CHILD_ID,
		socket: process.env.BRIDGE_SOCKET_PATH,
	};
	process.env.PI_SUBAGENT_CHILD_ID = "stable-child";
	process.env.BRIDGE_SOCKET_PATH = socketPath;
	process.env.PI_SUBAGENT_OWNER_SESSION_FILE = "/tmp/owner.jsonl";
	process.env.PI_SUBAGENT_OWNER_SESSION_ID = "owner-session";
	process.env.PI_SUBAGENT_CONTROLLER_INSTANCE_ID = "controller-a";
	process.env.PI_SUBAGENT_INCARNATION = "inc-stable";
	try {
		const { default: childExtension } = await import(
			`./child.ts?test=${Date.now()}`
		);
		const handlers = new Map<string, TestHandler>();
		const messages: { content: unknown; options: unknown }[] = [];
		const pi = {
			on: (name: string, fn: TestHandler) => handlers.set(name, fn),
			getThinkingLevel: () => "high",
			sendUserMessage: (content: unknown, options: unknown) =>
				messages.push({ content, options }),
		};
		childExtension(pi as unknown as ExtensionAPI);
		let shutdowns = 0;
		let sessionId = "session";
		const ctx = {
			model: { provider: "p", id: "m", name: "M" },
			isIdle: () => true,
			shutdown: () => shutdowns++,
			getSystemPrompt: () => "prompt",
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionFile: () => join(dir, `${sessionId}.jsonl`),
			},
		};
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		await eventually(() => received.some((f) => f.type === "hello"));
		const hello = received.find((f) => f.type === "hello");
		assert.equal(hello?.childId, "stable-child");
		assert.equal(hello?.ownerSessionFile, "/tmp/owner.jsonl");
		assert.equal(hello?.incarnation, "inc-stable");
		assert.equal(hello?.sessionId, "session");
		await handlers.get("agent_start")?.({}, ctx);
		await handlers.get("agent_end")?.({ willRetry: false, messages: [] }, ctx);
		await handlers.get("agent_settled")?.({ runOutcome: "succeeded" }, ctx);
		await handlers.get("agent_start")?.({}, ctx);
		await handlers.get("agent_end")?.({ willRetry: false, messages: [] }, ctx);
		await handlers.get("agent_settled")?.({ runOutcome: "succeeded" }, ctx);
		await eventually(
			() =>
				received.filter(
					(f) => f.type === "event" && f.event === "agent_settled",
				).length === 2,
		);
		assert.equal(shutdowns, 0);
		assert.deepEqual(
			received.filter((f) => f.event === "agent_start").map((f) => f.runId),
			[1, 2],
		);
		peer?.write(
			`${JSON.stringify({
				type: "send",
				id: "send-1",
				deliverAs: "followUp",
				content: "next",
				ownerSessionFile: "/tmp/owner.jsonl",
				ownerSessionId: "owner-session",
				launchControllerInstanceId: "controller-a",
				incarnation: "inc-stable",
			})}\n`,
		);
		await eventually(() =>
			received.some((f) => f.type === "ack" && f.id === "send-1"),
		);
		assert.deepEqual(messages, [
			{ content: "next", options: { deliverAs: "followUp" } },
		]);
		await handlers.get("session_shutdown")?.({ reason: "new" }, ctx);
		sessionId = "session-new";
		await handlers.get("session_start")?.({ reason: "new" }, ctx);
		await handlers.get("agent_start")?.({}, ctx);
		await handlers.get("agent_end")?.({ willRetry: false, messages: [] }, ctx);
		await handlers.get("agent_settled")?.({ runOutcome: "succeeded" }, ctx);
		await handlers.get("session_shutdown")?.({ reason: "resume" }, ctx);
		sessionId = "session-resumed";
		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		await handlers.get("agent_start")?.({}, ctx);
		await handlers.get("agent_end")?.({ willRetry: false, messages: [] }, ctx);
		await handlers.get("agent_settled")?.({ runOutcome: "succeeded" }, ctx);
		await eventually(
			() => received.filter((f) => f.event === "agent_start").length === 4,
		);
		assert.deepEqual(
			received.filter((f) => f.event === "agent_start").map((f) => f.runId),
			[1, 2, 3, 4],
		);
		await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
		await eventually(() =>
			received.some((f) => f.type === "bye" && f.reason === "reload"),
		);
		const { default: reloadedExtension } = await import(
			`./child.ts?reload=${Date.now()}`
		);
		const reloadedHandlers = new Map<string, TestHandler>();
		reloadedExtension({
			...pi,
			on: (name: string, fn: TestHandler) => reloadedHandlers.set(name, fn),
		} as unknown as ExtensionAPI);
		await reloadedHandlers.get("session_start")?.({ reason: "reload" }, ctx);
		await eventually(() =>
			received.some(
				(f) =>
					f.type === "snapshot" &&
					f.runId === 4 &&
					f.runOutcome === "succeeded",
			),
		);
		const reloadedHello = [...received]
			.reverse()
			.find((f) => f.type === "hello");
		assert.equal(reloadedHello?.childId, "stable-child");
		assert.equal(reloadedHello?.ownerSessionFile, "/tmp/owner.jsonl");
		assert.equal(reloadedHello?.incarnation, "inc-stable");
		await reloadedHandlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	} finally {
		if (old.id === undefined) delete process.env.PI_SUBAGENT_CHILD_ID;
		else process.env.PI_SUBAGENT_CHILD_ID = old.id;
		if (old.socket === undefined) delete process.env.BRIDGE_SOCKET_PATH;
		else process.env.BRIDGE_SOCKET_PATH = old.socket;
		delete process.env.PI_SUBAGENT_OWNER_SESSION_FILE;
		delete process.env.PI_SUBAGENT_INCARNATION;
		peer?.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("same-session resume clears an active run after extension replacement", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-child-resume-"));
	const socketPath = join(dir, "bridge.sock");
	const childId = `resume-child-${Date.now()}`;
	const received: Record<string, unknown>[] = [];
	let peer: net.Socket | undefined;
	let buffer = "";
	const server = net.createServer((socket) => {
		peer = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const parsed: unknown = JSON.parse(line);
				if (isRecord(parsed)) received.push(parsed);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const old = {
		id: process.env.PI_SUBAGENT_CHILD_ID,
		socket: process.env.BRIDGE_SOCKET_PATH,
	};
	process.env.PI_SUBAGENT_CHILD_ID = childId;
	process.env.BRIDGE_SOCKET_PATH = socketPath;
	process.env.PI_SUBAGENT_OWNER_SESSION_FILE = "/tmp/owner.jsonl";
	process.env.PI_SUBAGENT_OWNER_SESSION_ID = "owner-session";
	process.env.PI_SUBAGENT_CONTROLLER_INSTANCE_ID = "controller-a";
	process.env.PI_SUBAGENT_INCARNATION = "inc-resume";
	try {
		const firstHandlers = new Map<string, TestHandler>();
		const first = (await import(`./child.ts?resume-old=${Date.now()}`)).default;
		const pi = {
			on: (name: string, fn: TestHandler) => firstHandlers.set(name, fn),
			getThinkingLevel: () => "high",
			sendUserMessage: () => {},
		};
		const ctx = {
			model: { provider: "p", id: "m", name: "M" },
			isIdle: () => false,
			shutdown: () => {},
			getSystemPrompt: () => "prompt",
			sessionManager: {
				getSessionId: () => "same-session",
				getSessionFile: () => join(dir, "same-session.jsonl"),
			},
		};
		first(pi as unknown as ExtensionAPI);
		await firstHandlers.get("session_start")?.({ reason: "startup" }, ctx);
		await firstHandlers.get("agent_start")?.({}, ctx);
		await eventually(() =>
			received.some(
				(frame) => frame.event === "agent_start" && frame.runId === 1,
			),
		);
		await firstHandlers.get("session_shutdown")?.({ reason: "resume" }, ctx);

		const resumedHandlers = new Map<string, TestHandler>();
		const resumed = (await import(`./child.ts?resume-new=${Date.now()}`))
			.default;
		resumed({
			...pi,
			on: (name: string, fn: TestHandler) => resumedHandlers.set(name, fn),
		} as unknown as ExtensionAPI);
		await resumedHandlers.get("session_start")?.({ reason: "resume" }, ctx);
		await eventually(() =>
			received.some(
				(frame) => frame.type === "hello" && frame.reason === "resume",
			),
		);
		const resumedHello = [...received]
			.reverse()
			.find((frame) => frame.type === "hello" && frame.reason === "resume");
		await eventually(() =>
			received.some(
				(frame) =>
					frame.type === "snapshot" &&
					frame.connectionId === resumedHello?.connectionId &&
					frame.runId === 1,
			),
		);
		const resumedSnapshot = [...received]
			.reverse()
			.find(
				(frame) =>
					frame.type === "snapshot" &&
					frame.connectionId === resumedHello?.connectionId &&
					frame.runId === 1,
			);
		await resumedHandlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		assert.equal(resumedSnapshot?.runState, "idle");
		assert.equal(resumedSnapshot?.runOutcome, "pending");
	} finally {
		if (old.id === undefined) delete process.env.PI_SUBAGENT_CHILD_ID;
		else process.env.PI_SUBAGENT_CHILD_ID = old.id;
		if (old.socket === undefined) delete process.env.BRIDGE_SOCKET_PATH;
		else process.env.BRIDGE_SOCKET_PATH = old.socket;
		delete process.env.PI_SUBAGENT_OWNER_SESSION_FILE;
		delete process.env.PI_SUBAGENT_INCARNATION;
		peer?.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
