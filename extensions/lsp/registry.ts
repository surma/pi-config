import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { deepMerge } from "./config.ts";
import {
	buildSimpleRootDetector,
	byExtensions,
	byExtensionsAndNoMarkers,
	byFilenames,
	byMatchSpec,
	detectClangdRoot,
	detectGoRoot,
	detectNixRoot,
	detectRubyRoot,
	detectRustRoot,
	detectTypeScriptRoot,
	dirnameFallback,
	findNearestMarker,
	findUpwards,
	isCommandOnPath,
} from "./registry-builders.ts";
import { type LoadedOverlayConfig, type LspDefaults, type LspEntry, type OverlayEntryConfig } from "./types.ts";

type BaseEntrySpec = {
	id: string;
	serverName: string;
	languageName: string;
	languageId?: string;
	getLanguageId?: (filePath: string) => string | undefined;
	priority: number;
	matchSpec?: { extensions?: string[]; filenames?: string[] };
	rootMarkers?: string[];
	canHandle?: (filePath: string, ctx: ExtensionContext) => Promise<boolean>;
	detectRoot?: (filePath: string, ctx: ExtensionContext) => Promise<string | undefined>;
	command?: string[];
	spawn?: (root: string, ctx: ExtensionContext, patch: OverlayEntryConfig) => Promise<{ command: string[]; env?: Record<string, string> }>;
	initializationOptions?: unknown;
	configuration?: unknown;
};

const JS_TS_DENO_MARKERS = ["deno.json", "deno.jsonc"];
const RUBY_FILENAMES = ["Gemfile", "Rakefile"];

function languageIdFromExtensions(filePath: string): string | undefined {
	switch (path.extname(filePath).toLowerCase()) {
		case ".ts":
		case ".mts":
		case ".cts":
			return "typescript";
		case ".tsx":
			return "typescriptreact";
		case ".js":
		case ".mjs":
		case ".cjs":
			return "javascript";
		case ".jsx":
			return "javascriptreact";
		default:
			return undefined;
	}
}

function applyDefaultValues(spec: BaseEntrySpec, patch: OverlayEntryConfig | undefined, defaults: LspDefaults): LspEntry {
	const mergedInitializationOptions = patch?.initializationOptions === undefined
		? spec.initializationOptions
		: deepMerge(spec.initializationOptions ?? {}, patch.initializationOptions);
	const mergedConfiguration = patch?.configuration === undefined
		? spec.configuration
		: deepMerge(spec.configuration ?? {}, patch.configuration);
	const rootMarkers = patch?.rootMarkers ?? spec.rootMarkers;
	const canHandle = patch?.match ? byMatchSpec(patch.match) : spec.canHandle ?? (spec.matchSpec ? byMatchSpec(spec.matchSpec) : async () => false);
	const detectRoot =
		typeof patch?.rootMarkers !== "undefined"
			? buildSimpleRootDetector(rootMarkers, async (filePath) => dirnameFallback(filePath))
			: spec.detectRoot ?? buildSimpleRootDetector(rootMarkers, async (filePath) => dirnameFallback(filePath));

	return {
		id: spec.id,
		serverName: spec.serverName,
		languageId: patch?.languageId ?? spec.languageId,
		languageName: patch?.languageName ?? spec.languageName,
		priority: patch?.priority ?? spec.priority,
		startupTimeoutMs: patch?.startupTimeoutMs ?? defaults.startupTimeoutMs,
		requestTimeoutMs: patch?.requestTimeoutMs ?? defaults.requestTimeoutMs,
		diagnosticsWaitTimeoutMs: patch?.diagnosticsWaitTimeoutMs ?? defaults.diagnosticsWaitTimeoutMs,
		diagnosticsDebounceMs: patch?.diagnosticsDebounceMs ?? defaults.diagnosticsDebounceMs,
		cooldownMs: patch?.cooldownMs ?? defaults.cooldownMs,
		matchSpec: patch?.match ?? spec.matchSpec,
		rootMarkers,
		initializationOptions: mergedInitializationOptions,
		configuration: mergedConfiguration,
		canHandle,
		detectRoot,
		getLanguageId: spec.getLanguageId,
		spawn: async (root, ctx) => {
			if (patch?.command) {
				return {
					command: patch.command,
					env: patch.env,
					cwd: root,
					initializationOptions: mergedInitializationOptions,
					configuration: mergedConfiguration,
				};
			}
			if (spec.spawn) {
				const spawned = await spec.spawn(root, ctx, patch ?? {});
				return {
					command: spawned.command,
					env: spawned.env,
					cwd: root,
					initializationOptions: mergedInitializationOptions,
					configuration: mergedConfiguration,
				};
			}
			return {
				command: spec.command ?? [],
				env: patch?.env,
				cwd: root,
				initializationOptions: mergedInitializationOptions,
				configuration: mergedConfiguration,
			};
		},
	};
}

