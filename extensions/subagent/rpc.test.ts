import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import {
	RpcChildTransport,
	RpcJsonlFramer,
	type RpcProcessClose,
	type RpcRecord,
} from "./rpc.ts";

class RecordingStdin extends Writable {
	readonly lines: RpcRecord[] = [];
	onLine?: (record: RpcRecord) => void;

	_write(chunk: Buffer | string, _encoding: string, callback: (error?: Error) => void): void {
		const line = chunk.toString().trimEnd();
		const record = JSON.parse(line) as RpcRecord;
		this.lines.push(record);
		this.onLine?.(record);
		callback();
	}
}

class BackpressuredStdin extends Writable {
	readonly writes: RpcRecord[] = [];
	private callback?: (error?: Error | null) => void;

	write(...args: any[]): boolean {
		const chunk = args[0] as string | Uint8Array;
		const callback =
			typeof args[2] === "function"
				? args[2]
				: typeof args[1] === "function"
					? args[1]
					: undefined;
		this.writes.push(JSON.parse(chunk.toString()) as RpcRecord);
		this.callback = callback;
		return false;
	}

	release(): void {
		const callback = this.callback;
		this.callback = undefined;
		callback?.();
		this.emit("drain");
	}
}

class BackpressuredProcess extends EventEmitter {
	readonly stdin = new BackpressuredStdin();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	pid = 4321;

	kill(_signal: NodeJS.Signals): boolean {
		return true;
	}
}

class FakeProcess extends EventEmitter {
	readonly stdin = new RecordingStdin();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly signals: NodeJS.Signals[] = [];
	pid = 1234;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	onSignal?: (signal: NodeJS.Signals) => void;

	kill(signal: NodeJS.Signals): boolean {
		this.signals.push(signal);
		this.onSignal?.(signal);
		return true;
	}

	close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
		if (this.exitCode !== null || this.signalCode !== null) return;
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("close", code, signal);
		this.stdout.end();
		this.stderr.end();
	}
}

function transport(
	child = new FakeProcess(),
	diagnostics: string[] = [],
	records: RpcRecord[] = [],
	onClose: (close: RpcProcessClose) => void = () => {},
): { child: FakeProcess; rpc: RpcChildTransport; diagnostics: string[]; records: RpcRecord[] } {
	const rpc = new RpcChildTransport(child as unknown as ChildProcess, {
		onRecord: (record) => records.push(record),
		onDiagnostic: (message) => diagnostics.push(message),
		onClose,
		requestTimeoutMs: 100,
	});
	return { child, rpc, diagnostics, records };
}

