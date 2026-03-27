import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LspEntry, LspSpawnSpec } from "./types.ts";

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
	method: string;
};

type LspNotificationHandler = (method: string, params: any) => void;

type LspExitHandler = (reason: string) => void;

type LspLogHandler = (message: string) => void;

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
const HEADER_SEPARATOR_LF = Buffer.from("\n\n");

function createTimeout(timeoutMs: number, onTimeout: () => void): NodeJS.Timeout | undefined {
	if (!timeoutMs || timeoutMs <= 0) return undefined;
	const timer = setTimeout(() => onTimeout(), timeoutMs);
	timer.unref?.();
	return timer;
}

async function accessExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function resolveExecutable(command: string, cwd: string, env?: Record<string, string>): Promise<string | undefined> {
	if (path.isAbsolute(command)) {
		return (await accessExecutable(command)) ? command : undefined;
	}
	if (command.includes(path.sep)) {
		const resolved = path.resolve(cwd, command);
		return (await accessExecutable(resolved)) ? resolved : undefined;
	}
	const envPath = env?.PATH ?? process.env.PATH ?? "";
	for (const segment of envPath.split(path.delimiter)) {
		if (!segment) continue;
		const candidate = path.join(segment, command);
		if (await accessExecutable(candidate)) return candidate;
	}
	return undefined;
}

function formatMissingCommand(command: string, filePath?: string): Error {
	if (filePath) {
		return new Error(`command '${command}' was not found (looked for ${filePath})`);
	}
	return new Error(`command '${command}' was not found`);
}

function toRootUri(root: string): string {
	return pathToFileURL(root).toString();
}

function symbolKindValues(): number[] {
	return Array.from({ length: 26 }, (_, index) => index + 1);
}

export type LspClientOptions = {
	entry: LspEntry;
	root: string;
	spawnSpec: LspSpawnSpec;
	onNotification: LspNotificationHandler;
	onExit: LspExitHandler;
	log: LspLogHandler;
};

export class LspClient {
	readonly entry: LspEntry;
	readonly root: string;
	readonly rootUri: string;
	readonly spawnSpec: LspSpawnSpec;
	readonly log: LspLogHandler;
	stderr = "";
	initialized = false;
	closing = false;

	private process?: ChildProcessWithoutNullStreams;
	private nextRequestId = 1;
	private buffer = Buffer.alloc(0);
	private pending = new Map<number, PendingRequest>();
	private onNotification: LspNotificationHandler;
	private onExit: LspExitHandler;
	private exited = false;

	constructor(options: LspClientOptions) {
		this.entry = options.entry;
		this.root = options.root;
		this.rootUri = toRootUri(options.root);
		this.spawnSpec = options.spawnSpec;
		this.onNotification = options.onNotification;
		this.onExit = options.onExit;
		this.log = options.log;
	}

