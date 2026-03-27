import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Focusable, type KeybindingsManager, type TUI } from "@mariozechner/pi-tui";
import { LspManager } from "./manager.ts";

class LspStatusOverlay implements Focusable {
	focused = false;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private disposeListener?: () => void;

	constructor(
		private readonly manager: LspManager,
		private readonly ctx: ExtensionCommandContext,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (value: void) => void,
	) {
		this.disposeListener = manager.subscribe(() => this.tui.requestRender());
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || data === "q") {
			this.dispose();
			this.done(undefined);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
			this.scrollBy(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
			this.scrollBy(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) {
			this.scrollBy(-(this.viewHeight || 1));
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown)) {
			this.scrollBy(this.viewHeight || 1);
			return;
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(40, Math.min(width - 2, 120));
		const rows = this.tui.terminal.rows || 24;
		const panelHeight = Math.min(Math.max(12, Math.floor(rows * 0.85)), rows - 2);
		const chrome = 6;
		const contentHeight = Math.max(1, panelHeight - chrome);
		const contentLines = this.buildContentLines(innerWidth);
		this.totalLines = contentLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		while (visible.length < contentHeight) visible.push("");
		const scrollText = this.totalLines > contentHeight
			? `${this.scrollOffset + 1}-${Math.min(this.totalLines, this.scrollOffset + contentHeight)}/${this.totalLines}`
			: `${this.totalLines}/${this.totalLines}`;
		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(this.theme.fg("accent", this.theme.bold(" LSP Status ")) + this.theme.fg("dim", " /lsp-status"), innerWidth),
			this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
			...visible.map((line) => this.frameLine(line, innerWidth)),
			this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
			this.frameLine(this.theme.fg("dim", `Esc/q close · ↑↓ scroll · PgUp/PgDn page · ${scrollText}`), innerWidth),
			this.borderLine(innerWidth, "bottom"),
		];
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}

	dispose(): void {
		this.disposeListener?.();
		this.disposeListener = undefined;
	}

	private buildContentLines(innerWidth: number): string[] {
		const lines: string[] = [];
		const configErrors = this.manager.getConfigErrors();
		const servers = this.manager.listServers();
		const counts = {
			starting: servers.filter((server) => server.status === "starting").length,
			connected: servers.filter((server) => server.status === "connected").length,
			broken: servers.filter((server) => server.status === "broken").length,
		};

		lines.push(
			this.theme.fg("accent", this.theme.bold("Summary")) +
				this.theme.fg("dim", "  ") +
				this.theme.fg("warning", `◌ ${counts.starting} starting`) +
				this.theme.fg("dim", " · ") +
				this.theme.fg("success", `● ${counts.connected} connected`) +
				this.theme.fg("dim", " · ") +
				this.theme.fg("error", `✕ ${counts.broken} broken`),
		);
		lines.push("");

		if (configErrors.length > 0) {
			lines.push(this.theme.fg("warning", this.theme.bold("Config errors")));
			for (const error of configErrors) {
				lines.push(this.theme.fg("warning", "! ") + this.theme.fg("muted", error));
			}
			lines.push("");
		}

		if (servers.length === 0) {
			lines.push(this.theme.fg("dim", "No LSP clients tracked."));
			return lines.map((line) => truncateToWidth(line, innerWidth, ""));
		}

		for (const server of servers) {
			const statusIcon =
				server.status === "connected"
					? this.theme.fg("success", "●")
					: server.status === "starting"
						? this.theme.fg("warning", "◌")
						: this.theme.fg("error", "✕");
			const statusText =
				server.status === "connected"
					? this.theme.fg("success", server.status)
					: server.status === "starting"
						? this.theme.fg("warning", server.status)
						: this.theme.fg("error", server.status);
			const relativeRoot = server.root.startsWith(`${this.ctx.cwd}/`) ? server.root.slice(this.ctx.cwd.length + 1) : server.root;
			lines.push(
				`${statusIcon} ${this.theme.fg("accent", this.theme.bold(server.id))}${this.theme.fg("dim", ` @ ${relativeRoot}`)} ${statusText}`,
			);
			lines.push(
				`${this.theme.fg("dim", "  server ")} ${this.theme.fg("text", server.serverName)}${this.theme.fg("dim", " · ")}${this.theme.fg("muted", server.languageName)}`,
			);
			lines.push(
				`${this.theme.fg("dim", "  open   ")} ${this.theme.fg("accent", String(server.openFiles))}${this.theme.fg("dim", " files")}${this.theme.fg("dim", " · diag ")}${this.theme.fg("error", String(server.diagnostics.errors))}${this.theme.fg("dim", "/")}${this.theme.fg("warning", String(server.diagnostics.warnings))}${this.theme.fg("dim", "/")}${this.theme.fg("accent", String(server.diagnostics.infos))}${this.theme.fg("dim", "/")}${this.theme.fg("muted", String(server.diagnostics.hints))}`,
			);
			if (server.lastError) {
				lines.push(`${this.theme.fg("dim", "  error  ")} ${this.theme.fg("error", server.lastError)}`);
			}
			if (server.cooldownUntil) {
				lines.push(`${this.theme.fg("dim", "  retry  ")} ${this.theme.fg("warning", server.cooldownUntil)}`);
			}
			lines.push("");
		}

		return lines.map((line) => truncateToWidth(line, innerWidth, ""));
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		const next = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
		if (next === this.scrollOffset) return;
		this.scrollOffset = next;
		this.tui.requestRender();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
	}
}

export function registerLspStatusCommand(pi: ExtensionAPI, manager: LspManager): void {
	pi.registerCommand("lsp-status", {
		description: "Show active LSP clients and diagnostics state",
		handler: async (_args, ctx) => {
			manager.rememberContext(ctx);
			if (!ctx.hasUI) {
				console.log(manager.getStatusReport(ctx.cwd));
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => new LspStatusOverlay(manager, ctx, tui, theme, keybindings, done),
				{ overlay: true },
			);
		},
	});
}
