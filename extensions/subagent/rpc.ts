import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export type RpcRecord = Record<string, unknown>;

export interface RpcResponseRecord extends RpcRecord {
	type: "response";
	command: string;
	success: boolean;
	id?: string;
	error?: string;
}

export interface RpcProcessClose {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

/** Strict LF-only JSONL framing for the Pi RPC protocol. */
export class RpcJsonlFramer {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";

	push(chunk: string | Buffer): string[] {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		return this.takeLines();
	}

	finish(): string[] {
		this.buffer += this.decoder.end();
		if (!this.buffer) return [];
		const line = this.buffer.endsWith("\r")
			? this.buffer.slice(0, -1)
			: this.buffer;
		this.buffer = "";
		return [line];
	}

	private takeLines(): string[] {
		const lines: string[] = [];
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return lines;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
	}
}

export function attachRpcJsonlReader(
	stream: Readable,
	onLine: (line: string) => void,
): () => void {
	const framer = new RpcJsonlFramer();
	const onData = (chunk: string | Buffer) => {
		for (const line of framer.push(chunk)) onLine(line);
	};
	const onEnd = () => {
		for (const line of framer.finish()) onLine(line);
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

interface PendingRequest {
	resolve: (response: RpcResponseRecord) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface RpcChildTransportOptions {
	onRecord: (record: RpcRecord) => void;
	onDiagnostic: (message: string) => void;
	onClose: (close: RpcProcessClose) => void;
	requestTimeoutMs?: number;
}

export interface RpcTerminationOptions {
	abort?: boolean;
	abortTimeoutMs?: number;
	closeAfterAbortMs?: number;
	termTimeoutMs?: number;
	killTimeoutMs?: number;
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(undefined);
		}, timeoutMs);
		timer.unref?.();
		void promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}

/** Owns one Pi RPC process, its JSONL framing, and correlated requests. */
export class RpcChildTransport {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly closePromise: Promise<void>;
	private resolveClose!: () => void;
	private readonly stopReader: () => void;
	private requestSequence = 0;
	private closed = false;
	private processError?: Error;
	private stderrText = "";

	constructor(
		readonly process: ChildProcess,
		private readonly options: RpcChildTransportOptions,
	) {
		this.closePromise = new Promise((resolve) => {
			this.resolveClose = resolve;
		});
		this.stopReader = process.stdout
			? attachRpcJsonlReader(process.stdout, (line) => this.handleLine(line))
			: () => {};
		process.stderr?.on("data", (chunk: string | Buffer) => {
			this.stderrText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (this.stderrText.length > 64 * 1024)
				this.stderrText = this.stderrText.slice(-64 * 1024);
		});
		process.stdout?.on("error", (error) =>
			this.options.onDiagnostic(`RPC stdout error: ${error.message}`),
		);
		process.stderr?.on("error", (error) =>
			this.options.onDiagnostic(`RPC stderr error: ${error.message}`),
		);
		process.stdin?.on("error", (error) => {
			this.processError = error;
			this.rejectPending(new Error(`RPC stdin error: ${error.message}`));
			this.options.onDiagnostic(`RPC stdin error: ${error.message}`);
		});
		process.once("error", (error) => {
			this.processError = error;
			this.rejectPending(new Error(`RPC process error: ${error.message}`));
			this.options.onDiagnostic(`RPC process error: ${error.message}`);
		});
		process.once("close", (code, signal) => {
			this.finishClose({ code, signal, error: this.processError });
		});
	}

	get isClosed(): boolean {
		return this.closed;
	}

	get stderr(): string {
		return this.stderrText;
	}

	async send(
		body: RpcRecord,
		timeoutMs = this.options.requestTimeoutMs ?? 30_000,
	): Promise<RpcResponseRecord> {
		if (this.closed || this.processError)
			throw this.processError || new Error("RPC child process is closed.");
		const stdin = this.process.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable)
			throw new Error("RPC child process stdin is not writable.");
		const id = `rpc-${++this.requestSequence}`;
		const command = { ...body, id };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for RPC response to ${String(body.type)}.`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			try {
				stdin.write(`${JSON.stringify(command)}\n`, "utf8", (error?: Error | null) => {
					if (!error) return;
					const pending = this.pending.get(id);
					if (!pending) return;
					this.pending.delete(id);
					clearTimeout(pending.timer);
					pending.reject(error);
				});
			} catch (error) {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timer);
				pending.reject(asError(error));
			}
		});
	}

	waitForClose(timeoutMs: number): Promise<boolean> {
		if (this.closed) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve(false);
			}, timeoutMs);
			timer.unref?.();
			void this.closePromise.then(() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	async terminate(options: RpcTerminationOptions = {}): Promise<boolean> {
		if (this.closed) return true;
		const abort = options.abort !== false;
		const abortTimeoutMs = options.abortTimeoutMs ?? 1_000;
		const closeAfterAbortMs = options.closeAfterAbortMs ?? 250;
		const termTimeoutMs = options.termTimeoutMs ?? 1_500;
		const killTimeoutMs = options.killTimeoutMs ?? 2_500;
		if (abort) {
			await withTimeout(this.send({ type: "abort" }, abortTimeoutMs), abortTimeoutMs);
			if (await this.waitForClose(closeAfterAbortMs)) return true;
		}
		this.signal("SIGTERM");
		if (await this.waitForClose(termTimeoutMs)) return true;
		this.signal("SIGKILL");
		if (await this.waitForClose(killTimeoutMs)) return true;
		const error = new Error("RPC child process did not close after SIGKILL.");
		this.options.onDiagnostic(error.message);
		this.forceClose({ code: null, signal: "SIGKILL", error });
		return false;
	}

	/** Reject requests and fence callbacks when the OS close event does not arrive. */
	forceClose(close: RpcProcessClose): void {
		if (this.closed) return;
		this.finishClose(close);
	}

	private signal(signal: NodeJS.Signals): void {
		if (this.closed) return;
		try {
			if (!this.process.kill(signal))
				this.options.onDiagnostic(`RPC child process rejected ${signal}.`);
		} catch (error) {
			this.options.onDiagnostic(`RPC child ${signal} failed: ${String(error)}`);
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			this.options.onDiagnostic(
				`Malformed RPC JSONL record: ${error instanceof Error ? error.message : String(error)}: ${line}`,
			);
			return;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			this.options.onDiagnostic(`Malformed RPC JSONL record is not an object: ${line}`);
			return;
		}
		const record = parsed as RpcRecord;
		if (record.type === "response") {
			const id = record.id;
			if (typeof id !== "string") {
				this.options.onDiagnostic("Ignored RPC response without a request id.");
				return;
			}
			const pending = this.pending.get(id);
			if (!pending) {
				this.options.onDiagnostic(`Ignored RPC response for unknown request ${id}.`);
				return;
			}
			this.pending.delete(id);
			clearTimeout(pending.timer);
			const response = record as RpcResponseRecord;
			if (response.success === false)
				pending.reject(new Error(response.error || `RPC ${String(response.command)} failed.`));
			else pending.resolve(response);
			return;
		}
		try {
			this.options.onRecord(record);
		} catch (error) {
			this.options.onDiagnostic(`RPC event handler failed: ${String(error)}`);
		}
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private finishClose(close: RpcProcessClose): void {
		if (this.closed) return;
		this.closed = true;
		this.stopReader();
		this.rejectPending(
			close.error ||
			new Error(`RPC child process closed (code=${close.code} signal=${close.signal}).`),
		);
		this.resolveClose();
		this.options.onClose(close);
	}
}
