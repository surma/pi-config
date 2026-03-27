import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isEditToolResult, isReadToolResult, isToolCallEventType, isWriteToolResult } from "@mariozechner/pi-coding-agent";
import { LspManager } from "./manager.ts";
import { registerLspStatusCommand } from "./status.ts";
import { registerLspTool } from "./tool.ts";
import { resolvePathArgument } from "./registry-builders.ts";

function appendTextContent(content: Array<{ type: string; text?: string; [key: string]: unknown }>, extraText: string) {
	if (!extraText.trim()) return content;
	const next = [...content];
	const last = next[next.length - 1];
	if (last && last.type === "text" && typeof last.text === "string") {
		next[next.length - 1] = { ...last, text: `${last.text}\n\n${extraText}` };
		return next;
	}
	next.push({ type: "text", text: extraText });
	return next;
}

export default function lspExtension(pi: ExtensionAPI) {
	const manager = new LspManager();
	registerLspTool(pi, manager);
	registerLspStatusCommand(pi, manager);

	async function reload(ctx: ExtensionContext) {
		manager.rememberContext(ctx);
		await manager.reload(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		await reload(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await manager.shutdown();
		await reload(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		await manager.shutdown();
		await reload(ctx);
	});

	pi.on("session_shutdown", async () => {
		await manager.shutdown();
	});

	pi.on("tool_call", async (event, ctx) => {
		manager.rememberContext(ctx);
		if (!isToolCallEventType("read", event)) return;
		const rawPath = typeof event.input.path === "string" ? event.input.path : undefined;
		if (!rawPath) return;
		const filePath = resolvePathArgument(rawPath, ctx);
		await manager.warmFile(filePath, ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		manager.rememberContext(ctx);
		if (event.isError) return;

		let filePath: string | undefined;
		if (isReadToolResult(event) || isEditToolResult(event) || isWriteToolResult(event)) {
			const rawPath = typeof event.input.path === "string" ? event.input.path : undefined;
			if (!rawPath) return;
			filePath = resolvePathArgument(rawPath, ctx);
		}
		if (!filePath) return;

		if (isReadToolResult(event)) {
			await manager.warmFile(filePath, ctx);
			return;
		}

		if (isEditToolResult(event) || isWriteToolResult(event)) {
			const diagnostics = await manager.syncMutation(filePath, ctx);
			if (!diagnostics?.text) return;
			return {
				content: appendTextContent(event.content as Array<{ type: string; text?: string }>, diagnostics.text),
			};
		}
	});
}
