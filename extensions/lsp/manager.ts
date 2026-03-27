import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatMutationDiagnosticsSection, countDiagnostics, mergeSeverityCounts } from "./diagnostics.ts";
import { buildRegistry, selectEntryForFile } from "./registry.ts";
import { loadOverlayConfig } from "./config.ts";
import { LspClient, resolveExecutable } from "./client.ts";
import { buildNixPackages, resolveCommandFromNixOutputs } from "./nix.ts";
import { LspLogSink } from "./log.ts";
import {
	createDefaultLspDefaults,
	createEmptySeverityCounts,
	type BrokenState,
	type LspEntry,
	type LspLocationItem,
	type LspPublishedDiagnostic,
	type LspServerSnapshot,
	type MutationDiagnosticsResult,
	type ResolvedClientRef,
} from "./types.ts";

type PublishedDiagnosticsState = {
	uri: string;
	path: string;
	diagnostics: LspPublishedDiagnostic[];
	updatedAt: number;
};

type ClientState = {
	key: string;
	entry: LspEntry;
	root: string;
	client: LspClient;
	diagnostics: Map<string, PublishedDiagnosticsState>;
	lastError?: string;
};

type SpawningState = {
	entry: LspEntry;
	root: string;
	promise: Promise<ClientState>;
};

type DiagnosticsWaiter = {
	resolve: () => void;
	timer?: NodeJS.Timeout;
};

type OpenDocState = {
	path: string;
	uri: string;
	clientKey: string;
	version: number;
	languageId: string;
	text: string;
	diagnosticsVersion: number;
	waiters: DiagnosticsWaiter[];
};

type SyncOptions = {
	requireMatch: boolean;
	waitForDiagnostics: boolean;
	clearTouchedDiagnostics: boolean;
};

