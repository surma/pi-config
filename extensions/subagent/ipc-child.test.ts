import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HelloFrame, PongFrame } from "./ipc.ts";
import { connectChild } from "./ipc-child.ts";

async function listen(path: string, onSocket: (socket: net.Socket) => void) {
	const server = net.createServer(onSocket);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
	return server;
}
async function eventually(predicate: () => boolean, timeout = 1000) {
	const end = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > end) assert.fail("condition timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}
function hello(connectionId: string): HelloFrame {
	return {
		type: "hello",
		schemaVersion: 1,
		childId: "child",
		connectionId,
		at: Date.now(),
		sessionId: "s",
		sessionFile: "/tmp/s",
		sessionFileExists: false,
		pid: 1,
		model: null,
		thinkingLevel: "off",
		reason: "startup",
		ownerSessionFile: "/tmp/owner.jsonl",
		ownerSessionId: "owner-session",
		launchControllerInstanceId: "controller-a",
		incarnation: "inc-a",
	};
}

function pong(connectionId: string, id: string): PongFrame {
	return {
		type: "pong",
		schemaVersion: 1,
		childId: "child",
		connectionId,
		at: Date.now(),
		ownerSessionFile: "/tmp/owner.jsonl",
		ownerSessionId: "owner-session",
		launchControllerInstanceId: "controller-a",
		incarnation: "inc-a",
		id,
	};
}

test("child connector round-trips and reconnects with a new connection id", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-child-ipc-"));
	const path = join(dir, "bridge.sock");
	const received: Record<string, unknown>[] = [];
	let parentSocket: net.Socket | undefined;
	const accept = (socket: net.Socket) => {
		parentSocket = socket;
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line) received.push(JSON.parse(line) as Record<string, unknown>);
			}
		});
	};
	let server = await listen(path, accept);
	const child = connectChild(path, {
		backoff: { initialMs: 10, maximumMs: 20, multiplier: 2 },
	});
	const connections: string[] = [];
	const frames: string[] = [];
	child.onConnect((id) => {
		connections.push(id);
		child.send(hello(id));
	});
	child.onFrame((frame) => {
		frames.push(frame.type);
		if (frame.type === "ping") child.send(pong(child.connectionId, frame.id));
	});
	await eventually(() => received.some((frame) => frame.type === "hello"));
	if (!parentSocket) assert.fail("parent socket did not connect");
	parentSocket.write(
		`${JSON.stringify({
			type: "ping",
			id: "p",
			ownerSessionFile: process.env.PI_SUBAGENT_OWNER_SESSION_FILE || "",
			ownerSessionId: process.env.PI_SUBAGENT_OWNER_SESSION_ID || "",
			launchControllerInstanceId:
				process.env.PI_SUBAGENT_CONTROLLER_INSTANCE_ID || "",
			incarnation: process.env.PI_SUBAGENT_INCARNATION || "",
		})}\n`,
	);
	await eventually(() => frames.includes("ping"));
	await eventually(() =>
		received.some((frame) => frame.type === "pong" && frame.id === "p"),
	);
	parentSocket.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	server = await listen(path, accept);
	await eventually(() => connections.length >= 2);
	assert.notEqual(connections[0], connections[1]);
	parentSocket?.write(
		`${JSON.stringify({
			type: "ping",
			id: "p-after-reconnect",
			ownerSessionFile: process.env.PI_SUBAGENT_OWNER_SESSION_FILE || "",
			ownerSessionId: process.env.PI_SUBAGENT_OWNER_SESSION_ID || "",
			launchControllerInstanceId:
				process.env.PI_SUBAGENT_CONTROLLER_INSTANCE_ID || "",
			incarnation: process.env.PI_SUBAGENT_INCARNATION || "",
		})}\n`,
	);
	await eventually(() =>
		received.some(
			(frame) => frame.type === "pong" && frame.id === "p-after-reconnect",
		),
	);
	const reconnectPongs = received.filter(
		(frame) => frame.type === "pong" && frame.id === "p-after-reconnect",
	);
	assert.equal(reconnectPongs.length, 1);
	assert.equal(reconnectPongs[0]?.connectionId, connections[1]);
	child.close();
	parentSocket?.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
