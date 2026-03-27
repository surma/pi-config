import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_DIAGNOSTICS_DEBOUNCE_MS = 150;
export const DEFAULT_DIAGNOSTICS_WAIT_TIMEOUT_MS = 2_000;
export const DEFAULT_BROKEN_COOLDOWN_MS = 30_000;

export type LspToolOperation =
	| "servers"
	| "definition"
	| "references"
	| "hover"
	| "documentSymbols"
	| "workspaceSymbols"
	| "implementation"
	| "incomingCalls"
	| "outgoingCalls";

export type LspMatchSpec = {
	extensions?: string[];
	filenames?: string[];
};

export type LspEntry = {
	id: string;
	serverName: string;
	languageId?: string;
	languageName: string;
	priority: number;
	startupTimeoutMs: number;
	requestTimeoutMs: number;
	diagnosticsWaitTimeoutMs: number;
	diagnosticsDebounceMs: number;
	cooldownMs: number;
	matchSpec?: LspMatchSpec;
	rootMarkers?: string[];
	configuration?: unknown;
	initializationOptions?: unknown;
	canHandle: (filePath: string, ctx: ExtensionContext) => Promise<boolean>;
	detectRoot: (filePath: string, ctx: ExtensionContext) => Promise<string | undefined>;
	spawn: (root: string, ctx: ExtensionContext) => Promise<LspSpawnSpec>;
	getLanguageId?: (filePath: string) => string | undefined;
};

export type LspSpawnSpec = {
	command: string[];
	env?: Record<string, string>;
	cwd?: string;
	initializationOptions?: unknown;
	configuration?: unknown;
};

export type LspDefaults = {
	startupTimeoutMs: number;
	requestTimeoutMs: number;
	diagnosticsWaitTimeoutMs: number;
	diagnosticsDebounceMs: number;
	cooldownMs: number;
};

export type OverlayEntryConfig = {
	disabled?: boolean;
	priority?: number;
	languageId?: string;
	languageName?: string;
	match?: LspMatchSpec;
	command?: string[];
	env?: Record<string, string>;
	rootMarkers?: string[];
	initializationOptions?: unknown;
	configuration?: unknown;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
	diagnosticsWaitTimeoutMs?: number;
	diagnosticsDebounceMs?: number;
	cooldownMs?: number;
};

export type OverlayFile = {
	defaults?: Partial<LspDefaults>;
	[key: string]: OverlayEntryConfig | Partial<LspDefaults> | undefined;
};

export type LoadedOverlayConfig = {
	defaults: LspDefaults;
	entries: Record<string, OverlayEntryConfig>;
	errors: string[];
};

export type LspPublishedDiagnostic = {
	uri: string;
	path: string;
	message: string;
	severity: number;
	line: number;
	character: number;
	endLine: number;
	endCharacter: number;
	code?: string;
	source?: string;
};

export type LspSeverityCounts = {
	errors: number;
	warnings: number;
	infos: number;
	hints: number;
};

export type LspServerSnapshot = {
	id: string;
	serverName: string;
	languageName: string;
	root: string;
	status: "starting" | "connected" | "broken";
	openFiles: number;
	diagnostics: LspSeverityCounts;
	lastError?: string;
	cooldownUntil?: string;
};

export type LspLocationItem = {
	path: string;
	line: number;
	character: number;
	endLine?: number;
	endCharacter?: number;
};

export type LspHoverItem = {
	plaintext: string;
	markdown?: string;
};

export type LspDocumentSymbolItem = {
	name: string;
	kind: string;
	path: string;
	line: number;
	character: number;
	endLine?: number;
	endCharacter?: number;
	depth: number;
	detail?: string;
	containerName?: string;
};

export type LspCallItem = {
	name: string;
	kind: string;
	path: string;
	line: number;
	character: number;
	ranges: Array<{
		line: number;
		character: number;
		endLine: number;
		endCharacter: number;
	}>;
};

export type BrokenState = {
	key: string;
	entryId: string;
	serverName: string;
	languageName: string;
	root: string;
	reason: string;
	failedAt: number;
	cooldownUntil: number;
};

export type SyncResult = {
	entry: LspEntry;
	root: string;
	key: string;
	diagnostics: LspPublishedDiagnostic[];
};

export type MutationDiagnosticsResult = {
	text?: string;
	diagnostics: LspPublishedDiagnostic[];
};

export type ResolvedClientRef = {
	entry: LspEntry;
	root: string;
	key: string;
};

export function createDefaultLspDefaults(): LspDefaults {
	return {
		startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
		requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
		diagnosticsWaitTimeoutMs: DEFAULT_DIAGNOSTICS_WAIT_TIMEOUT_MS,
		diagnosticsDebounceMs: DEFAULT_DIAGNOSTICS_DEBOUNCE_MS,
		cooldownMs: DEFAULT_BROKEN_COOLDOWN_MS,
	};
}

export function createEmptySeverityCounts(): LspSeverityCounts {
	return { errors: 0, warnings: 0, infos: 0, hints: 0 };
}