function now(): number {
	return Date.now();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function basenameOrPath(value: string): string {
	return path.basename(value) || value;
}

function toFilePath(uri: string): string {
	if (uri.startsWith("file://")) {
		try {
			return fileURLToPath(uri);
		} catch {
			return uri;
		}
	}
	return uri;
}

function locationParams(filePath: string, line: number, character: number) {
	return {
		textDocument: { uri: pathToFileURL(filePath).toString() },
		position: { line: line - 1, character: character - 1 },
	};
}

function describeFile(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
	return relative;
}

export class LspManager {
	private entries: LspEntry[] = [];
	private clients = new Map<string, ClientState>();
	private spawning = new Map<string, SpawningState>();
	private broken = new Map<string, BrokenState>();
	private openDocs = new Map<string, OpenDocState>();
	private installingPackages = new Map<string, Promise<string[]>>();
	private builtPackageOutputs = new Map<string, string[]>();
	private latestCtx?: ExtensionContext;
	private listeners = new Set<() => void>();
	private configErrors: string[] = [];
	private readonly logSink = new LspLogSink();

	rememberContext(ctx: ExtensionContext): void {
		this.latestCtx = ctx;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notifyStateChange(): void {
		this.refreshStatus();
		for (const listener of this.listeners) listener();
	}

	private log(message: string): void {
		this.logSink.append(`[pi-lsp] ${message}`);
	}

	getLogFilePath(): string {
		return this.logSink.filePath;
	}

	async reload(ctx: ExtensionContext): Promise<void> {
		this.rememberContext(ctx);
		const overlay = await loadOverlayConfig(ctx.cwd);
		const registry = buildRegistry(overlay);
		this.entries = registry.entries;
		this.configErrors = registry.errors;
		for (const error of registry.errors) {
			this.log(error);
		}
		this.notifyStateChange();
	}

	async shutdown(): Promise<void> {
		const active = [...this.clients.values()];
		this.clients.clear();
		this.spawning.clear();
		this.openDocs.clear();
		for (const state of active) {
			await state.client.shutdown().catch(() => undefined);
		}
		await this.logSink.flush().catch(() => undefined);
		this.notifyStateChange();
	}

	async warmFile(filePath: string, ctx: ExtensionContext): Promise<void> {
		await this.syncFile(filePath, ctx, {
			requireMatch: false,
			waitForDiagnostics: false,
			clearTouchedDiagnostics: false,
		}).catch((error) => {
			this.log(`warm failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	async syncMutation(filePath: string, ctx: ExtensionContext): Promise<MutationDiagnosticsResult | undefined> {
		const synced = await this.syncFile(filePath, ctx, {
			requireMatch: false,
			waitForDiagnostics: true,
			clearTouchedDiagnostics: true,
		}).catch((error) => {
			this.log(`mutation sync failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		});
		if (!synced) return undefined;
		const client = this.clients.get(synced.key);
		if (!client) return undefined;
		const otherDiagnostics = new Map<string, LspPublishedDiagnostic[]>();
		for (const published of client.diagnostics.values()) {
			if (published.path === filePath) continue;
			otherDiagnostics.set(published.path, published.diagnostics);
		}
		const text = formatMutationDiagnosticsSection(filePath, synced.diagnostics, otherDiagnostics, ctx.cwd);
		return { text, diagnostics: synced.diagnostics };
	}

	listServers(): LspServerSnapshot[] {
		const items: LspServerSnapshot[] = [];
		for (const { entry, root } of this.spawning.values()) {
			const key = this.clientKey(entry.id, root);
			items.push({
				id: entry.id,
				serverName: entry.serverName,
				languageName: entry.languageName,
				root,
				status: "starting",
				openFiles: this.countOpenFiles(key),
				diagnostics: createEmptySeverityCounts(),
			});
		}
		for (const client of this.clients.values()) {
			let diagnostics = createEmptySeverityCounts();
			for (const published of client.diagnostics.values()) {
				diagnostics = mergeSeverityCounts(diagnostics, countDiagnostics(published.diagnostics));
			}
			items.push({
				id: client.entry.id,
				serverName: client.entry.serverName,
				languageName: client.entry.languageName,
				root: client.root,
				status: "connected",
				openFiles: this.countOpenFiles(client.key),
				diagnostics,
				lastError: client.lastError,
			});
		}
		for (const broken of this.broken.values()) {
			items.push({
				id: broken.entryId,
				serverName: broken.serverName,
				languageName: broken.languageName,
				root: broken.root,
				status: "broken",
				openFiles: this.countOpenFiles(broken.key),
				diagnostics: createEmptySeverityCounts(),
				lastError: broken.reason,
				cooldownUntil: new Date(broken.cooldownUntil).toISOString(),
			});
		}
		return items.sort((a, b) => a.id.localeCompare(b.id) || a.root.localeCompare(b.root));
	}

	getConfigErrors(): string[] {
		return [...this.configErrors];
	}

	getStatusReport(cwd: string): string {
		const lines: string[] = [];
		lines.push(`Logs: ${this.getLogFilePath()}`);
		lines.push("");
		if (this.configErrors.length > 0) {
			lines.push("Config errors:");
			for (const error of this.configErrors) lines.push(`- ${error}`);
			lines.push("");
		}
		const servers = this.listServers();
		if (servers.length === 0) {
			lines.push("No LSP clients tracked.");
			return lines.join("\n");
		}
		for (const server of servers) {
			lines.push(`${server.id}@${describeFile(server.root, cwd)} — ${server.status}`);
			lines.push(`  server: ${server.serverName}`);
			lines.push(`  open files: ${server.openFiles}`);
			lines.push(
				`  diagnostics: ${server.diagnostics.errors} error, ${server.diagnostics.warnings} warning, ${server.diagnostics.infos} info, ${server.diagnostics.hints} hint`,
			);
			if (server.lastError) lines.push(`  last error: ${server.lastError}`);
			if (server.cooldownUntil) lines.push(`  cooldown: ${server.cooldownUntil}`);
			lines.push("");
		}
		return lines.join("\n").trimEnd();
	}

	async resolveFileClient(filePath: string, ctx: ExtensionContext): Promise<{ client: LspClient; ref: ResolvedClientRef }> {
		const ref = await this.resolveClientRef(filePath, ctx, true);
		if (!ref) {
			throw new Error(`No configured LSP entry can handle file: ${describeFile(filePath, ctx.cwd)}`);
		}
		const clientState = await this.ensureClient(ref, filePath, ctx);
		return { client: clientState.client, ref };
	}

	async prepareFileRequest(filePath: string, ctx: ExtensionContext): Promise<{ client: LspClient; ref: ResolvedClientRef }> {
		const { client, ref } = await this.resolveFileClient(filePath, ctx);
		await this.syncFile(filePath, ctx, {
			requireMatch: true,
			waitForDiagnostics: false,
			clearTouchedDiagnostics: false,
		});
		return { client, ref };
	}

	async getWorkspaceClient(serverId: string): Promise<{ client: LspClient; ref: ResolvedClientRef }> {
		const matches = [...this.clients.values()].filter((client) => client.entry.id === serverId);
		if (matches.length === 0) {
			throw new Error(`No running LSP server matches id '${serverId}'. Start one by reading or editing a supported file first, or use lsp.servers to inspect active servers.`);
		}
		if (matches.length > 1) {
			const roots = matches.map((client) => client.root).join(", ");
			throw new Error(`Multiple running LSP clients match serverId '${serverId}' (${roots}). Use lsp.servers to inspect roots and narrow your next request through a file-based operation.`);
		}
		const match = matches[0]!;
		return { client: match.client, ref: { entry: match.entry, root: match.root, key: match.key } };
	}

	async requestLocations(method: string, filePath: string, line: number, character: number, ctx: ExtensionContext): Promise<LspLocationItem[]> {
		const { client } = await this.prepareFileRequest(filePath, ctx);
		const params =
			method === "textDocument/references"
				? { ...locationParams(filePath, line, character), context: { includeDeclaration: true } }
				: locationParams(filePath, line, character);
		const result = await client.request(method, params);
		return this.normalizeLocations(result);
	}

	async requestHover(filePath: string, line: number, character: number, ctx: ExtensionContext): Promise<{ plaintext: string; markdown?: string } | null> {
		const { client } = await this.prepareFileRequest(filePath, ctx);
		const result: any = await client.request("textDocument/hover", locationParams(filePath, line, character));
		if (!result?.contents) return null;
		return this.normalizeHover(result.contents);
	}

	async requestDocumentSymbols(filePath: string, ctx: ExtensionContext): Promise<any[]> {
		const { client } = await this.prepareFileRequest(filePath, ctx);
		const result = await client.request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(filePath).toString() } });
		return this.normalizeDocumentSymbols(result, filePath);
	}

	async requestWorkspaceSymbols(serverId: string, query: string): Promise<any[]> {
		const { client } = await this.getWorkspaceClient(serverId);
		const result = await client.request("workspace/symbol", { query });
		return this.normalizeWorkspaceSymbols(result);
	}

	async requestCallHierarchy(direction: "incoming" | "outgoing", filePath: string, line: number, character: number, ctx: ExtensionContext): Promise<any[]> {
		const { client } = await this.prepareFileRequest(filePath, ctx);
		const prepared: any = await client.request("textDocument/prepareCallHierarchy", locationParams(filePath, line, character));
		const item = Array.isArray(prepared) ? prepared[0] : prepared;
		if (!item) return [];
		const method = direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
		const result = await client.request(method, { item });
		return this.normalizeCallHierarchy(direction, result);
	}

	private async syncFile(filePath: string, ctx: ExtensionContext, options: SyncOptions): Promise<{ diagnostics: LspPublishedDiagnostic[]; key: string } | undefined> {
		const ref = await this.resolveClientRef(filePath, ctx, options.requireMatch);
		if (!ref) return undefined;
		const clientState = await this.ensureClient(ref, filePath, ctx);
		const text = await readFile(filePath, "utf8");
		const uri = pathToFileURL(filePath).toString();
		let doc = this.openDocs.get(filePath);
		const languageId = ref.entry.getLanguageId?.(filePath) ?? ref.entry.languageId ?? "plaintext";
		if (!doc || doc.clientKey !== ref.key) {
			doc = {
				path: filePath,
				uri,
				clientKey: ref.key,
				version: 0,
				languageId,
				text,
				diagnosticsVersion: 0,
				waiters: [],
			};
			this.openDocs.set(filePath, doc);
			clientState.client.notify("textDocument/didOpen", {
				textDocument: { uri, languageId, version: doc.version, text },
			});
		} else if (doc.text !== text) {
			doc.version += 1;
			doc.text = text;
			clientState.client.notify("textDocument/didChange", {
				textDocument: { uri, version: doc.version },
				contentChanges: [{ text }],
			});
		}
		clientState.client.notify("workspace/didChangeWatchedFiles", {
			changes: [{ uri, type: 2 }],
		});

		if (options.clearTouchedDiagnostics) {
			clientState.diagnostics.delete(uri);
		}
		if (!options.waitForDiagnostics) {
			return { diagnostics: clientState.diagnostics.get(uri)?.diagnostics ?? [], key: ref.key };
		}
		const diagnostics = await this.waitForDiagnostics(filePath, ref.entry.diagnosticsDebounceMs, ref.entry.diagnosticsWaitTimeoutMs);
		return { diagnostics, key: ref.key };
	}

	private async waitForDiagnostics(filePath: string, debounceMs: number, timeoutMs: number): Promise<LspPublishedDiagnostic[]> {
		const doc = this.openDocs.get(filePath);
		if (!doc) return [];
		const clientState = this.clients.get(doc.clientKey);
		if (!clientState) return [];
		const startVersion = doc.diagnosticsVersion;
		if (debounceMs > 0) {
			await delay(debounceMs);
		}
		if (doc.diagnosticsVersion > startVersion) {
			return clientState.diagnostics.get(doc.uri)?.diagnostics ?? [];
		}
		await new Promise<void>((resolve) => {
			const waiter: DiagnosticsWaiter = {
				resolve: () => {
					cleanup();
					resolve();
				},
				timer: setTimeout(() => {
					cleanup();
					resolve();
				}, timeoutMs),
			};
			const cleanup = () => {
				if (waiter.timer) clearTimeout(waiter.timer);
				doc.waiters = doc.waiters.filter((entry) => entry !== waiter);
			};
			doc.waiters.push(waiter);
		});
		return clientState.diagnostics.get(doc.uri)?.diagnostics ?? [];
	}

	private async resolveClientRef(filePath: string, ctx: ExtensionContext, requireMatch: boolean): Promise<ResolvedClientRef | undefined> {
		const selection = await selectEntryForFile(this.entries, filePath, ctx);
		if (selection.candidates.length > 1) {
			this.log(
				`multiple LSP matches for ${filePath}: ${selection.candidates.map((candidate) => `${candidate.id}(${candidate.priority})`).join(", ")} -> ${selection.entry?.id}`,
			);
		}
		if (!selection.entry) {
			if (!requireMatch) return undefined;
			throw new Error(
				`No configured LSP entry can handle file: ${describeFile(filePath, ctx.cwd)}\nReason: no registry entry matched this file.\nFallback: use read/grep/bash-based text search.`,
			);
		}
		const root = (await selection.entry.detectRoot(filePath, ctx)) ?? path.dirname(filePath);
		return {
			entry: selection.entry,
			root,
			key: this.clientKey(selection.entry.id, root),
		};
	}

	private async ensureClient(ref: ResolvedClientRef, filePath: string, ctx: ExtensionContext): Promise<ClientState> {
		const active = this.clients.get(ref.key);
		if (active) return active;
		const broken = this.broken.get(ref.key);
		if (broken && broken.cooldownUntil > now()) {
			throw new Error(
				`LSP temporarily unavailable for ${describeFile(filePath, ctx.cwd)}.\nSelected entry: ${ref.entry.id}\nWorkspace root: ${ref.root}\nReason: previous startup failed: ${broken.reason}\nCooldown: this client will be retried after ${new Date(broken.cooldownUntil).toISOString()}.`,
			);
		}
		const spawning = this.spawning.get(ref.key);
		if (spawning) return spawning.promise;

		const promise = (async () => {
			try {
				const spawnSpec = await ref.entry.spawn(ref.root, ctx);
				await this.ensureCommandAvailable(ref.entry, ref.root, spawnSpec);
				const client = new LspClient({
					entry: ref.entry,
					root: ref.root,
					spawnSpec,
					onNotification: (method, params) => this.handleClientNotification(ref.key, method, params),
					onExit: (reason) => this.handleClientExit(ref.key, reason),
					log: (message) => this.log(message),
				});
				await client.initialize();
				const state: ClientState = {
					key: ref.key,
					entry: ref.entry,
					root: ref.root,
					client,
					diagnostics: new Map(),
				};
				this.clients.set(ref.key, state);
				this.broken.delete(ref.key);
				this.log(`initialized ${ref.entry.id}@${ref.root}`);
				this.notifyStateChange();
				return state;
			} catch (error) {
				const reason = this.normalizeStartupError(error);
				this.markBroken(ref, reason);
				throw new Error(
					`LSP unavailable for ${describeFile(filePath, ctx.cwd)}.\nSelected entry: ${ref.entry.id}\nWorkspace root: ${ref.root}\nReason: ${reason}`,
				);
			} finally {
				this.spawning.delete(ref.key);
				this.notifyStateChange();
			}
		})();

		this.spawning.set(ref.key, { entry: ref.entry, root: ref.root, promise });
		this.notifyStateChange();
		return promise;
	}

	private async ensureCommandAvailable(entry: ResolvedClientRef["entry"], root: string, spawnSpec: { command: string[]; cwd?: string; env?: Record<string, string> }): Promise<void> {
		const command = spawnSpec.command[0];
		if (!command) return;
		const spawnCwd = path.resolve(spawnSpec.cwd ?? root);
		const resolved = await resolveExecutable(command, spawnCwd, spawnSpec.env);
		if (resolved) {
			spawnSpec.command[0] = resolved;
			return;
		}
		if (path.isAbsolute(command) || command.includes(path.sep)) {
			throw new Error(`command '${command}' was not found`);
		}
		if (!entry.autoInstallViaNix || !entry.nixPackages || entry.nixPackages.length === 0) {
			throw new Error(`command '${command}' was not found`);
		}
		let outputs: string[];
		try {
			outputs = await this.ensurePackagesBuilt(entry.nixFlake, entry.nixPackages, entry.installTimeoutMs);
		} catch (error) {
			throw new Error(`auto-build via nix failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const resolvedFromOutputs = await resolveCommandFromNixOutputs(command, outputs);
		if (!resolvedFromOutputs) {
			throw new Error(`command '${command}' was not found after building nix package(s): ${entry.nixPackages.join(", ")}`);
		}
		spawnSpec.command[0] = resolvedFromOutputs;
	}

	private async ensurePackagesBuilt(flake: string, packages: string[], timeoutMs: number): Promise<string[]> {
		const key = `${flake}::${[...packages].sort().join(",")}`;
		const cached = this.builtPackageOutputs.get(key);
		if (cached) return cached;
		const existing = this.installingPackages.get(key);
		if (existing) return existing;
		const promise = buildNixPackages(flake, packages, timeoutMs, (message) => this.log(message))
			.then((outputs) => {
				this.builtPackageOutputs.set(key, outputs);
				return outputs;
			})
			.finally(() => {
				this.installingPackages.delete(key);
				this.notifyStateChange();
			});
		this.installingPackages.set(key, promise);
		this.notifyStateChange();
		return promise;
	}

	private handleClientNotification(clientKey: string, method: string, params: any): void {
		if (method !== "textDocument/publishDiagnostics") return;
		const client = this.clients.get(clientKey);
		if (!client) return;
		const uri = String(params?.uri ?? "");
		if (!uri) return;
		const filePath = toFilePath(uri);
		const diagnostics: LspPublishedDiagnostic[] = Array.isArray(params?.diagnostics)
			? params.diagnostics.map((diagnostic: any) => ({
				uri,
				path: filePath,
				message: String(diagnostic?.message ?? ""),
				severity: typeof diagnostic?.severity === "number" ? diagnostic.severity : 1,
				line: Number(diagnostic?.range?.start?.line ?? 0) + 1,
				character: Number(diagnostic?.range?.start?.character ?? 0) + 1,
				endLine: Number(diagnostic?.range?.end?.line ?? diagnostic?.range?.start?.line ?? 0) + 1,
				endCharacter: Number(diagnostic?.range?.end?.character ?? diagnostic?.range?.start?.character ?? 0) + 1,
				code: diagnostic?.code !== undefined ? String(diagnostic.code) : undefined,
				source: typeof diagnostic?.source === "string" ? diagnostic.source : undefined,
			}))
			: [];
		client.diagnostics.set(uri, { uri, path: filePath, diagnostics, updatedAt: now() });
		const doc = this.openDocs.get(filePath);
		if (doc && doc.clientKey === clientKey && doc.uri === uri) {
			doc.diagnosticsVersion += 1;
			for (const waiter of doc.waiters.splice(0)) {
				if (waiter.timer) clearTimeout(waiter.timer);
				waiter.resolve();
			}
		}
		this.notifyStateChange();
	}

	private handleClientExit(clientKey: string, reason: string): void {
		const client = this.clients.get(clientKey);
		if (!client) return;
		this.clients.delete(clientKey);
		this.markBroken({ entry: client.entry, root: client.root, key: clientKey }, reason);
		this.notifyStateChange();
	}

	private markBroken(ref: ResolvedClientRef, reason: string): void {
		this.broken.set(ref.key, {
			key: ref.key,
			entryId: ref.entry.id,
			serverName: ref.entry.serverName,
			languageName: ref.entry.languageName,
			root: ref.root,
			reason,
			failedAt: now(),
			cooldownUntil: now() + ref.entry.cooldownMs,
		});
	}

	private normalizeStartupError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("timed out")) return "process exited before initialization completed or initialize timed out";
		return message;
	}

	private clientKey(entryId: string, root: string): string {
		return `${entryId}@${root}`;
	}

	private countOpenFiles(clientKey: string): number {
		let total = 0;
		for (const doc of this.openDocs.values()) {
			if (doc.clientKey === clientKey) total += 1;
		}
		return total;
	}

	private refreshStatus(): void {
		const ctx = this.latestCtx;
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
		const badge = theme.fg("accent", theme.bold("LSP"));
		const active = [
			...Array.from(this.spawning.values(), (value) => ({
				status: "starting" as const,
				text:
					theme.fg("warning", "◌") +
					theme.fg("accent", value.entry.id) +
					theme.fg("dim", `@${basenameOrPath(value.root)}`),
			})),
			...Array.from(this.clients.values(), (value) => ({
				status: "connected" as const,
				text:
					theme.fg("success", "●") +
					theme.fg("accent", value.entry.id) +
					theme.fg("dim", `@${basenameOrPath(value.root)}`),
			})),
		];
		if (active.length === 0) {
			if (this.broken.size > 0) {
				ctx.ui.setStatus("lsp", `${badge} ${theme.fg("error", `${this.broken.size} broken`)}`);
			} else {
				ctx.ui.setStatus("lsp", undefined);
			}
			return;
		}
		const capped = active.slice(0, 3).map((value) => value.text);
		const overflow = active.length - capped.length;
		const overflowText = overflow > 0 ? `${theme.fg("dim", " +")}${theme.fg("warning", String(overflow))}` : "";
		const installingText = this.installingPackages.size > 0 ? `${theme.fg("dim", " · ")}${theme.fg("warning", `build ${this.installingPackages.size}`)}` : "";
		const brokenText = this.broken.size > 0 ? `${theme.fg("dim", " · ")}${theme.fg("error", `${this.broken.size} broken`)}` : "";
		ctx.ui.setStatus("lsp", `${badge} ${capped.join(theme.fg("dim", " · "))}${overflowText}${installingText}${brokenText}`);
	}

	private normalizeLocation(value: any): LspLocationItem | undefined {
		const target = value?.targetUri ? { uri: value.targetUri, range: value.targetSelectionRange ?? value.targetRange } : value;
		const uri = typeof target?.uri === "string" ? target.uri : undefined;
		const range = target?.range;
		if (!uri || !range?.start) return undefined;
		return {
			path: toFilePath(uri),
			line: Number(range.start.line ?? 0) + 1,
			character: Number(range.start.character ?? 0) + 1,
			endLine: Number(range.end?.line ?? range.start.line ?? 0) + 1,
			endCharacter: Number(range.end?.character ?? range.start.character ?? 0) + 1,
		};
	}

	private normalizeLocations(result: any): LspLocationItem[] {
		const values = Array.isArray(result) ? result : result ? [result] : [];
		return values.map((value) => this.normalizeLocation(value)).filter(Boolean) as LspLocationItem[];
	}

	private normalizeHover(contents: any): { plaintext: string; markdown?: string } {
		if (typeof contents === "string") return { plaintext: contents };
		if (Array.isArray(contents)) {
			const normalized = contents.map((entry) => this.normalizeHover(entry));
			return {
				plaintext: normalized.map((entry) => entry.plaintext).filter(Boolean).join("\n\n"),
				markdown: normalized.map((entry) => entry.markdown ?? entry.plaintext).filter(Boolean).join("\n\n"),
			};
		}
		if (typeof contents?.value === "string") {
			if (contents.kind === "markdown") {
				return { plaintext: contents.value.replace(/`/g, ""), markdown: contents.value };
			}
			return { plaintext: contents.value };
		}
		if (typeof contents?.language === "string" && typeof contents?.value === "string") {
			return { plaintext: contents.value, markdown: `\`\`\`${contents.language}\n${contents.value}\n\`\`\`` };
		}
		return { plaintext: JSON.stringify(contents) };
	}

	private normalizeDocumentSymbols(result: any, filePath: string): any[] {
		const items: any[] = [];
		const visit = (symbol: any, depth: number, containerName?: string) => {
			const range = symbol.range ?? symbol.location?.range;
			if (!range?.start) return;
			items.push({
				name: String(symbol.name ?? "(anonymous)"),
				kind: this.symbolKindName(symbol.kind),
				path: symbol.location?.uri ? toFilePath(symbol.location.uri) : filePath,
				line: Number(range.start.line ?? 0) + 1,
				character: Number(range.start.character ?? 0) + 1,
				endLine: Number(range.end?.line ?? range.start.line ?? 0) + 1,
				endCharacter: Number(range.end?.character ?? range.start.character ?? 0) + 1,
				depth,
				detail: typeof symbol.detail === "string" ? symbol.detail : undefined,
				containerName,
			});
			if (Array.isArray(symbol.children)) {
				for (const child of symbol.children) visit(child, depth + 1, symbol.name);
			}
		};
		for (const symbol of Array.isArray(result) ? result : []) {
			visit(symbol, 0, symbol.containerName);
		}
		return items;
	}

	private normalizeWorkspaceSymbols(result: any): any[] {
		const items: any[] = [];
		for (const symbol of Array.isArray(result) ? result : []) {
			const location = symbol.location?.uri ? this.normalizeLocation(symbol.location) : undefined;
			if (!location) continue;
			items.push({
				name: String(symbol.name ?? "(anonymous)"),
				kind: this.symbolKindName(symbol.kind),
				path: location.path,
				line: location.line,
				character: location.character,
				containerName: typeof symbol.containerName === "string" ? symbol.containerName : undefined,
			});
		}
		return items;
	}

	private normalizeCallHierarchy(direction: "incoming" | "outgoing", result: any): any[] {
		const items: any[] = [];
		for (const entry of Array.isArray(result) ? result : []) {
			const item = direction === "incoming" ? entry.from : entry.to;
			const uri = item?.uri;
			const range = item?.selectionRange ?? item?.range;
			if (!uri || !range?.start) continue;
			const rawRanges = Array.isArray(entry.fromRanges) ? entry.fromRanges : [];
			items.push({
				name: String(item.name ?? "(anonymous)"),
				kind: this.symbolKindName(item.kind),
				path: toFilePath(uri),
				line: Number(range.start.line ?? 0) + 1,
				character: Number(range.start.character ?? 0) + 1,
				ranges: rawRanges.map((callRange: any) => ({
					line: Number(callRange.start?.line ?? 0) + 1,
					character: Number(callRange.start?.character ?? 0) + 1,
					endLine: Number(callRange.end?.line ?? callRange.start?.line ?? 0) + 1,
					endCharacter: Number(callRange.end?.character ?? callRange.start?.character ?? 0) + 1,
				})),
			});
		}
		return items;
	}

	private symbolKindName(kind: number): string {
		const names = [
			"File",
			"Module",
			"Namespace",
			"Package",
			"Class",
			"Method",
			"Property",
			"Field",
			"Constructor",
			"Enum",
			"Interface",
			"Function",
			"Variable",
			"Constant",
			"String",
			"Number",
			"Boolean",
			"Array",
			"Object",
			"Key",
			"Null",
			"EnumMember",
			"Struct",
			"Event",
			"Operator",
			"TypeParameter",
		];
		return names[(kind ?? 1) - 1] ?? `Kind${kind}`;
	}
}

export { describeFile, locationParams };
