import assert from "node:assert/strict";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type AckFrame,
	acknowledgementMatchesConnectionEpoch,
	frameMatchesConnectionEpoch,
	frameMatchesOwnerAndIncarnation,
	type IpcConnection,
	type IpcServerCallbacks,
	prepareIpcSocketPath,
	startIpcServer,
} from "./ipc.ts";

function callbacks(
	events: string[],
	diagnostics: string[],
): IpcServerCallbacks {
	return {
		onHello: () => events.push("hello"),
		onSnapshot: () => events.push("snapshot"),
		onEvent: () => events.push("event"),
		onAck: () => events.push("ack"),
		onBye: () => events.push("bye"),
		onPong: () => events.push("pong"),
		onConnectionClose: () => events.push("close"),
		onConnectionError: (_connection, error) => diagnostics.push(error.message),
		onDiagnostic: (message) => diagnostics.push(message),
	};
}

function childFrame(type: string, extra: Record<string, unknown> = {}) {
	return {
		type,
		schemaVersion: 1,
		childId: "child",
		connectionId: "connection",
		at: Date.now(),
		ownerSessionFile: "/tmp/owner.jsonl",
		ownerSessionId: "owner-session",
		launchControllerInstanceId: "controller-a",
		incarnation: "incarnation-a",
		...extra,
	};
}

function hello(extra: Record<string, unknown> = {}) {
	return childFrame("hello", {
		sessionId: "session",
		sessionFile: "/tmp/session.jsonl",
		sessionFileExists: false,
		pid: 1,
		model: null,
		thinkingLevel: "off",
		reason: "startup",
		...extra,
	});
}

function snapshot(extra: Record<string, unknown> = {}) {
	return childFrame("snapshot", {
		sessionId: "session",
		sessionFile: "/tmp/session.jsonl",
		runState: "running",
		runId: 1,
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
		...extra,
	});
}

async function connect(path: string): Promise<net.Socket> {
	const socket = net.createConnection(path);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return socket;
}

async function eventually(
	predicate: () => boolean,
	timeout = 1000,
): Promise<void> {
	const end = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > end) assert.fail("condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("parent server dispatches validated frames and sends parent frames", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-ipc-"));
	const path = join(directory, "bridge.sock");
	const events: string[] = [];
	const diagnostics: string[] = [];
	let connection: IpcConnection | undefined;
	const handlers = callbacks(events, diagnostics);
	handlers.onHello = (_frame, candidate) => {
		events.push("hello");
		connection = candidate;
	};
	const server = await startIpcServer(path, handlers);
	const socket = await connect(path);
	try {
		let incoming = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			incoming += chunk;
		});
		socket.write(`${JSON.stringify(hello())}\n`);
		socket.write(
			`${JSON.stringify(childFrame("event", { event: "agent_start", runId: 1 }))}\n${JSON.stringify(snapshot())}\n`,
		);
		await eventually(() => events.length >= 3);
		socket.write(`${JSON.stringify(hello())}\n`);
		await eventually(
			() => events.filter((event) => event === "hello").length === 2,
		);
		connection?.send({
			type: "ping",
			id: "ping",
			ownerSessionFile: "/tmp/owner.jsonl",
			ownerSessionId: "owner-session",
			launchControllerInstanceId: "controller-a",
			incarnation: "incarnation-a",
		});
		await eventually(() => incoming.includes('"ping"'));
		assert.deepEqual(events.slice(0, 3), ["hello", "event", "snapshot"]);
		assert.equal(diagnostics.length, 0);
	} finally {
		socket.destroy();
		await server.close();
	}
});