function buildBuiltInSpecs(): BaseEntrySpec[] {
	return [
		{
			id: "deno",
			serverName: "Deno Language Server",
			languageName: "Deno",
			priority: 10,
			matchSpec: { extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"] },
			getLanguageId: languageIdFromExtensions,
			canHandle: async (filePath) => {
				if (!(await byExtensions([".ts", ".tsx", ".js", ".jsx", ".mjs"])(filePath))) return false;
				return Boolean(await findNearestMarker(JS_TS_DENO_MARKERS, filePath));
			},
			detectRoot: async (filePath) => (await findUpwards(JS_TS_DENO_MARKERS, filePath)) ?? dirnameFallback(filePath),
			command: ["deno", "lsp"],
		},
		{
			id: "typescript",
			serverName: "TypeScript Language Server",
			languageName: "TypeScript / JavaScript",
			priority: 20,
			matchSpec: { extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] },
			getLanguageId: languageIdFromExtensions,
			canHandle: async (filePath) =>
				byExtensionsAndNoMarkers([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"], JS_TS_DENO_MARKERS, filePath),
			detectRoot: async (filePath) => detectTypeScriptRoot(filePath),
			command: ["typescript-language-server", "--stdio"],
		},
		{
			id: "gopls",
			serverName: "gopls",
			languageName: "Go",
			languageId: "go",
			priority: 100,
			matchSpec: { extensions: [".go"] },
			detectRoot: async (filePath) => detectGoRoot(filePath),
			command: ["gopls"],
		},
		{
			id: "rust",
			serverName: "rust-analyzer",
			languageName: "Rust",
			languageId: "rust",
			priority: 101,
			matchSpec: { extensions: [".rs"] },
			detectRoot: async (filePath) => detectRustRoot(filePath),
			command: ["rust-analyzer"],
		},
		{
			id: "rubocop",
			serverName: "RuboCop LSP",
			languageName: "Ruby",
			languageId: "ruby",
			priority: 102,
			matchSpec: { extensions: [".rb", ".rake", ".gemspec", ".ru"], filenames: RUBY_FILENAMES },
			canHandle: async (filePath) => {
				if (await byExtensions([".rb", ".rake", ".gemspec", ".ru"])(filePath)) return true;
				return byFilenames(RUBY_FILENAMES)(filePath);
			},
			detectRoot: async (filePath) => detectRubyRoot(filePath),
			spawn: async (root, _ctx, patch) => {
				if (patch.command) return { command: patch.command, env: patch.env };
				const bundleAvailable = await isCommandOnPath("bundle", patch.env);
				const gemfileExists = Boolean(await findNearestMarker(["Gemfile"], path.join(root, "__placeholder__.rb"), { stopAt: root }));
				if (bundleAvailable && gemfileExists) {
					return { command: ["bundle", "exec", "rubocop", "--lsp"], env: patch.env };
				}
				return { command: ["rubocop", "--lsp"], env: patch.env };
			},
		},
		{
			id: "nixd",
			serverName: "nixd",
			languageName: "Nix",
			languageId: "nix",
			priority: 103,
			matchSpec: { extensions: [".nix"] },
			detectRoot: async (filePath) => detectNixRoot(filePath),
			command: ["nixd"],
		},
		{
			id: "bash",
			serverName: "Bash Language Server",
			languageName: "Bash",
			languageId: "shellscript",
			priority: 104,
			matchSpec: { extensions: [".sh", ".bash"] },
			command: ["bash-language-server", "start"],
		},
		{
			id: "zsh",
			serverName: "Bash Language Server",
			languageName: "Zsh",
			languageId: "shellscript",
			priority: 105,
			matchSpec: { extensions: [".zsh"] },
			command: ["bash-language-server", "start"],
		},
		{
			id: "nushell",
			serverName: "Nushell LSP",
			languageName: "Nushell",
			languageId: "nushell",
			priority: 106,
			matchSpec: { extensions: [".nu"] },
			command: ["nu", "--lsp"],
		},
		{
			id: "zig",
			serverName: "ZLS",
			languageName: "Zig",
			languageId: "zig",
			priority: 107,
			matchSpec: { extensions: [".zig", ".zon"] },
			command: ["zls"],
		},
		{
			id: "html",
			serverName: "VSCode HTML Language Server",
			languageName: "HTML",
			languageId: "html",
			priority: 108,
			matchSpec: { extensions: [".html", ".htm"] },
			command: ["vscode-html-language-server", "--stdio"],
		},
		{
			id: "css",
			serverName: "VSCode CSS Language Server",
			languageName: "CSS",
			languageId: "css",
			priority: 109,
			matchSpec: { extensions: [".css"] },
			command: ["vscode-css-language-server", "--stdio"],
		},
		{
			id: "yaml",
			serverName: "YAML Language Server",
			languageName: "YAML",
			languageId: "yaml",
			priority: 110,
			matchSpec: { extensions: [".yaml", ".yml"] },
			command: ["yaml-language-server", "--stdio"],
		},
		{
			id: "python",
			serverName: "Pyright Language Server",
			languageName: "Python",
			languageId: "python",
			priority: 111,
			matchSpec: { extensions: [".py", ".pyi"] },
			command: ["pyright-langserver", "--stdio"],
		},
		{
			id: "vue",
			serverName: "Vue Language Server",
			languageName: "Vue",
			languageId: "vue",
			priority: 112,
			matchSpec: { extensions: [".vue"] },
			command: ["vue-language-server", "--stdio"],
		},
		{
			id: "astro",
			serverName: "Astro Language Server",
			languageName: "Astro",
			languageId: "astro",
			priority: 113,
			matchSpec: { extensions: [".astro"] },
			command: ["astro-ls", "--stdio"],
		},
		{
			id: "svelte",
			serverName: "Svelte Language Server",
			languageName: "Svelte",
			languageId: "svelte",
			priority: 114,
			matchSpec: { extensions: [".svelte"] },
			command: ["svelteserver"],
		},
		{
			id: "clangd",
			serverName: "clangd",
			languageName: "C / C++",
			priority: 115,
			matchSpec: { extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"] },
			getLanguageId: (filePath) => (path.extname(filePath).toLowerCase().startsWith(".h") ? "cpp" : "cpp"),
			detectRoot: async (filePath) => detectClangdRoot(filePath),
			command: ["clangd"],
		},
	];
}

function buildCustomEntry(id: string, patch: OverlayEntryConfig, defaults: LspDefaults): LspEntry | undefined {
	if (patch.disabled) return undefined;
	if (!patch.languageName) return undefined;
	if (!patch.command || patch.command.length === 0) return undefined;
	if (!patch.match || ((!patch.match.extensions || patch.match.extensions.length === 0) && (!patch.match.filenames || patch.match.filenames.length === 0))) {
		return undefined;
	}
	const detectRoot = buildSimpleRootDetector(patch.rootMarkers, async (filePath) => dirnameFallback(filePath));
	return {
		id,
		serverName: patch.languageName,
		languageId: patch.languageId,
		languageName: patch.languageName,
		priority: patch.priority ?? 200,
		startupTimeoutMs: patch.startupTimeoutMs ?? defaults.startupTimeoutMs,
		requestTimeoutMs: patch.requestTimeoutMs ?? defaults.requestTimeoutMs,
		diagnosticsWaitTimeoutMs: patch.diagnosticsWaitTimeoutMs ?? defaults.diagnosticsWaitTimeoutMs,
		diagnosticsDebounceMs: patch.diagnosticsDebounceMs ?? defaults.diagnosticsDebounceMs,
		cooldownMs: patch.cooldownMs ?? defaults.cooldownMs,
		matchSpec: patch.match,
		rootMarkers: patch.rootMarkers,
		configuration: patch.configuration,
		initializationOptions: patch.initializationOptions,
		canHandle: byMatchSpec(patch.match),
		detectRoot,
		spawn: async (root) => ({
			command: patch.command ?? [],
			env: patch.env,
			cwd: root,
			initializationOptions: patch.initializationOptions,
			configuration: patch.configuration,
		}),
	};
}

export function buildRegistry(overlay: LoadedOverlayConfig): { entries: LspEntry[]; errors: string[] } {
	const errors = [...overlay.errors];
	const defaults = overlay.defaults;
	const specs = buildBuiltInSpecs();
	const entries: LspEntry[] = [];
	const builtInIds = new Set(specs.map((spec) => spec.id));

	for (const spec of specs) {
		const patch = overlay.entries[spec.id];
		if (patch?.disabled) continue;
		entries.push(applyDefaultValues(spec, patch, defaults));
	}

	for (const [id, patch] of Object.entries(overlay.entries)) {
		if (builtInIds.has(id)) continue;
		const customEntry = buildCustomEntry(id, patch, defaults);
		if (!customEntry) {
			errors.push(`custom LSP entry ${id}: expected languageName, match, and command`);
			continue;
		}
		entries.push(customEntry);
	}

	entries.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
	return { entries, errors };
}

export async function selectEntryForFile(
	entries: LspEntry[],
	filePath: string,
	ctx: ExtensionContext,
): Promise<{ entry?: LspEntry; candidates: LspEntry[] }> {
	const candidates: LspEntry[] = [];
	for (const entry of entries) {
		if (await entry.canHandle(filePath, ctx)) {
			candidates.push(entry);
		}
	}
	candidates.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
	return { entry: candidates[0], candidates };
}
