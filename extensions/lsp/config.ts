import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	createDefaultLspDefaults,
	type LoadedOverlayConfig,
	type LspDefaults,
	type OverlayEntryConfig,
	type OverlayFile,
} from "./types.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
	if (Array.isArray(override)) return override as T;
	if (!isPlainObject(base) || !isPlainObject(override)) return (override as T) ?? base;
	const output: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = output[key];
		if (Array.isArray(value)) {
			output[key] = [...value];
			continue;
		}
		if (isPlainObject(current) && isPlainObject(value)) {
			output[key] = deepMerge(current, value);
			continue;
		}
		output[key] = value;
	}
	return output as T;
}

function mergeEntryConfig(base: OverlayEntryConfig | undefined, override: OverlayEntryConfig): OverlayEntryConfig {
	const merged: OverlayEntryConfig = { ...(base ?? {}) };
	for (const [key, value] of Object.entries(override) as Array<[keyof OverlayEntryConfig, OverlayEntryConfig[keyof OverlayEntryConfig]]>) {
		if (value === undefined) continue;
		if (key === "env" || key === "initializationOptions" || key === "configuration") {
			const current = merged[key];
			merged[key] = deepMerge((current ?? {}) as Record<string, unknown>, value) as never;
			continue;
		}
		if (key === "match") {
			merged.match = deepMerge((merged.match ?? {}) as Record<string, unknown>, value) as OverlayEntryConfig["match"];
			continue;
		}
		merged[key] = value;
	}
	return merged;
}

function normalizeDefaults(raw: Partial<LspDefaults> | undefined): Partial<LspDefaults> {
	if (!raw) return {};
	const result: Partial<LspDefaults> = {};
	if (typeof raw.startupTimeoutMs === "number") result.startupTimeoutMs = raw.startupTimeoutMs;
	if (typeof raw.requestTimeoutMs === "number") result.requestTimeoutMs = raw.requestTimeoutMs;
	if (typeof raw.diagnosticsWaitTimeoutMs === "number") result.diagnosticsWaitTimeoutMs = raw.diagnosticsWaitTimeoutMs;
	if (typeof raw.diagnosticsDebounceMs === "number") result.diagnosticsDebounceMs = raw.diagnosticsDebounceMs;
	if (typeof raw.cooldownMs === "number") result.cooldownMs = raw.cooldownMs;
	if (typeof raw.autoInstallViaNix === "boolean") result.autoInstallViaNix = raw.autoInstallViaNix;
	if (typeof raw.installTimeoutMs === "number") result.installTimeoutMs = raw.installTimeoutMs;
	if (typeof raw.nixFlake === "string" && raw.nixFlake.trim()) result.nixFlake = raw.nixFlake.trim();
	return result;
}

function parseOverlayObject(source: string, filePath: string): { defaults: Partial<LspDefaults>; entries: Record<string, OverlayEntryConfig>; errors: string[] } {
	const errors: string[] = [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		return { defaults: {}, entries: {}, errors: [`${filePath}: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (!isPlainObject(parsed)) {
		return { defaults: {}, entries: {}, errors: [`${filePath}: expected a top-level JSON object`] };
	}

	const defaults = normalizeDefaults(isPlainObject(parsed.defaults) ? (parsed.defaults as Partial<LspDefaults>) : undefined);
	const entries: Record<string, OverlayEntryConfig> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (key === "defaults") continue;
		if (!isPlainObject(value)) {
			errors.push(`${filePath}: entry ${key} must be an object`);
			continue;
		}
		entries[key] = value as OverlayEntryConfig;
	}
	return { defaults, entries, errors };
}

async function loadOverlayFile(filePath: string): Promise<{ defaults: Partial<LspDefaults>; entries: Record<string, OverlayEntryConfig>; errors: string[] }> {
	try {
		const content = await readFile(filePath, "utf8");
		return parseOverlayObject(content, filePath);
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return { defaults: {}, entries: {}, errors: [] };
		}
		return { defaults: {}, entries: {}, errors: [`${filePath}: ${error instanceof Error ? error.message : String(error)}`] };
	}
}

export async function loadOverlayConfig(cwd: string): Promise<LoadedOverlayConfig> {
	const defaults = createDefaultLspDefaults();
	const entries: Record<string, OverlayEntryConfig> = {};
	const errors: string[] = [];
	const globalPath = path.join(os.homedir(), ".pi", "agent", "lsp.json");
	const projectPath = path.join(cwd, ".pi", "lsp.json");

	for (const filePath of [globalPath, projectPath]) {
		const loaded = await loadOverlayFile(filePath);
		Object.assign(defaults, deepMerge(defaults, loaded.defaults));
		for (const [id, entry] of Object.entries(loaded.entries)) {
			entries[id] = mergeEntryConfig(entries[id], entry);
		}
		errors.push(...loaded.errors);
	}

	return { defaults, entries, errors };
}

export { deepMerge, mergeEntryConfig };
