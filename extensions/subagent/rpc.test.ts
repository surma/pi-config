import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import {
	RpcChildTransport,
	RpcJsonlFramer,
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
): { child: FakeProcess; rpc: RpcChildTransport; diagnostics: string[]; records: RpcRecord[] } {
	const rpc = new RpcChildTransport(child as unknown as ChildProcess, {
		onRecord: (record) => records.push(record),
		onDiagnostic: (message) => diagnostics.push(message),
		onClose: () => {},
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

	const trailing = new RpcJsonlFramer();
	assert.deepEqual(trailing.push('{"text":"last"}\r'), []);
	assert.deepEqual(trailing.finish(), ['{"text":"last"}']);
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
