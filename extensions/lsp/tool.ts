import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { resolvePathArgument } from "./registry-builders.ts";
import type { LspCallItem, LspDocumentSymbolItem, LspHoverItem, LspLocationItem, LspServerSnapshot } from "./types.ts";
import { LspManager } from "./manager.ts";

const MAX_REFERENCES = 50;
const MAX_WORKSPACE_SYMBOLS = 20;
const MAX_DOCUMENT_SYMBOLS = 200;
const MAX_CALLS = 50;

const LspToolSchema = Type.Object({
	operation: StringEnum([
		"servers",
		"definition",
		"references",
		"hover",
		"documentSymbols",
		"workspaceSymbols",
		"implementation",
		"incomingCalls",
		"outgoingCalls",
	] as const),
	filePath: Type.Optional(Type.String({ description: "File path for file-based operations. Leading @ is ignored and relative paths resolve against ctx.cwd." })),
	line: Type.Optional(Type.Number({ minimum: 1, description: "1-based line number for location-based operations" })),
	character: Type.Optional(Type.Number({ minimum: 1, description: "1-based character number for location-based operations" })),
	serverId: Type.Optional(Type.String({ description: "Required for workspaceSymbols. Value is the running server id from lsp.servers." })),
	query: Type.Optional(Type.String({ description: "Required for workspaceSymbols." })),
});

function validateFilePath(params: { filePath?: string }, ctx: ExtensionContext): string {
	if (!params.filePath?.trim()) {
		throw new Error("filePath is required for this lsp operation.");
	}
	return resolvePathArgument(params.filePath, ctx);
}

function validatePosition(params: { line?: number; character?: number }): { line: number; character: number } {
	if (!params.line || !params.character) {
		throw new Error("line and character are required for this lsp operation.");
	}
	return { line: params.line, character: params.character };
}

function formatLocations(label: string, items: LspLocationItem[], limit?: number): { content: string; items: LspLocationItem[] } {
	const truncated = typeof limit === "number" && items.length > limit;
	const shown = typeof limit === "number" ? items.slice(0, limit) : items;
	if (shown.length === 0) {
		return { content: `No ${label} found.`, items: [] };
	}
	const lines = shown.map((item) => `${item.path}:${item.line}:${item.character}`);
	if (truncated) {
		lines.push(`... ${items.length - shown.length} more ${label} omitted`);
	}
	return {
		content: `${shown.length} ${label}${shown.length === 1 ? "" : "s"}${truncated ? ` (showing ${shown.length} of ${items.length})` : ""}\n${lines.join("\n")}`,
		items: shown,
	};
}

function formatHover(item: LspHoverItem | null): string {
	if (!item) return "No hover information available.";
	return item.plaintext.trim() || item.markdown?.trim() || "No hover information available.";
}

function formatDocumentSymbols(items: LspDocumentSymbolItem[]): { content: string; items: LspDocumentSymbolItem[] } {
	const truncated = items.length > MAX_DOCUMENT_SYMBOLS;
	const shown = items.slice(0, MAX_DOCUMENT_SYMBOLS);
	if (shown.length === 0) {
		return { content: "No document symbols found.", items: [] };
	}
	const lines = shown.map((item) => `${"  ".repeat(item.depth)}- ${item.kind} ${item.name} @ ${item.path}:${item.line}:${item.character}`);
	if (truncated) {
		lines.push(`... ${items.length - shown.length} more symbol(s) omitted`);
	}
	return {
		content: `${shown.length} document symbol${shown.length === 1 ? "" : "s"}${truncated ? ` (showing ${shown.length} of ${items.length})` : ""}\n${lines.join("\n")}`,
		items: shown,
	};
}

function formatWorkspaceSymbols(serverId: string, items: any[]): { content: string; items: any[] } {
	const truncated = items.length > MAX_WORKSPACE_SYMBOLS;
	const shown = items.slice(0, MAX_WORKSPACE_SYMBOLS);
	if (shown.length === 0) {
		return { content: `No workspace symbols found for server '${serverId}'.`, items: [] };
	}
	const lines = shown.map((item) => `${item.kind} ${item.name} @ ${item.path}:${item.line}:${item.character}`);
	if (truncated) {
		lines.push(`... ${items.length - shown.length} more symbol(s) omitted`);
	}
	return {
		content: `${shown.length} workspace symbol${shown.length === 1 ? "" : "s"} from ${serverId}${truncated ? ` (showing ${shown.length} of ${items.length})` : ""}\n${lines.join("\n")}`,
		items: shown,
	};
}

function formatCallItems(label: string, items: LspCallItem[]): { content: string; items: LspCallItem[] } {
	const truncated = items.length > MAX_CALLS;
	const shown = items.slice(0, MAX_CALLS);
	if (shown.length === 0) {
		return { content: `No ${label} found.`, items: [] };
	}
	const lines = shown.map((item) => `${item.kind} ${item.name} @ ${item.path}:${item.line}:${item.character} (${item.ranges.length} range${item.ranges.length === 1 ? "" : "s"})`);
	if (truncated) {
		lines.push(`... ${items.length - shown.length} more ${label} omitted`);
	}
	return {
		content: `${shown.length} ${label}${shown.length === 1 ? "" : "s"}${truncated ? ` (showing ${shown.length} of ${items.length})` : ""}\n${lines.join("\n")}`,
		items: shown,
	};
}

function formatServers(items: LspServerSnapshot[]): string {
	if (items.length === 0) return "No LSP clients are currently running.";
	return items
		.map((item) => {
			const cooldown = item.cooldownUntil ? ` cooldown=${item.cooldownUntil}` : "";
			const error = item.lastError ? ` error=${item.lastError}` : "";
			return `${item.id} ${item.status} root=${item.root} open=${item.openFiles} diag=${item.diagnostics.errors}/${item.diagnostics.warnings}/${item.diagnostics.infos}/${item.diagnostics.hints}${cooldown}${error}`;
		})
		.join("\n");
}

