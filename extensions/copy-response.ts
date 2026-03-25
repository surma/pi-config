import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

interface ResponseItem {
	entryId: string;
	text: string;
	preview: string;
	timestamp?: number;
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const textParts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
			textParts.push(part.text);
		}
	}
	return textParts.join("");
}

function getAssistantResponses(ctx: { sessionManager: { getEntries: () => Array<{ type: string; id: string; timestamp?: number; message?: { role?: string; content?: unknown } }> } }): ResponseItem[] {
	const entries = ctx.sessionManager.getEntries();
	const responses: ResponseItem[] = [];

	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const text = extractTextFromContent(entry.message.content);
			if (text.trim()) {
				// Create preview: first line, truncated
				const firstLine = text.split(/\n/)[0] ?? "";
				const preview = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
				responses.push({
					entryId: entry.id,
					text,
					preview: preview || "(empty response)",
					timestamp: entry.timestamp,
				});
			}
		}
	}

	return responses;
}

async function copyToClipboard(text: string): Promise<void> {
	const platform = process.platform;

	if (platform === "darwin") {
		// macOS
		const { stdout, stderr } = await execAsync("pbcopy", {
			input: text,
		});
		if (stderr) throw new Error(stderr);
	} else if (platform === "linux") {
		// Try wl-copy first (Wayland), then xclip (X11)
		try {
			await execAsync("wl-copy", { input: text });
		} catch {
			const { stderr } = await execAsync("xclip -selection clipboard", { input: text });
			if (stderr) throw new Error(stderr);
		}
	} else if (platform === "win32") {
		// Windows - PowerShell is more reliable than clip for unicode
		const { stderr } = await execAsync("powershell.exe -command \"Set-Clipboard -Value $input\"", { input: text });
		if (stderr) throw new Error(stderr);
	} else {
		throw new Error(`Unsupported platform: ${platform}`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("mcopy", {
		description: "Copy a previous assistant response to clipboard (/mcopy)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log("This command requires interactive UI mode");
				return;
			}

			const responses = getAssistantResponses(ctx);

			if (responses.length === 0) {
				ctx.ui.notify("No assistant responses found in this session", "warning");
				return;
			}

			// Reverse so newest is first
			const reversed = [...responses].reverse();

			const items: SelectItem[] = reversed.map((r, index) => ({
				value: r.entryId,
				label: `${reversed.length - index}. ${r.preview}`,
				description: `${r.text.length} chars`,
			}));

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();

				// Top border
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				// Title
				container.addChild(new Text(theme.fg("accent", theme.bold("Select response to copy")), 1, 0));
				container.addChild(new Text(theme.fg("dim", `${responses.length} response(s) available`), 1, 0));

				// SelectList with theme
				const selectList = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});
				selectList.onSelect = (item) => done(item.value as string);
				selectList.onCancel = () => done(null);
				container.addChild(selectList);

				// Help text
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter copy • esc cancel"), 1, 0));

				// Bottom border
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});

			if (!result) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Find the selected response
			const selected = responses.find((r) => r.entryId === result);
			if (!selected) {
				ctx.ui.notify("Response not found", "error");
				return;
			}

			// Copy to clipboard
			try {
				await copyToClipboard(selected.text);
				ctx.ui.notify(`Copied ${selected.text.length} characters to clipboard`, "success");
			} catch (err) {
				ctx.ui.notify(`Failed to copy: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
