import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export const IPC_SCHEMA_VERSION = 1;
export const IPC_BUFFER_CAP = 256;

export type SessionReason = "startup" | "new" | "resume" | "fork" | "reload";
export type ShutdownReason = "quit" | "new" | "resume" | "fork" | "reload";
export interface IpcIdentity {
	ownerSessionFile: string;
	ownerSessionId: string;
	launchControllerInstanceId: string;
	incarnation: string;
}
export type ParentFrame = IpcIdentity &
	(
		| {
				type: "send";
				id: string;
				deliverAs: "followUp" | "steer";
				content: string | (TextContent | ImageContent)[];
		  }
		| { type: "snapshot"; id: string }
		| { type: "ping"; id: string }
	);

export interface ChildFrameBase {
	type: string;
	schemaVersion: 1;
	childId: string;
	connectionId: string;
	at: number;
	ownerSessionFile: string;
	ownerSessionId: string;
	launchControllerInstanceId: string;
	incarnation: string;
}
export interface HelloFrame extends ChildFrameBase {
	type: "hello";
	sessionId: string;
	sessionFile: string;
	sessionFileExists: boolean;
	pid: number;
	model: { provider: string; id: string; name?: string } | null;
	thinkingLevel: string;
	reason: SessionReason;
}
export interface SnapshotFrame extends ChildFrameBase {
	type: "snapshot";
	ackId?: string;
	sessionId: string;
	sessionFile: string;
	runState: "idle" | "running" | "retrying" | "finishing";
	runId: number;
	runOutcome: "pending" | "succeeded" | "failed" | "aborted";
	stopReason?: string;
	errorMessage?: string;
	currentTool?: string;
	isStreaming: boolean;
	assistantTail: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	updatedAt: number;
}
export interface EventFrame extends ChildFrameBase {
	type: "event";
	event: string;
	runId?: number;
	[key: string]: unknown;
}
export interface AckFrame extends ChildFrameBase {
	type: "ack";
	id: string;
	ok: boolean;
	queued: boolean;
	error?: string;
}
export interface ByeFrame extends ChildFrameBase {
	type: "bye";
	reason: ShutdownReason;
}
export interface PongFrame extends ChildFrameBase {
	type: "pong";
	id?: string;
}
export type ChildFrame =
	| HelloFrame
	| SnapshotFrame
	| EventFrame
	| AckFrame
	| ByeFrame
	| PongFrame;

export interface IpcConnection {
	id: string;
	childId?: string;
	childConnectionId?: string;
	ownerSessionFile?: string;
	ownerSessionId?: string;
	launchControllerInstanceId?: string;
	incarnation?: string;
	socket: net.Socket;
	send(frame: ParentFrame): void;
	close(): void;
	readonly bufferedFrames: number;
}
export interface IpcServerCallbacks {
	onHello(frame: HelloFrame, conn: IpcConnection): void;
	onSnapshot(frame: SnapshotFrame, conn: IpcConnection): void;
	onEvent(frame: EventFrame, conn: IpcConnection): void;
	onAck(frame: AckFrame, conn: IpcConnection): void;
	onBye(frame: ByeFrame, conn: IpcConnection): void;
	onPong(frame: PongFrame, conn: IpcConnection): void;
	onConnectionClose(
		conn: IpcConnection,
		hadBye: boolean,
		byeReason?: string,
	): void;
	onConnectionError(conn: IpcConnection, error: Error): void;
	onDiagnostic?(message: string): void;
}
export interface IpcServer {
	path: string;
	connections: Map<string, IpcConnection>;
	close(): Promise<void>;
}

export interface ActiveConnectionEpoch {
	parentConnectionId?: string;
	childConnectionId?: string;
}

export function frameMatchesConnectionEpoch(
	epoch: ActiveConnectionEpoch,
	frame: { connectionId: string },
	conn: Pick<IpcConnection, "id" | "childConnectionId">,
): boolean {
	return (
		epoch.parentConnectionId === conn.id &&
		epoch.childConnectionId === frame.connectionId &&
		conn.childConnectionId === frame.connectionId
	);
}

export function acknowledgementMatchesConnectionEpoch(
	epoch: ActiveConnectionEpoch,
	frame: AckFrame,
	conn: Pick<IpcConnection, "id" | "childConnectionId">,
	pending: Pick<
		ActiveConnectionEpoch,
		"parentConnectionId" | "childConnectionId"
	>,
): boolean {
	return (
		frameMatchesConnectionEpoch(epoch, frame, conn) &&
		pending.parentConnectionId === conn.id &&
		pending.childConnectionId === frame.connectionId
	);
}

export interface OwnerIncarnationEpoch {
	ownerSessionFile: string;
	ownerSessionId: string;
	launchControllerInstanceId: string;
	incarnation: string;
	parentConnectionId?: string;
	childConnectionId?: string;
}