function rethrowTimeout(
	error: unknown,
	operation: string,
	filePath: string,
	line: number | undefined,
	character: number | undefined,
	entryId: string,
	root: string,
	timeoutMs: number,
): never {
	const message = error instanceof Error ? error.message : String(error);
	if (!message.includes("timed out")) {
		throw error instanceof Error ? error : new Error(message);
	}
	throw new Error(
		`LSP request timed out for ${operation} at ${filePath}${line && character ? `:${line}:${character}` : ""}.\nSelected entry: ${entryId}\nWorkspace root: ${root}\nTimeout: ${timeoutMs}ms`,
	);
}

export function registerLspTool(pi: ExtensionAPI, manager: LspManager): void {
	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description: "Semantic code navigation over installed language servers. Supports servers, definition, references, hover, documentSymbols, workspaceSymbols, implementation, incomingCalls, and outgoingCalls.",
		promptSnippet: "Use semantic LSP navigation in supported languages via the lsp tool.",
		promptGuidelines: [
			"Use lsp for semantic navigation in supported languages.",
			"Prefer definition, references, documentSymbols, and call hierarchy over text search when the task is about code structure.",
			"Use lsp.servers before workspaceSymbols when you need to choose a running server.",
			"Treat injected LSP errors after edit and write as high-signal feedback.",
			"When LSP is unavailable, fall back to read, grep, and other text-based tools.",
		],
		parameters: LspToolSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			manager.rememberContext(ctx);
			switch (params.operation) {
				case "servers": {
					const items = manager.listServers();
					return {
						content: [{ type: "text", text: formatServers(items) }],
						details: { items },
					};
				}
				case "definition":
				case "references":
				case "implementation": {
					const filePath = validateFilePath(params, ctx);
					const { line, character } = validatePosition(params);
					const prepared = await manager.prepareFileRequest(filePath, ctx);
					try {
						const method =
							params.operation === "definition"
								? "textDocument/definition"
								: params.operation === "implementation"
									? "textDocument/implementation"
									: "textDocument/references";
						const items = await manager.requestLocations(method, filePath, line, character, ctx);
						const limit = params.operation === "references" ? MAX_REFERENCES : undefined;
						const formatted = formatLocations(params.operation, items, limit);
						return {
							content: [{ type: "text", text: formatted.content }],
							details: { items: formatted.items },
						};
					} catch (error) {
						rethrowTimeout(
							error,
							params.operation,
							filePath,
							line,
							character,
							prepared.ref.entry.id,
							prepared.ref.root,
							prepared.ref.entry.requestTimeoutMs,
						);
					}
				}
				case "hover": {
					const filePath = validateFilePath(params, ctx);
					const { line, character } = validatePosition(params);
					const prepared = await manager.prepareFileRequest(filePath, ctx);
					try {
						const item = await manager.requestHover(filePath, line, character, ctx);
						return {
							content: [{ type: "text", text: formatHover(item) }],
							details: { item },
						};
					} catch (error) {
						rethrowTimeout(error, "hover", filePath, line, character, prepared.ref.entry.id, prepared.ref.root, prepared.ref.entry.requestTimeoutMs);
					}
				}
				case "documentSymbols": {
					const filePath = validateFilePath(params, ctx);
					const prepared = await manager.prepareFileRequest(filePath, ctx);
					try {
						const items = await manager.requestDocumentSymbols(filePath, ctx);
						const formatted = formatDocumentSymbols(items);
						return {
							content: [{ type: "text", text: formatted.content }],
							details: { items: formatted.items },
						};
					} catch (error) {
						rethrowTimeout(error, "documentSymbols", filePath, undefined, undefined, prepared.ref.entry.id, prepared.ref.root, prepared.ref.entry.requestTimeoutMs);
					}
				}
				case "workspaceSymbols": {
					if (!params.serverId?.trim()) {
						throw new Error("serverId is required for workspaceSymbols. Use lsp.servers first to inspect running servers.");
					}
					if (!params.query?.trim()) {
						throw new Error("query is required for workspaceSymbols.");
					}
					const prepared = await manager.getWorkspaceClient(params.serverId);
					try {
						const items = await manager.requestWorkspaceSymbols(params.serverId, params.query.trim());
						const formatted = formatWorkspaceSymbols(params.serverId, items);
						return {
							content: [{ type: "text", text: formatted.content }],
							details: { serverId: params.serverId, items: formatted.items },
						};
					} catch (error) {
						rethrowTimeout(error, "workspaceSymbols", params.serverId, undefined, undefined, prepared.ref.entry.id, prepared.ref.root, prepared.ref.entry.requestTimeoutMs);
					}
				}
				case "incomingCalls":
				case "outgoingCalls": {
					const filePath = validateFilePath(params, ctx);
					const { line, character } = validatePosition(params);
					const prepared = await manager.prepareFileRequest(filePath, ctx);
					try {
						const items = await manager.requestCallHierarchy(params.operation === "incomingCalls" ? "incoming" : "outgoing", filePath, line, character, ctx);
						const formatted = formatCallItems(params.operation, items);
						return {
							content: [{ type: "text", text: formatted.content }],
							details: { items: formatted.items },
						};
					} catch (error) {
						rethrowTimeout(error, params.operation, filePath, line, character, prepared.ref.entry.id, prepared.ref.root, prepared.ref.entry.requestTimeoutMs);
					}
				}
				default:
					throw new Error(`Unsupported lsp operation: ${params.operation}`);
			}
		},
	});
}