	async start(): Promise<void> {
		const command = [...this.spawnSpec.command];
		if (command.length === 0) {
			throw new Error(`No launch command configured for ${this.entry.id}`);
		}
		const spawnCwd = path.resolve(this.spawnSpec.cwd ?? this.root);
		const resolved = await resolveExecutable(command[0]!, spawnCwd, this.spawnSpec.env);
		if (!resolved) {
			throw formatMissingCommand(command[0]!);
		}
		command[0] = resolved;
		this.log(`spawn ${this.entry.id}: ${command.join(" ")} (cwd ${spawnCwd})`);
		const proc = spawn(command[0], command.slice(1), {
			cwd: spawnCwd,
			env: { ...process.env, ...this.spawnSpec.env },
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		this.process = proc;

		proc.stdout.on("data", (chunk: string) => {
			this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk, "utf8")]);
			this.drainBuffer();
		});
		proc.stderr.on("data", (chunk: string) => {
			this.stderr += chunk;
			this.log(`[${this.entry.id}] stderr ${chunk.trim()}`);
		});
		proc.on("error", (error) => {
			this.failAllPending(error instanceof Error ? error : new Error(String(error)));
			if (!this.exited) {
				this.exited = true;
				this.onExit(error instanceof Error ? error.message : String(error));
			}
		});
		proc.on("close", (code, signal) => {
			const reason = signal ? `process exited via signal ${signal}` : `process exited with code ${code ?? 0}`;
			if (!this.closing) {
				this.failAllPending(new Error(reason));
			}
			if (!this.exited) {
				this.exited = true;
				this.onExit(reason);
			}
		});
	}

	async initialize(): Promise<void> {
		if (!this.process) {
			await this.start();
		}
		const params = {
			processId: process.pid,
			clientInfo: { name: "pi-lsp-extension", version: "0.1.0" },
			rootUri: this.rootUri,
			workspaceFolders: [{ uri: this.rootUri, name: path.basename(this.root) || this.root }],
			capabilities: {
				general: { positionEncodings: ["utf-16"] },
				window: { workDoneProgress: true },
				workspace: {
					configuration: true,
					workspaceFolders: true,
					symbol: { dynamicRegistration: false, symbolKind: { valueSet: symbolKindValues() } },
					didChangeConfiguration: { dynamicRegistration: false },
				},
				textDocument: {
					synchronization: {
						dynamicRegistration: false,
						willSave: false,
						willSaveWaitUntil: false,
						didSave: false,
					},
					publishDiagnostics: {
						relatedInformation: true,
						versionSupport: true,
						codeDescriptionSupport: true,
						dataSupport: true,
					},
					definition: { dynamicRegistration: false, linkSupport: true },
					references: { dynamicRegistration: false },
					hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
					documentSymbol: {
						dynamicRegistration: false,
						hierarchicalDocumentSymbolSupport: true,
						symbolKind: { valueSet: symbolKindValues() },
					},
					implementation: { dynamicRegistration: false, linkSupport: true },
					callHierarchy: { dynamicRegistration: false },
				},
			},
			initializationOptions: this.spawnSpec.initializationOptions,
		};
		await this.request("initialize", params, this.entry.startupTimeoutMs);
		this.notify("initialized", {});
		if (this.spawnSpec.configuration !== undefined) {
			this.notify("workspace/didChangeConfiguration", { settings: this.spawnSpec.configuration });
		}
		this.initialized = true;
	}

	request(method: string, params: unknown, timeoutMs = this.entry.requestTimeoutMs): Promise<unknown> {
		if (!this.process?.stdin || this.exited) {
			return Promise.reject(new Error(`LSP client for ${this.entry.id} is not running`));
		}
		const id = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			const pending: PendingRequest = {
				resolve,
				reject,
				method,
				timer: createTimeout(timeoutMs, () => {
					this.pending.delete(id);
					reject(new Error(`LSP request timed out: ${method}`));
				}),
			};
			this.pending.set(id, pending);
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (!this.process?.stdin || this.exited) return;
		this.send({ jsonrpc: "2.0", method, params });
	}

	async shutdown(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		try {
			if (this.initialized) {
				await this.request("shutdown", null, 3_000).catch(() => undefined);
				this.notify("exit", null);
			}
		} finally {
			this.process?.kill("SIGTERM");
			setTimeout(() => {
				this.process?.kill("SIGKILL");
			}, 1_500).unref?.();
		}
	}

	private send(payload: unknown): void {
		const message = JSON.stringify(payload);
		const frame = `Content-Length: ${Buffer.byteLength(message, "utf8")}\r\n\r\n${message}`;
		this.process?.stdin.write(frame, "utf8");
	}

	private drainBuffer(): void {
		while (this.buffer.length > 0) {
			const headerIndex = this.buffer.indexOf(HEADER_SEPARATOR);
			const separatorLength = headerIndex >= 0 ? HEADER_SEPARATOR.length : this.buffer.indexOf(HEADER_SEPARATOR_LF) >= 0 ? HEADER_SEPARATOR_LF.length : -1;
			const resolvedHeaderIndex = headerIndex >= 0 ? headerIndex : this.buffer.indexOf(HEADER_SEPARATOR_LF);
			if (resolvedHeaderIndex < 0 || separatorLength < 0) return;
			const headerText = this.buffer.slice(0, resolvedHeaderIndex).toString("utf8");
			const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
			if (!contentLengthMatch) {
				this.buffer = Buffer.alloc(0);
				return;
			}
			const contentLength = Number.parseInt(contentLengthMatch[1]!, 10);
			const messageStart = resolvedHeaderIndex + separatorLength;
			const messageEnd = messageStart + contentLength;
			if (this.buffer.length < messageEnd) return;
			const json = this.buffer.slice(messageStart, messageEnd).toString("utf8");
			this.buffer = this.buffer.slice(messageEnd);
			try {
				this.handleMessage(JSON.parse(json));
			} catch (error) {
				this.log(`[${this.entry.id}] failed to parse message: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private handleMessage(message: any): void {
		if (message?.method && Object.prototype.hasOwnProperty.call(message, "id")) {
			void this.handleServerRequest(message.id, message.method, message.params);
			return;
		}
		if (message?.method) {
			this.handleNotification(message.method, message.params);
			return;
		}
		if (Object.prototype.hasOwnProperty.call(message, "id")) {
			const pending = this.pending.get(Number(message.id));
			if (!pending) return;
			this.pending.delete(Number(message.id));
			if (pending.timer) clearTimeout(pending.timer);
			if (message.error) {
				pending.reject(new Error(message.error.message || `LSP error for ${pending.method}`));
				return;
			}
			pending.resolve(message.result);
		}
	}

	private async handleServerRequest(id: number, method: string, params: any): Promise<void> {
		try {
			let result: unknown = null;
			switch (method) {
				case "workspace/configuration": {
					const items = Array.isArray(params?.items) ? params.items : [];
					result = items.map((item: any) => {
						if (this.spawnSpec.configuration === undefined) return {};
						const section = typeof item?.section === "string" ? item.section : undefined;
						if (!section) return this.spawnSpec.configuration;
						const parts = section.split(".");
						let current: any = this.spawnSpec.configuration;
						for (const part of parts) {
							current = current?.[part];
						}
						return current ?? {};
					});
					break;
				}
				case "workspace/workspaceFolders":
					result = [{ uri: this.rootUri, name: path.basename(this.root) || this.root }];
					break;
				case "client/registerCapability":
				case "client/unregisterCapability":
				case "window/workDoneProgress/create":
					result = null;
					break;
				default:
					result = null;
					break;
			}
			this.send({ jsonrpc: "2.0", id, result });
		} catch (error) {
			this.send({
				jsonrpc: "2.0",
				id,
				error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	private handleNotification(method: string, params: any): void {
		switch (method) {
			case "textDocument/publishDiagnostics":
				this.onNotification(method, params);
				return;
			case "window/logMessage":
			case "window/showMessage":
				this.log(`[${this.entry.id}] ${method}: ${params?.message ?? ""}`);
				return;
			default:
				this.onNotification(method, params);
		}
	}

	private failAllPending(error: Error): void {
		for (const [id, pending] of this.pending.entries()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
	}
}