function response(command: RpcRecord, data?: unknown): RpcRecord {
	return {
		type: "response",
		id: command.id,
		command: String(command.type),
		success: true,
		...(data === undefined ? {} : { data }),
	};
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("strict JSONL framing handles split UTF-8, CRLF, and Unicode separators", () => {
	const framer = new RpcJsonlFramer();
	const expected = [
		{ type: "message", text: "split 🌍" },
		{ type: "message", text: "line\u2028separator" },
	];
	const encoded = Buffer.from(
		`${JSON.stringify(expected[0])}\r\n${JSON.stringify(expected[1])}\n`,
	);
	const emoji = encoded.indexOf(Buffer.from("🌍"));
	assert.ok(emoji > 0);
	assert.deepEqual(framer.push(encoded.subarray(0, emoji + 1)), []);
	assert.deepEqual(framer.push(encoded.subarray(emoji + 1)), [
		JSON.stringify(expected[0]),
		JSON.stringify(expected[1]),
	]);
	assert.deepEqual(framer.finish(), []);

	const diagnostics: string[] = [];
	const trailing = new RpcJsonlFramer({ onDiagnostic: (message) => diagnostics.push(message) });
	assert.deepEqual(trailing.push('{"text":"last"}\r'), []);
	assert.deepEqual(trailing.finish(), []);
	assert.deepEqual(diagnostics, ["Discarded unterminated RPC JSONL record."]);
});

test("malformed JSONL is diagnosed while valid records continue", async () => {
	const fixture = transport();
	fixture.child.stdout.write(
		`not-json\n[]\n${JSON.stringify({ type: "agent_start", runId: 1 })}\n`,
	);
	await tick();
	assert.deepEqual(fixture.records, [{ type: "agent_start", runId: 1 }]);
	assert.equal(fixture.diagnostics.length, 2);
	assert.match(fixture.diagnostics[0] || "", /Malformed RPC JSONL record/);
	assert.match(fixture.diagnostics[1] || "", /not an object/);
	fixture.rpc.forceClose({ code: null, signal: "SIGKILL" });
});

test("RPC transport delivers complete records larger than two MiB", async () => {
	const fixture = transport();
	const formerLimit = 2 * 1024 * 1024;
	const text = "x".repeat(formerLimit + 1);
	const record = {
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
		willRetry: false,
	};
	const encoded = Buffer.from(`${JSON.stringify(record)}\n`);
	assert.ok(encoded.byteLength > formerLimit);
	const split = 1024 * 1024;
	fixture.child.stdout.write(encoded.subarray(0, split));
	fixture.child.stdout.write(encoded.subarray(split));
	await tick();
	assert.equal(fixture.records.length, 1);
	assert.equal(fixture.records[0]?.type, "agent_end");
	const messages = fixture.records[0]?.messages as Array<Record<string, any>>;
	assert.equal(messages[0]?.content?.[0]?.text, text);
	assert.deepEqual(fixture.diagnostics, []);
	fixture.rpc.forceClose({ code: null, signal: "SIGKILL" });
});

test("correlated responses resolve out of order", async () => {
	const fixture = transport();
	const queued: RpcRecord[] = [];
	fixture.child.stdin.onLine = (command) => {
		queued.push(command);
		if (queued.length !== 2) return;
		fixture.child.stdout.write(`${JSON.stringify(response(queued[1]))}\n`);
		fixture.child.stdout.write(`${JSON.stringify(response(queued[0], { ok: true }))}\n`);
	};
	const first = fixture.rpc.send({ type: "first" });
	const second = fixture.rpc.send({ type: "second" });
	const [firstResponse, secondResponse] = await Promise.all([first, second]);
	assert.equal(firstResponse.command, "first");
	assert.deepEqual(firstResponse.data, { ok: true });
	assert.equal(secondResponse.command, "second");
	assert.deepEqual(fixture.child.stdin.lines.map((line) => line.type), ["first", "second"]);
	fixture.rpc.forceClose({ code: null, signal: "SIGKILL" });
});

test("process close rejects every pending request", async () => {
	const fixture = transport();
	const pending = fixture.rpc.send({ type: "get_state" }, 1_000);
	fixture.child.close(7, null);
	await assert.rejects(pending, /RPC child process closed/);
	assert.equal(fixture.rpc.isClosed, true);
});

test("RPC response waits still reject after their finite timeout", async () => {
	const fixture = transport();
	await assert.rejects(
		fixture.rpc.send({ type: "no_response" }, 20),
		/Timed out waiting for RPC response/,
	);
	fixture.rpc.forceClose({ code: null, signal: "SIGKILL" });
});

test("RPC sends can be canceled through an optional AbortSignal", async () => {
	const fixture = transport();
	const controller = new AbortController();
	const request = fixture.rpc.send({ type: "cancelable" }, 200, controller.signal);
	controller.abort(new Error("request canceled"));
	await assert.rejects(request, (error) => {
		assert.equal((error as Error).name, "AbortError");
		assert.match((error as Error).message, /request canceled/);
		return true;
	});
	await tick();
	assert.deepEqual(fixture.child.stdin.lines, []);
	fixture.rpc.forceClose({ code: null, signal: "SIGKILL" });
});

test("RPC sends preserve DOMException abort reasons without mutating them", async () => {
	const fixture = transport();
	const controller = new AbortController();
	const reason = new DOMException("request canceled", "AbortError");
	const request = fixture.rpc.send({ type: "cancelable" }, 200, controller.signal);
	controller.abort(reason);
	await assert.rejects(request, (error) => {
		assert.equal((error as Error).name, "AbortError");
		assert.equal((error as Error).message, reason.message);
		assert.notEqual(error, reason);
		return true;
	});
	assert.equal(reason.name, "AbortError");
	fixture.rpc.forceClose({ code: null, signal: "SIGKILL" });
});

test("aborting a blocked write releases its pending request and queue slot", async () => {
	const child = new BackpressuredProcess();
	const rpc = new RpcChildTransport(child as unknown as ChildProcess, {
		onRecord: () => {},
		onDiagnostic: () => {},
		onClose: () => {},
		requestTimeoutMs: 500,
		maxPendingRequests: 1,
	});
	const controller = new AbortController();
	const first = rpc.send({ type: "first" }, {
		timeoutMs: 500,
		writeTimeoutMs: 500,
		signal: controller.signal,
	});
	await tick();
	assert.equal(child.stdin.writes.length, 1);
	controller.abort(new Error("parent aborted"));
	await assert.rejects(first, (error) => {
		assert.equal((error as Error).name, "AbortError");
		return true;
	});
	await tick();
	child.stdin.release();
	const second = rpc.send({ type: "second" }, {
		timeoutMs: 500,
		writeTimeoutMs: 500,
	});
	await tick();
	assert.equal(child.stdin.writes.length, 2);
	child.stdin.release();
	const command = child.stdin.writes[1];
	assert.ok(command);
	child.stdout.write(`${JSON.stringify(response(command))}\n`);
	await second;
	rpc.forceClose({ code: null, signal: "SIGKILL" });
});

test("RPC request and aggregate pending-byte bounds reject before queue growth", async () => {
	const fixture = transport();
	const boundedRpc = new RpcChildTransport(fixture.child as unknown as ChildProcess, {
		onRecord: () => {},
		onDiagnostic: () => {},
		onClose: () => {},
		requestTimeoutMs: 500,
		maxRequestBytes: 256,
		maxPendingBytes: 128,
	});
	await assert.rejects(
		boundedRpc.send({ type: "oversized", message: "x".repeat(300) }),
		/request exceeds/,
	);
	const first = boundedRpc.send({ type: "first", message: "x".repeat(40) });
	await assert.rejects(
		boundedRpc.send({ type: "second", message: "y".repeat(40) }),
		/request queue is full/,
	);
	boundedRpc.forceClose({
		code: null,
		signal: "SIGKILL",
		error: new Error("forced close"),
	});
	await assert.rejects(first, /forced close/);
});

test("RPC writes wait for drain and serialize queued requests", async () => {
	const child = new BackpressuredProcess();
	const diagnostics: string[] = [];
	const rpc = new RpcChildTransport(child as unknown as ChildProcess, {
		onRecord: () => {},
		onDiagnostic: (message) => diagnostics.push(message),
		onClose: () => {},
		requestTimeoutMs: 200,
	});
	const first = rpc.send({ type: "prompt", message: "first" }, {
		timeoutMs: 200,
		writeTimeoutMs: 100,
	});
	const second = rpc.send({ type: "follow_up", message: "second" }, {
		timeoutMs: 200,
		writeTimeoutMs: 100,
	});
	await tick();
	assert.equal(child.stdin.writes.length, 1);
	child.stdin.release();
	await tick();
	assert.equal(child.stdin.writes.length, 2);
	child.stdin.release();
	for (const command of child.stdin.writes)
		child.stdout.write(`${JSON.stringify({
			type: "response",
			id: command.id,
			command: command.type,
			success: true,
		})}\n`);
	await Promise.all([first, second]);
	assert.deepEqual(diagnostics, []);
	rpc.forceClose({ code: null, signal: "SIGKILL" });
});

test("RPC backpressure timeout rejects and destroys the blocked stdin", async () => {
	const child = new BackpressuredProcess();
	const rpc = new RpcChildTransport(child as unknown as ChildProcess, {
		onRecord: () => {},
		onDiagnostic: () => {},
		onClose: () => {},
		requestTimeoutMs: 200,
	});
	await assert.rejects(
		rpc.send({ type: "prompt", message: "blocked" }, {
			timeoutMs: 100,
			writeTimeoutMs: 20,
		}),
		/Timed out writing an RPC request/,
	);
	assert.equal(child.stdin.destroyed, true);
	rpc.forceClose({ code: null, signal: "SIGKILL" });
});

test("close callback exceptions stay inside the EventEmitter callback", () => {
	const child = new FakeProcess();
	const diagnostics: string[] = [];
	const rpc = new RpcChildTransport(child as unknown as ChildProcess, {
		onRecord: () => {},
		onDiagnostic: (message) => diagnostics.push(message),
		onClose: () => {
			throw new Error("close callback failed");
		},
	});
	assert.doesNotThrow(() => child.close(0, null));
	assert.equal(rpc.isClosed, true);
	assert.match(diagnostics.join("\n"), /close handler failed/);
});

test("forceClose records missing OS close and releases stream resources", async () => {
	const closes: RpcProcessClose[] = [];
	const fixture = transport(undefined, [], [], (close) => closes.push(close));
	const pending = fixture.rpc.send({ type: "get_state" }, 1_000);
	fixture.rpc.forceClose({
		code: null,
		signal: "SIGKILL",
		error: new Error("forced close"),
	});
	await assert.rejects(pending, /forced close/);
	assert.equal(fixture.rpc.isClosed, true);
	assert.equal(fixture.child.stdin.destroyed, true);
	assert.equal(fixture.child.stdout.destroyed, true);
	assert.equal(fixture.child.stderr.destroyed, true);
	assert.deepEqual(fixture.child.signals, ["SIGKILL"]);
	assert.deepEqual(closes, [{
		code: null,
		signal: "SIGKILL",
		error: closes[0]?.error,
		osCloseObserved: false,
		forced: true,
	}]);
	assert.equal(closes[0]?.error?.message, "forced close");
});

test("termination sends abort, then TERM, and reaps a cooperative child", async () => {
	const fixture = transport();
	fixture.child.stdin.onLine = (command) => {
		if (command.type === "abort")
			fixture.child.stdout.write(`${JSON.stringify(response(command))}\n`);
	};
	fixture.child.onSignal = (signal) => {
		if (signal === "SIGTERM") fixture.child.close(0, signal);
	};
	assert.equal(
		await fixture.rpc.terminate({
			abortTimeoutMs: 20,
			closeAfterAbortMs: 2,
			termTimeoutMs: 20,
			killTimeoutMs: 20,
		}),
		true,
	);
	assert.deepEqual(fixture.child.stdin.lines.map((line) => line.type), ["abort"]);
	assert.deepEqual(fixture.child.signals, ["SIGTERM"]);
});

test("termination escalates from TERM to KILL when TERM does not close", async () => {
	const fixture = transport();
	fixture.child.stdin.onLine = (command) => {
		if (command.type === "abort")
			fixture.child.stdout.write(`${JSON.stringify(response(command))}\n`);
	};
	fixture.child.onSignal = (signal) => {
		if (signal === "SIGKILL") fixture.child.close(null, signal);
	};
	assert.equal(
		await fixture.rpc.terminate({
			abortTimeoutMs: 20,
			closeAfterAbortMs: 2,
			termTimeoutMs: 2,
			killTimeoutMs: 20,
		}),
		true,
	);
	assert.deepEqual(fixture.child.signals, ["SIGTERM", "SIGKILL"]);
});

test("termination force-closes when even KILL has no close event", async () => {
	const fixture = transport();
	fixture.child.stdin.onLine = (command) => {
		if (command.type === "abort")
			fixture.child.stdout.write(`${JSON.stringify(response(command))}\n`);
	};
	assert.equal(
		await fixture.rpc.terminate({
			abortTimeoutMs: 20,
			closeAfterAbortMs: 2,
			termTimeoutMs: 2,
			killTimeoutMs: 2,
		}),
		false,
	);
	assert.deepEqual(fixture.child.signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(fixture.rpc.isClosed, true);
	assert.match(fixture.diagnostics.join("\n"), /did not close after SIGKILL/);
});
