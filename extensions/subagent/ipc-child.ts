import net from "node:net";
import type { ChildFrame, ParentFrame } from "./ipc.js";
import { IPC_BUFFER_CAP } from "./ipc.js";

export interface BackoffSchedule {
	initialMs: number;
	maximumMs: number;
	multiplier: number;
}
export interface IpcChildConnector {
	send(frame: ChildFrame): void;
	onFrame(handler: (frame: ParentFrame) => void): void;
	onConnect(handler: (connectionId: string) => void): void;
	onClose(handler: () => void): void;
	close(): void;
	readonly connectionId: string;
}

function randomConnectionId(): string {
	return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
function validParentFrame(value: unknown): value is ParentFrame {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (
		typeof record.ownerSessionFile !== "string" ||
		typeof record.ownerSessionId !== "string" ||
		typeof record.launchControllerInstanceId !== "string" ||
		typeof record.incarnation !== "string"
	)
		return false;
	if (record.type === "send")
		return (
			typeof record.id === "string" &&
			(record.deliverAs === "followUp" || record.deliverAs === "steer") &&
			record.content !== undefined
		);
	if (record.type === "snapshot" || record.type === "ping")
		return typeof record.id === "string";
	return false;
}

export function connectChild(
	socketPath: string,
	opts: {
		backoff?: Partial<BackoffSchedule>;
		diagnostic?: (message: string) => void;
	} = {},
): IpcChildConnector {
	const ownerSessionFile = process.env.PI_SUBAGENT_OWNER_SESSION_FILE || "";
	const ownerSessionId = process.env.PI_SUBAGENT_OWNER_SESSION_ID || "";
	const launchControllerInstanceId =
		process.env.PI_SUBAGENT_CONTROLLER_INSTANCE_ID || "";
	const incarnation = process.env.PI_SUBAGENT_INCARNATION || "";
	const schedule: BackoffSchedule = {
		initialMs: 200,
		maximumMs: 3000,
		multiplier: 2,
		...opts.backoff,
	};
	const frameHandlers = new Set<(frame: ParentFrame) => void>();
	const connectHandlers = new Set<(connectionId: string) => void>();
	const closeHandlers = new Set<() => void>();
	const queued: ChildFrame[] = [];
	let socket: net.Socket | undefined;
	let stopped = false;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let delay = schedule.initialMs;
	let connectionId = randomConnectionId();
	let buffer = "";

	const frameBase = () => ({
		ownerSessionFile,
		ownerSessionId,
		launchControllerInstanceId,
		incarnation,
	});

	const diagnostic = (message: string) => opts.diagnostic?.(message);
	const enqueue = (frame: ChildFrame) => {
		if (queued.length >= IPC_BUFFER_CAP) {
			const index = queued.findIndex(
				(candidate) =>
					candidate.type !== "hello" &&
					candidate.type !== "bye" &&
					candidate.type !== "ack",
			);
			if (index >= 0) queued.splice(index, 1);
			else if (
				frame.type !== "hello" &&
				frame.type !== "bye" &&
				frame.type !== "ack"
			) {
				diagnostic("Child IPC buffer full; dropped non-control frame.");
				return;
			}
		}
		queued.push(frame);
	};
	const flush = () => {
		while (socket?.writable && !socket.writableNeedDrain && queued.length) {
			const frame = queued.shift();
			if (!frame || !socket.write(`${JSON.stringify(frame)}\n`)) break;
		}
	};
	const scheduleReconnect = () => {
		if (stopped || reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			connect();
		}, delay);
		delay = Math.min(
			schedule.maximumMs,
			Math.max(schedule.initialMs, delay * schedule.multiplier),
		);
	};
	const processLine = (line: string) => {
		if (!line.trim()) return;
		try {
			const parsed = JSON.parse(line);
			if (
				!validParentFrame(parsed) ||
				parsed.ownerSessionFile !== ownerSessionFile ||
				parsed.ownerSessionId !== ownerSessionId ||
				parsed.launchControllerInstanceId !== launchControllerInstanceId ||
				parsed.incarnation !== incarnation
			) {
				diagnostic("Ignored malformed or mismatched parent IPC frame.");
				return;
			}
			for (const handler of frameHandlers) handler(parsed);
		} catch (error) {
			diagnostic(
				`Malformed parent IPC JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	const connect = () => {
		if (stopped) return;
		connectionId = randomConnectionId();
		buffer = "";
		const next = net.createConnection(socketPath);
		socket = next;
		next.setEncoding("utf8");
		next.on("connect", () => {
			delay = schedule.initialMs;
			for (const handler of connectHandlers) handler(connectionId);
			flush();
		});
		next.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				processLine(line);
			}
		});
		next.on("drain", flush);
		next.on("error", (error: NodeJS.ErrnoException) =>
			diagnostic(`Child IPC connection error: ${error.message}`),
		);
		next.on("close", () => {
			if (socket === next) socket = undefined;
			for (const handler of closeHandlers) handler();
			scheduleReconnect();
		});
	};

	connect();
	return {
		send(frame) {
			const enriched = { ...frameBase(), ...frame } as ChildFrame;
			if (!socket?.writable || socket.writableNeedDrain) enqueue(enriched);
			else if (!socket.write(`${JSON.stringify(enriched)}\n`)) {
				/* drain will resume */
			}
		},
		onFrame(handler) {
			frameHandlers.add(handler);
		},
		onConnect(handler) {
			connectHandlers.add(handler);
		},
		onClose(handler) {
			closeHandlers.add(handler);
		},
		close() {
			stopped = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
			const closing = socket;
			socket = undefined;
			if (closing && !closing.destroyed) {
				closing.end();
				setTimeout(() => closing.destroy(), 50).unref();
			}
		},
		get connectionId() {
			return connectionId;
		},
	};
}