export function frameMatchesOwnerAndIncarnation(
	epoch: OwnerIncarnationEpoch,
	frame: {
		ownerSessionFile?: string;
		ownerSessionId?: string;
		launchControllerInstanceId?: string;
		incarnation?: string;
		connectionId: string;
	},
	conn: Pick<
		IpcConnection,
		| "id"
		| "childConnectionId"
		| "ownerSessionFile"
		| "ownerSessionId"
		| "launchControllerInstanceId"
		| "incarnation"
	>,
): boolean {
	if (frame.ownerSessionFile !== epoch.ownerSessionFile) return false;
	if (frame.ownerSessionId !== epoch.ownerSessionId) return false;
	if (frame.launchControllerInstanceId !== epoch.launchControllerInstanceId)
		return false;
	if (frame.incarnation !== epoch.incarnation) return false;
	if (conn.ownerSessionFile !== epoch.ownerSessionFile) return false;
	if (conn.ownerSessionId !== epoch.ownerSessionId) return false;
	if (conn.launchControllerInstanceId !== epoch.launchControllerInstanceId)
		return false;
	if (conn.incarnation !== epoch.incarnation) return false;
	return frameMatchesConnectionEpoch(
		{
			parentConnectionId: epoch.parentConnectionId,
			childConnectionId: epoch.childConnectionId,
		},
		frame,
		conn,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function isControl(frame: unknown): boolean {
	return (
		isRecord(frame) &&
		(frame.type === "hello" || frame.type === "bye" || frame.type === "ack")
	);
}

class BufferedWriter {
	private queue: unknown[] = [];
	private draining = false;
	constructor(
		private readonly socket: net.Socket,
		private readonly diagnostic: (message: string) => void,
	) {
		socket.on("drain", () => this.flush());
	}
	get size(): number {
		return this.queue.length;
	}
	write(frame: unknown): void {
		if (this.socket.destroyed || !this.socket.writable) return;
		if (this.draining || this.socket.writableNeedDrain) {
			this.enqueue(frame);
			return;
		}
		if (!this.socket.write(`${JSON.stringify(frame)}\n`)) this.draining = true;
	}
	private enqueue(frame: unknown): void {
		if (this.queue.length >= IPC_BUFFER_CAP) {
			const droppable = this.queue.findIndex(
				(candidate) => !isControl(candidate),
			);
			if (droppable >= 0) this.queue.splice(droppable, 1);
			else if (!isControl(frame)) {
				this.diagnostic(
					"IPC backpressure buffer full; dropped non-control frame.",
				);
				return;
			} else {
				// Control frames are never dropped; the queue may briefly exceed the cap.
				this.diagnostic(
					"IPC backpressure buffer contains only control frames.",
				);
			}
		}
		this.queue.push(frame);
	}
	private flush(): void {
		this.draining = false;
		while (
			this.queue.length &&
			!this.socket.destroyed &&
			this.socket.writable
		) {
			const frame = this.queue.shift();
			if (!this.socket.write(`${JSON.stringify(frame)}\n`)) {
				this.draining = true;
				break;
			}
		}
	}
}

export function sendFrame(conn: IpcConnection, frame: ParentFrame): void {
	conn.send(frame);
}

export async function prepareIpcSocketPath(
	preferredPath: string,
	childId: string,
	fallbackRoot = process.platform === "darwin" ? "/tmp" : tmpdir(),
): Promise<string> {
	if (Buffer.byteLength(preferredPath) <= 100) return preferredPath;
	const fallbackDirectory = join(fallbackRoot, `pi-subagent-${childId}`);
	const fallbackPath = join(fallbackDirectory, "bridge.sock");
	if (Buffer.byteLength(fallbackPath) > 100) {
		throw new Error(
			`Subagent IPC fallback socket path is too long (${Buffer.byteLength(fallbackPath)} bytes): ${fallbackPath}`,
		);
	}
	await fs.mkdir(fallbackDirectory, { recursive: true, mode: 0o700 });
	await fs.chmod(fallbackDirectory, 0o700);
	return fallbackPath;
}

const sessionReasons = new Set<SessionReason>([
	"startup",
	"new",
	"resume",
	"fork",
	"reload",
]);
const shutdownReasons = new Set<ShutdownReason>([
	"quit",
	"new",
	"resume",
	"fork",
	"reload",
]);
const runStates = new Set<SnapshotFrame["runState"]>([
	"idle",
	"running",
	"retrying",
	"finishing",
]);
const runOutcomes = new Set<SnapshotFrame["runOutcome"]>([
	"pending",
	"succeeded",
	"failed",
	"aborted",
]);
const eventNames = new Set([
	"agent_start",
	"agent_end",
	"agent_settled",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"session_shutdown",
	"extension_error",
]);

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= 0;
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isUsage(value: unknown): value is SnapshotFrame["usage"] {
	if (!isRecord(value)) return false;
	return ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"].every(
		(key) => isFiniteNumber(value[key]) && Number(value[key]) >= 0,
	);
}

function isModel(value: unknown): value is HelloFrame["model"] {
	return (
		value === null ||
		(isRecord(value) &&
			typeof value.provider === "string" &&
			typeof value.id === "string" &&
			isOptionalString(value.name))
	);
}

function isHelloFrame(value: Record<string, unknown>): boolean {
	return (
		typeof value.sessionId === "string" &&
		typeof value.sessionFile === "string" &&
		typeof value.sessionFileExists === "boolean" &&
		isNonNegativeInteger(value.pid) &&
		isModel(value.model) &&
		typeof value.thinkingLevel === "string" &&
		typeof value.reason === "string" &&
		sessionReasons.has(value.reason as SessionReason)
	);
}

function isSnapshotFrame(value: Record<string, unknown>): boolean {
	return (
		typeof value.sessionId === "string" &&
		typeof value.sessionFile === "string" &&
		isOptionalString(value.ackId) &&
		typeof value.runState === "string" &&
		runStates.has(value.runState as SnapshotFrame["runState"]) &&
		isNonNegativeInteger(value.runId) &&
		typeof value.runOutcome === "string" &&
		runOutcomes.has(value.runOutcome as SnapshotFrame["runOutcome"]) &&
		isOptionalString(value.stopReason) &&
		isOptionalString(value.errorMessage) &&
		isOptionalString(value.currentTool) &&
		typeof value.isStreaming === "boolean" &&
		typeof value.assistantTail === "string" &&
		isUsage(value.usage) &&
		isFiniteNumber(value.updatedAt)
	);
}

function isEventFrame(value: Record<string, unknown>): boolean {
	if (typeof value.event !== "string" || !eventNames.has(value.event))
		return false;
	if (
		value.event !== "session_shutdown" &&
		value.event !== "extension_error" &&
		!isNonNegativeInteger(value.runId)
	) {
		return false;
	}
	switch (value.event) {
		case "agent_end":
			return (
				typeof value.willRetry === "boolean" && Array.isArray(value.messages)
			);
		case "agent_settled":
			return (
				typeof value.runOutcome === "string" &&
				runOutcomes.has(value.runOutcome as SnapshotFrame["runOutcome"]) &&
				value.runOutcome !== "pending" &&
				isOptionalString(value.stopReason) &&
				isOptionalString(value.errorMessage)
			);
		case "message_start":
		case "message_update":
		case "message_end":
			return isRecord(value.message);
		case "tool_execution_start":
			return (
				typeof value.toolCallId === "string" &&
				typeof value.toolName === "string"
			);
		case "tool_execution_update":
			return typeof value.toolCallId === "string";
		case "tool_execution_end":
			return (
				typeof value.toolCallId === "string" &&
				typeof value.toolName === "string" &&
				typeof value.isError === "boolean"
			);
		case "session_shutdown":
			return (
				typeof value.reason === "string" &&
				shutdownReasons.has(value.reason as ShutdownReason)
			);
		case "extension_error":
			return (
				typeof value.error === "string" && isOptionalString(value.extensionPath)
			);
		default:
			return true;
	}
}

export async function startIpcServer(
	socketPath: string,
	cb: IpcServerCallbacks,
): Promise<IpcServer> {
	if (Buffer.byteLength(socketPath) > 100)
		throw new Error(
			`Subagent IPC socket path is too long (${Buffer.byteLength(socketPath)} bytes): ${socketPath}`,
		);
	await fs.mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
	await fs.unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	const connections = new Map<string, IpcConnection>();
	const server = net.createServer((socket) => {
		const id = randomUUID();
		const writer = new BufferedWriter(socket, (message) =>
			cb.onDiagnostic?.(message),
		);
		let buffer = "";
		let hadBye = false;
		let byeReason: string | undefined;
		const conn: IpcConnection = {
			id,
			socket,
			send: (frame) => writer.write(frame),
			close: () => socket.destroy(),
			get bufferedFrames() {
				return writer.size;
			},
		};
		connections.set(id, conn);
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				cb.onDiagnostic?.(
					`Malformed IPC JSON: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			if (!isRecord(parsed) || typeof parsed.type !== "string") {
				cb.onDiagnostic?.("Ignored IPC frame without a known type.");
				return;
			}
			if (parsed.schemaVersion !== IPC_SCHEMA_VERSION) {
				cb.onDiagnostic?.(
					`Ignored IPC frame with unknown schemaVersion ${String(parsed.schemaVersion)}.`,
				);
				return;
			}
			if (
				typeof parsed.childId !== "string" ||
				typeof parsed.connectionId !== "string" ||
				!isFiniteNumber(parsed.at)
			) {
				cb.onDiagnostic?.("Ignored IPC frame missing childId/connectionId/at.");
				return;
			}
			if (
				typeof parsed.ownerSessionFile !== "string" ||
				typeof parsed.ownerSessionId !== "string" ||
				typeof parsed.launchControllerInstanceId !== "string" ||
				typeof parsed.incarnation !== "string"
			) {
				cb.onDiagnostic?.(
					"Ignored IPC frame missing owner or incarnation identity.",
				);
				return;
			}
			if (
				parsed.type !== "hello" &&
				(conn.childId === undefined || conn.childConnectionId === undefined)
			) {
				cb.onDiagnostic?.("Ignored IPC frame received before hello.");
				return;
			}
			if (
				(conn.childId !== undefined && conn.childId !== parsed.childId) ||
				(conn.childConnectionId !== undefined &&
					conn.childConnectionId !== parsed.connectionId) ||
				(conn.ownerSessionFile !== undefined &&
					conn.ownerSessionFile !== parsed.ownerSessionFile) ||
				(conn.ownerSessionId !== undefined &&
					conn.ownerSessionId !== parsed.ownerSessionId) ||
				(conn.launchControllerInstanceId !== undefined &&
					conn.launchControllerInstanceId !==
						parsed.launchControllerInstanceId) ||
				(conn.incarnation !== undefined &&
					conn.incarnation !== parsed.incarnation)
			) {
				cb.onDiagnostic?.(
					"Ignored IPC frame whose identity changed within one connection.",
				);
				return;
			}
			switch (parsed.type) {
				case "hello":
					if (!isHelloFrame(parsed)) {
						cb.onDiagnostic?.("Ignored malformed hello frame.");
						return;
					}
					conn.childId = parsed.childId;
					conn.childConnectionId = parsed.connectionId;
					conn.ownerSessionFile = parsed.ownerSessionFile;
					conn.ownerSessionId = parsed.ownerSessionId;
					conn.launchControllerInstanceId = parsed.launchControllerInstanceId;
					conn.incarnation = parsed.incarnation;
					cb.onHello(parsed as unknown as HelloFrame, conn);
					break;
				case "snapshot":
					if (!isSnapshotFrame(parsed)) {
						cb.onDiagnostic?.("Ignored malformed snapshot frame.");
						return;
					}
					cb.onSnapshot(parsed as unknown as SnapshotFrame, conn);
					break;
				case "event":
					if (!isEventFrame(parsed)) {
						cb.onDiagnostic?.("Ignored malformed event frame.");
						return;
					}
					cb.onEvent(parsed as unknown as EventFrame, conn);
					break;
				case "ack":
					if (
						typeof parsed.id !== "string" ||
						typeof parsed.ok !== "boolean" ||
						typeof parsed.queued !== "boolean" ||
						!isOptionalString(parsed.error)
					) {
						cb.onDiagnostic?.("Ignored malformed ack frame.");
						return;
					}
					cb.onAck(parsed as unknown as AckFrame, conn);
					break;
				case "bye":
					if (
						typeof parsed.reason !== "string" ||
						!shutdownReasons.has(parsed.reason as ShutdownReason)
					) {
						cb.onDiagnostic?.("Ignored malformed bye frame.");
						return;
					}
					hadBye = true;
					byeReason = parsed.reason;
					cb.onBye(parsed as unknown as ByeFrame, conn);
					break;
				case "pong":
					if (!isOptionalString(parsed.id)) {
						cb.onDiagnostic?.("Ignored malformed pong frame.");
						return;
					}
					cb.onPong(parsed as unknown as PongFrame, conn);
					break;
				default:
					cb.onDiagnostic?.(
						`Ignored IPC frame with unknown type ${parsed.type}.`,
					);
			}
		};
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
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
		socket.on("error", (error) => cb.onConnectionError(conn, error));
		socket.on("close", () => {
			connections.delete(id);
			cb.onConnectionClose(conn, hadBye, byeReason);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	await fs.chmod(socketPath, 0o600).catch(() => {});
	const boundSocket = await fs.lstat(socketPath).catch(() => undefined);
	return {
		path: socketPath,
		connections,
		close: async () => {
			for (const conn of connections.values()) conn.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			const currentSocket = await fs.lstat(socketPath).catch(() => undefined);
			if (
				boundSocket &&
				currentSocket &&
				boundSocket.dev === currentSocket.dev &&
				boundSocket.ino === currentSocket.ino
			) {
				await fs.unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
		},
	};
}