test("malformed snapshots are dropped before callback state mutation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-ipc-"));
	const path = join(directory, "bridge.sock");
	const events: string[] = [];
	const diagnostics: string[] = [];
	const server = await startIpcServer(path, callbacks(events, diagnostics));
	const socket = await connect(path);
	try {
		socket.write(`${JSON.stringify(hello())}\n`);
		await eventually(() => events.includes("hello"));
		for (const malformed of [
			snapshot({ sessionId: undefined }),
			snapshot({ runState: "done" }),
			snapshot({ runId: -1 }),
			snapshot({ runOutcome: "unknown" }),
			snapshot({ usage: { input: "bad" } }),
			snapshot({ isStreaming: "yes" }),
		]) {
			socket.write(`${JSON.stringify(malformed)}\n`);
		}
		await eventually(
			() =>
				diagnostics.filter((message) => message.includes("malformed snapshot"))
					.length === 6,
		);
		assert.equal(events.includes("snapshot"), false);
		socket.write(`${JSON.stringify(snapshot())}\n`);
		await eventually(() => events.includes("snapshot"));
	} finally {
		socket.destroy();
		await server.close();
	}
});

test("malformed JSON and schema are diagnosed without closing connection", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-ipc-"));
	const path = join(directory, "bridge.sock");
	const events: string[] = [];
	const diagnostics: string[] = [];
	const server = await startIpcServer(path, callbacks(events, diagnostics));
	const socket = await connect(path);
	try {
		socket.write(
			`${JSON.stringify(hello())}\nnot json\n${JSON.stringify({ ...childFrame("pong"), schemaVersion: 99 })}\n${JSON.stringify(childFrame("pong"))}\n`,
		);
		await eventually(() => events.includes("pong"));
		assert.match(diagnostics.join("\n"), /Malformed IPC JSON/);
		assert.match(diagnostics.join("\n"), /schemaVersion/);
	} finally {
		socket.destroy();
		await server.close();
	}
});

test("listener can restart on the same path without EADDRINUSE", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-ipc-"));
	const path = join(directory, "bridge.sock");
	const events: string[] = [];
	const first = await startIpcServer(path, callbacks(events, []));
	await first.close();
	const second = await startIpcServer(path, callbacks(events, []));
	const socket = await connect(path);
	try {
		socket.write(`${JSON.stringify(hello())}\n`);
		await eventually(() => events.includes("hello"));
	} finally {
		socket.destroy();
		await second.close();
	}
});

test("backpressure queue is bounded for non-control frames", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-ipc-"));
	const path = join(directory, "bridge.sock");
	let connection: IpcConnection | undefined;
	const handlers = callbacks([], []);
	handlers.onHello = (_frame, candidate) => {
		connection = candidate;
	};
	const server = await startIpcServer(path, handlers);
	const socket = await connect(path);
	try {
		socket.write(`${JSON.stringify(hello())}\n`);
		await eventually(() => connection !== undefined);
		socket.pause();
		const content = "x".repeat(64 * 1024);
		for (let index = 0; index < 400; index++) {
			connection?.send({
				type: "send",
				id: String(index),
				deliverAs: "followUp",
				content,
				ownerSessionFile: "/tmp/owner.jsonl",
				ownerSessionId: "owner-session",
				launchControllerInstanceId: "controller-a",
				incarnation: "incarnation-a",
			});
		}
		assert.ok((connection?.bufferedFrames ?? 0) <= 256);
	} finally {
		socket.destroy();
		await server.close();
	}
});

test("fallback sockets use a private directory without changing the shared root mode", async () => {
	const sharedRoot = await mkdtemp("/tmp/pi-ipc-shared-");
	await chmod(sharedRoot, 0o755);
	const preferred = `/${"long".repeat(30)}/bridge.sock`;
	const path = await prepareIpcSocketPath(preferred, "child-id", sharedRoot);
	assert.equal(path, join(sharedRoot, "pi-subagent-child-id", "bridge.sock"));
	assert.equal((await stat(sharedRoot)).mode & 0o777, 0o755);
	assert.equal(
		(await stat(join(sharedRoot, "pi-subagent-child-id"))).mode & 0o777,
		0o700,
	);
});

