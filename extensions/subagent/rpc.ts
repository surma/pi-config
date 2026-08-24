import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
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
	/** True only when the child emitted its operating-system close event. */
	osCloseObserved?: boolean;
	/** True when the transport fenced itself without observing operating-system close. */
	forced?: boolean;
}

/** Maximum retained bytes for one native RPC JSONL record. */
export const MAX_RPC_RECORD_BYTES = 2 * 1024 * 1024;
/** Maximum serialized size of one outbound RPC request. */
export const MAX_RPC_REQUEST_BYTES = 1 * 1024 * 1024;
/** Maximum serialized bytes retained by pending outbound RPC requests. */
export const MAX_RPC_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_WRITE_TIMEOUT_MS = 5_000;
const MAX_PENDING_REQUESTS = 128;

export interface RpcJsonlFramerOptions {
	maxRecordBytes?: number;
	onDiagnostic?: (message: string) => void;
}

function utf8Width(codePoint: number): number {
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

function boundedText(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let bytes = 0;
	let result = "";
	for (const character of value) {
		const width = utf8Width(character.codePointAt(0) ?? 0xfffd);
		if (bytes + width > maxBytes) break;
		result += character;
		bytes += width;
	}
	return result;
}

function boundedTextTail(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let index = value.length;
	let bytes = 0;
	while (index > 0) {
		let start = index - 1;
		const last = value.charCodeAt(start);
		if (
			last >= 0xdc00 &&
			last <= 0xdfff &&
			start > 0 &&
			value.charCodeAt(start - 1) >= 0xd800 &&
			value.charCodeAt(start - 1) <= 0xdbff
		)
			start--;
		const width = utf8Width(value.codePointAt(start) ?? 0xfffd);
		if (bytes + width > maxBytes) break;
		bytes += width;
		index = start;
	}
	return value.slice(index);
}

function safeDiagnostic(
	callback: ((message: string) => void) | undefined,
	message: string,
): void {
	if (!callback) return;
	try {
		callback(boundedText(message, MAX_DIAGNOSTIC_BYTES));
	} catch {
		// Diagnostics must never escape a stream or EventEmitter callback.
	}
}

function positiveTimeout(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.max(1, Math.floor(value))
		: fallback;
}

function remainingUntil(deadline: number): number {
	return Math.max(1, Math.ceil(deadline - Date.now()));
}

function abortError(reason: unknown): Error {
	const error = reason instanceof Error
		? reason
		: new Error(reason === undefined ? "The operation was aborted." : String(reason));
	error.name = "AbortError";
	return error;
}

function timeoutError(description: string): Error {
	const error = new Error(description);
	error.name = "TimeoutError";
	return error;
}

function writeWithBackpressure(
	stream: Writable,
	data: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let callbackDone = false;
		let callbackError: Error | undefined;
		let writeReturned = false;
		let needsDrain = false;
		let drainSeen = false;
		let timer: NodeJS.Timeout | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			stream.off("drain", onDrain);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve();
		};
		const maybeFinish = () => {
			if (!writeReturned || !callbackDone) return;
			if (callbackError) return finish(callbackError);
			if (needsDrain && !drainSeen) return;
			finish();
		};
		const onDrain = () => {
			drainSeen = true;
			maybeFinish();
		};
		const onAbort = () => finish(abortError(signal?.reason));
		stream.on("drain", onDrain);
		if (signal) {
			if (signal.aborted) return finish(abortError(signal.reason));
			signal.addEventListener("abort", onAbort, { once: true });
		}
		timer = setTimeout(
			() => finish(timeoutError("Timed out writing an RPC request to child stdin.")),
			timeoutMs,
		);
		timer.unref?.();
		const callback = (error?: Error | null) => {
			callbackDone = true;
			if (error) callbackError = error;
			maybeFinish();
		};
		try {
			const accepted = stream.write(data, "utf8", callback);
			needsDrain = !accepted;
			writeReturned = true;
			if (drainSeen && !needsDrain) drainSeen = true;
			maybeFinish();
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

/** Strict LF-only JSONL framing for the Pi RPC protocol. */
export class RpcJsonlFramer {
	private readonly decoder = new StringDecoder("utf8");
	private readonly maxRecordBytes: number;
	private readonly onDiagnostic?: (message: string) => void;
	private lineParts: string[] = [];
	private lineBytes = 0;
	private lineHasContent = false;
	private discardingOversizedLine = false;

	constructor(options: RpcJsonlFramerOptions = {}) {
		this.maxRecordBytes = Math.min(
			MAX_RPC_RECORD_BYTES,
			positiveTimeout(options.maxRecordBytes, MAX_RPC_RECORD_BYTES),
		);
		this.onDiagnostic = options.onDiagnostic;
	}

	push(chunk: string | Buffer): string[] {
		const decoded = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const lines: string[] = [];
		this.consume(decoded, lines);
		return lines;
	}

	/** Discards an unterminated record instead of exposing a partial RPC command. */
	finish(): string[] {
		const lines: string[] = [];
		const decoded = this.decoder.end();
		if (decoded) this.consume(decoded, lines);
		if (this.lineHasContent || this.lineParts.length || this.discardingOversizedLine) {
			if (this.discardingOversizedLine) {
				safeDiagnostic(this.onDiagnostic, "Discarded oversized unterminated RPC JSONL record.");
			} else {
				safeDiagnostic(this.onDiagnostic, "Discarded unterminated RPC JSONL record.");
			}
		}
		this.resetLine();
		return lines;
	}

	private consume(decoded: string, lines: string[]): void {
		let start = 0;
		for (;;) {
			const newline = decoded.indexOf("\n", start);
			if (newline < 0) {
				this.append(decoded.slice(start));
				return;
			}
			this.append(decoded.slice(start, newline));
			this.finishLine(lines);
			start = newline + 1;
		}
	}

	private append(segment: string): void {
		if (!segment) return;
		this.lineHasContent = true;
		if (this.discardingOversizedLine) return;
		const bytes = Buffer.byteLength(segment, "utf8");
		if (this.lineBytes + bytes > this.maxRecordBytes) {
			this.discardingOversizedLine = true;
			this.lineParts = [];
			this.lineBytes = 0;
			return;
		}
		this.lineParts.push(segment);
		this.lineBytes += bytes;
	}

	private finishLine(lines: string[]): void {
		if (this.discardingOversizedLine) {
			safeDiagnostic(
				this.onDiagnostic,
				`Discarded oversized RPC JSONL record exceeding ${this.maxRecordBytes} bytes.`,
			);
		} else if (this.lineHasContent) {
			let line = this.lineParts.join("");
			if (line.endsWith("\r")) line = line.slice(0, -1);
			lines.push(line);
		}
		this.resetLine();
	}

	private resetLine(): void {
		this.lineParts = [];
		this.lineBytes = 0;
		this.lineHasContent = false;
		this.discardingOversizedLine = false;
	}
}

export function attachRpcJsonlReader(
	stream: Readable,
	onLine: (line: string) => void,
	options: RpcJsonlFramerOptions = {},
): () => void {
	const framer = new RpcJsonlFramer(options);
	const onData = (chunk: string | Buffer) => {
		for (const line of framer.push(chunk)) {
			try {
				onLine(line);
			} catch (error) {
				safeDiagnostic(
					options.onDiagnostic,
					`RPC line handler failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	};
	const onEnd = () => {
		for (const line of framer.finish()) {
			try {
				onLine(line);
			} catch (error) {
				safeDiagnostic(
					options.onDiagnostic,
					`RPC line handler failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
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
	bytes: number;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export interface RpcChildTransportOptions {
	onRecord: (record: RpcRecord) => void;
	onDiagnostic: (message: string) => void;
	onClose: (close: RpcProcessClose) => void;
	requestTimeoutMs?: number;
	writeTimeoutMs?: number;
	maxRecordBytes?: number;
	maxRequestBytes?: number;
	maxPendingRequests?: number;
	maxPendingBytes?: number;
}

export interface RpcSendOptions {
	timeoutMs?: number;
	writeTimeoutMs?: number;
	signal?: AbortSignal;
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
		}, positiveTimeout(timeoutMs, 1));
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
	private writeChain: Promise<void> = Promise.resolve();
	private queuedWrites = 0;
	private pendingBytes = 0;
	private sigkillDelivered = false;
	private readonly writeAbortController = new AbortController();
	private readonly maxPendingRequests: number;
	private readonly maxRequestBytes: number;
	private readonly maxPendingBytes: number;

	constructor(
		readonly process: ChildProcess,
		private readonly options: RpcChildTransportOptions,
	) {
		this.maxPendingRequests = Math.min(
			MAX_PENDING_REQUESTS,
			positiveTimeout(options.maxPendingRequests, MAX_PENDING_REQUESTS),
		);
		this.maxRequestBytes = Math.min(
			MAX_RPC_REQUEST_BYTES,
			positiveTimeout(options.maxRequestBytes, MAX_RPC_REQUEST_BYTES),
		);
		this.maxPendingBytes = Math.min(
			MAX_RPC_PENDING_BYTES,
			positiveTimeout(options.maxPendingBytes, MAX_RPC_PENDING_BYTES),
		);
		this.closePromise = new Promise((resolve) => {
			this.resolveClose = resolve;
		});
		this.stopReader = process.stdout
			? attachRpcJsonlReader(
					process.stdout,
					(line) => this.handleLine(line),
					{
						maxRecordBytes: options.maxRecordBytes,
						onDiagnostic: (message) => this.safeDiagnostic(message),
					},
				)
			: () => {};
		process.stderr?.on("data", (chunk: string | Buffer) => {
			if (this.closed) return;
			const next = `${this.stderrText}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`;
			this.stderrText = boundedTextTail(next, MAX_STDERR_BYTES);
		});
		process.stdout?.on("error", (error) => {
			if (!this.closed) this.safeDiagnostic(`RPC stdout error: ${error.message}`);
		});
		process.stderr?.on("error", (error) => {
			if (!this.closed) this.safeDiagnostic(`RPC stderr error: ${error.message}`);
		});
		process.stdin?.on("error", (error) => {
			if (this.closed) return;
			this.processError = error;
			this.rejectPending(new Error(`RPC stdin error: ${error.message}`));
			this.safeDiagnostic(`RPC stdin error: ${error.message}`);
		});
		process.once("error", (error) => {
			if (this.closed) return;
			this.processError = error;
			this.rejectPending(new Error(`RPC process error: ${error.message}`));
			this.safeDiagnostic(`RPC process error: ${error.message}`);
		});
		process.once("close", (code, signal) => {
			this.finishClose({
				code,
				signal,
				error: this.processError,
				osCloseObserved: true,
				forced: false,
			});
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
		timeoutOrOptions: number | RpcSendOptions = this.options.requestTimeoutMs ?? 30_000,
		signal?: AbortSignal,
	): Promise<RpcResponseRecord> {
		if (this.closed || this.processError)
			throw this.processError || new Error("RPC child process is closed.");
		if (
			this.pending.size >= this.maxPendingRequests ||
			this.queuedWrites >= this.maxPendingRequests
		)
			throw new Error("RPC request queue is full.");
		const options =
			typeof timeoutOrOptions === "number"
				? { timeoutMs: timeoutOrOptions, signal }
				: timeoutOrOptions;
		const timeoutMs = positiveTimeout(
				options.timeoutMs,
				positiveTimeout(this.options.requestTimeoutMs, 30_000),
			);
		const writeTimeoutMs = positiveTimeout(
				options.writeTimeoutMs ?? this.options.writeTimeoutMs,
				Math.min(timeoutMs, DEFAULT_WRITE_TIMEOUT_MS),
			);
		const requestSignal = options.signal;
		if (requestSignal?.aborted) throw abortError(requestSignal.reason);
		const writeSignal = requestSignal
			? AbortSignal.any([requestSignal, this.writeAbortController.signal])
			: this.writeAbortController.signal;
		const stdin = this.process.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable)
			throw new Error("RPC child process stdin is not writable.");
		const id = `rpc-${++this.requestSequence}`;
		let encoded: string;
		try {
			encoded = `${JSON.stringify({ ...body, id })}\n`;
		} catch (error) {
			throw asError(error);
		}
		const encodedBytes = Buffer.byteLength(encoded, "utf8");
		const maxRecordBytes = Math.min(
			MAX_RPC_RECORD_BYTES,
			positiveTimeout(this.options.maxRecordBytes, MAX_RPC_RECORD_BYTES),
		);
		const maxRequestBytes = Math.min(maxRecordBytes, this.maxRequestBytes);
		if (encodedBytes > maxRequestBytes)
			throw new Error(`RPC request exceeds ${maxRequestBytes} bytes.`);
		if (this.pendingBytes + encodedBytes > this.maxPendingBytes)
			throw new Error(
				`RPC request queue is full at ${this.maxPendingBytes} pending bytes.`,
			);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.rejectRequest(id, new Error(`Timed out waiting for RPC response to ${String(body.type)}.`));
			}, timeoutMs);
			timer.unref?.();
			const pending: PendingRequest = {
				resolve,
				reject,
				timer,
				bytes: encodedBytes,
				signal: requestSignal,
			};
			if (requestSignal) {
				pending.onAbort = () =>
					this.rejectRequest(id, abortError(requestSignal.reason));
				requestSignal.addEventListener("abort", pending.onAbort, { once: true });
			}
			this.pending.set(id, pending);
			this.pendingBytes += encodedBytes;
			this.queuedWrites++;
			const deadline = Date.now() + timeoutMs;
			this.writeChain = this.writeChain
				.catch(() => {})
				.then(async () => {
					this.queuedWrites--;
					if (!this.pending.has(id)) return;
					const remaining = Math.min(writeTimeoutMs, remainingUntil(deadline));
					try {
						await writeWithBackpressure(stdin, encoded, remaining, writeSignal);
					} catch (error) {
						if ((error as Error).name === "TimeoutError") {
							this.safeDiagnostic((error as Error).message);
							try {
								stdin.destroy();
							} catch {
								// The stream may already be closed.
							}
						}
						this.rejectRequest(id, asError(error));
					}
				});
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
			}, positiveTimeout(timeoutMs, 1));
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
		const abortTimeoutMs = positiveTimeout(options.abortTimeoutMs, 1_000);
		const closeAfterAbortMs = positiveTimeout(options.closeAfterAbortMs, 250);
		const termTimeoutMs = positiveTimeout(options.termTimeoutMs, 1_500);
		const killTimeoutMs = positiveTimeout(options.killTimeoutMs, 2_500);
		if (abort) {
			await withTimeout(this.send({ type: "abort" }, abortTimeoutMs), abortTimeoutMs);
			if (await this.waitForClose(closeAfterAbortMs)) return true;
		}
		this.signal("SIGTERM");
		if (await this.waitForClose(termTimeoutMs)) return true;
		this.signal("SIGKILL");
		if (await this.waitForClose(killTimeoutMs)) return true;
		const error = new Error("RPC child process did not close after SIGKILL.");
		this.safeDiagnostic(error.message);
		this.forceClose({
			code: null,
			signal: "SIGKILL",
			error,
			osCloseObserved: false,
			forced: true,
		});
		return false;
	}

	/** Reject requests and fence callbacks when the OS close event does not arrive. */
	forceClose(close: RpcProcessClose): void {
		if (this.closed) return;
		this.finishClose({
			...close,
			osCloseObserved: false,
			forced: true,
		});
		this.trySigkill();
	}

	private signal(signal: NodeJS.Signals): void {
		if (this.closed) return;
		if (signal === "SIGKILL") {
			this.trySigkill();
			return;
		}
		try {
			if (!this.process.kill(signal))
				this.safeDiagnostic(`RPC child process rejected ${signal}.`);
		} catch (error) {
			this.safeDiagnostic(`RPC child ${signal} failed: ${String(error)}`);
		}
	}

	private trySigkill(): void {
		if (this.sigkillDelivered) return;
		const exited =
			(this.process.exitCode !== null && this.process.exitCode !== undefined) ||
			(this.process.signalCode !== null && this.process.signalCode !== undefined);
		if (exited) return;
		try {
			if (this.process.kill("SIGKILL")) {
				this.sigkillDelivered = true;
				return;
			}
			this.safeDiagnostic("RPC child process rejected SIGKILL.");
		} catch (error) {
			this.safeDiagnostic(`RPC child SIGKILL failed: ${String(error)}`);
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			this.safeDiagnostic(
				`Malformed RPC JSONL record: ${error instanceof Error ? error.message : String(error)}: ${boundedText(line, 2_048)}`,
			);
			return;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			this.safeDiagnostic(
				`Malformed RPC JSONL record is not an object: ${boundedText(line, 2_048)}`,
			);
			return;
		}
		const record = parsed as RpcRecord;
		if (record.type === "response") {
			const id = record.id;
			if (typeof id !== "string") {
				this.safeDiagnostic("Ignored RPC response without a request id.");
				return;
			}
			const pending = this.pending.get(id);
			if (!pending) {
				this.safeDiagnostic(`Ignored RPC response for unknown request ${boundedText(id, 256)}.`);
				return;
			}
			const response = record as RpcResponseRecord;
			this.removePending(id);
			if (response.success === false)
				pending.reject(new Error(response.error || `RPC ${String(response.command)} failed.`));
			else pending.resolve(response);
			return;
		}
		try {
			this.options.onRecord(record);
		} catch (error) {
			this.safeDiagnostic(`RPC event handler failed: ${String(error)}`);
		}
	}

	private removePending(id: string): PendingRequest | undefined {
		const pending = this.pending.get(id);
		if (!pending) return undefined;
		this.pending.delete(id);
		this.pendingBytes = Math.max(0, this.pendingBytes - pending.bytes);
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort)
			pending.signal.removeEventListener("abort", pending.onAbort);
		return pending;
	}

	private rejectRequest(id: string, error: Error): void {
		const pending = this.removePending(id);
		if (!pending) return;
		try {
			pending.reject(error);
		} catch {
			// Promise rejection callbacks do not belong in transport control flow.
		}
	}

	private rejectPending(error: Error): void {
		for (const id of [...this.pending.keys()]) this.rejectRequest(id, error);
	}

	private releaseTransportResources(): void {
		try {
			this.writeAbortController.abort(new Error("RPC child transport is closed."));
		} catch {
			// The close fence can already have fired during process teardown.
		}
		this.stopReader();
		for (const stream of [this.process.stdin, this.process.stdout, this.process.stderr]) {
			try {
				stream?.destroy();
			} catch {
				// A stream can close itself while the process emits close.
			}
		}
		try {
			this.process.unref?.();
		} catch {
			// Some deterministic child doubles do not implement unref safely.
		}
	}

	private safeDiagnostic(message: string): void {
		safeDiagnostic(this.options.onDiagnostic, message);
	}

	private finishClose(close: RpcProcessClose): void {
		if (this.closed) return;
		this.closed = true;
		this.releaseTransportResources();
		this.rejectPending(
			close.error ||
			new Error(`RPC child process closed (code=${close.code} signal=${close.signal}).`),
		);
		this.resolveClose();
		try {
			this.options.onClose(close);
		} catch (error) {
			this.safeDiagnostic(`RPC close handler failed: ${String(error)}`);
		}
	}
}