test("stale snapshot and acknowledgement epochs cannot mutate or settle current state", () => {
	const currentConnection = {
		id: "parent-new",
		childConnectionId: "child-new",
	};
	const oldConnection = { id: "parent-old", childConnectionId: "child-old" };
	const epoch = {
		parentConnectionId: "parent-new",
		childConnectionId: "child-new",
	};
	let state = "new";
	if (
		frameMatchesConnectionEpoch(
			epoch,
			{ connectionId: "child-old" },
			oldConnection,
		)
	)
		state = "stale";
	assert.equal(state, "new");
	assert.equal(
		frameMatchesConnectionEpoch(
			epoch,
			{ connectionId: "child-new" },
			currentConnection,
		),
		true,
	);
	const staleAck = childFrame("ack", {
		connectionId: "child-old",
		id: "request",
		ok: true,
		queued: false,
	}) as AckFrame;
	assert.equal(
		acknowledgementMatchesConnectionEpoch(epoch, staleAck, oldConnection, {
			parentConnectionId: "parent-new",
			childConnectionId: "child-new",
		}),
		false,
	);
});

test("long socket paths fail clearly", async () => {
	await assert.rejects(
		startIpcServer(`/tmp/${"x".repeat(110)}`, callbacks([], [])),
		/too long/,
	);
});

test("frames missing owner or incarnation identity are diagnosed and ignored", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-ipc-"));
	const path = join(directory, "bridge.sock");
	const events: string[] = [];
	const diagnostics: string[] = [];
	const server = await startIpcServer(path, callbacks(events, diagnostics));
	const socket = await connect(path);
	try {
		socket.write(
			`${JSON.stringify({ ...hello(), ownerSessionFile: undefined })}\n`,
		);
		socket.write(`${JSON.stringify({ ...hello(), incarnation: undefined })}\n`);
		await eventually(() =>
			diagnostics.some((message) =>
				message.includes("missing owner or incarnation identity"),
			),
		);
		assert.equal(events.includes("hello"), false);
	} finally {
		socket.destroy();
		await server.close();
	}
});

test("a hello with a wrong owner is rejected and the connection closed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-ipc-"));
	const path = join(directory, "bridge.sock");
	const events: string[] = [];
	const diagnostics: string[] = [];
	let helloConn: IpcConnection | undefined;
	const handlers = callbacks(events, diagnostics);
	handlers.onHello = (_frame, conn) => {
		events.push("hello");
		helloConn = conn;
	};
	const server = await startIpcServer(path, handlers);
	const socket = await connect(path);
	try {
		socket.write(
			`${JSON.stringify(hello({ ownerSessionFile: "/tmp/other.jsonl" }))}\n`,
		);
		await eventually(() => events.includes("hello"));
		assert.equal(helloConn?.ownerSessionFile, "/tmp/other.jsonl");
	} finally {
		socket.destroy();
		await server.close();
	}
});

test("frameMatchesOwnerAndIncarnation rejects owner and incarnation mismatches", () => {
	const epoch = {
		ownerSessionFile: "/tmp/owner.jsonl",
		ownerSessionId: "owner-session",
		launchControllerInstanceId: "controller-a",
		incarnation: "inc-a",
		parentConnectionId: "parent-1",
		childConnectionId: "child-1",
	};
	const conn = {
		id: "parent-1",
		childConnectionId: "child-1",
		ownerSessionFile: "/tmp/owner.jsonl",
		ownerSessionId: "owner-session",
		launchControllerInstanceId: "controller-a",
		incarnation: "inc-a",
	};
	const frame = {
		ownerSessionFile: "/tmp/owner.jsonl",
		ownerSessionId: "owner-session",
		launchControllerInstanceId: "controller-a",
		incarnation: "inc-a",
		connectionId: "child-1",
	};
	assert.equal(frameMatchesOwnerAndIncarnation(epoch, frame, conn), true);
	assert.equal(
		frameMatchesOwnerAndIncarnation(
			epoch,
			{ ...frame, ownerSessionFile: "/tmp/other.jsonl" },
			conn,
		),
		false,
	);
	assert.equal(
		frameMatchesOwnerAndIncarnation(
			epoch,
			{ ...frame, incarnation: "inc-b" },
			conn,
		),
		false,
	);
});
