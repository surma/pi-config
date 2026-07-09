import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentSource = "builtin" | "user" | "project";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryDiagnostic {
	agent: string;
	sourcePath: string;
	field: string;
	message: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	diagnostics: AgentDiscoveryDiagnostic[];
	builtinDir: string;
	userDir: string;
	projectDir: string | null;
}

const DISCOVERY_CACHE_TTL_MS = 1000;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const discoveryCache = new Map<string, { expiresAt: number; value?: AgentDiscoveryResult; promise?: Promise<AgentDiscoveryResult> }>();

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}

async function isDirectory(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

async function readAgentDirectory(
	dir: string,
	source: AgentSource,
): Promise<{ agents: AgentConfig[]; diagnostics: AgentDiscoveryDiagnostic[] }> {
	if (!(await isDirectory(dir))) return { agents: [], diagnostics: [] };

	const agents: AgentConfig[] = [];
	const diagnostics: AgentDiscoveryDiagnostic[] = [];
	let entries: Dirent[] = [];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return { agents, diagnostics };
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content = "";
		try {
			content = await fs.readFile(filePath, "utf8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		if (!name || !description) continue;

		const tools = Array.isArray(frontmatter.tools)
			? frontmatter.tools.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
			: typeof frontmatter.tools === "string"
				? frontmatter.tools
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean)
				: undefined;
		const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() || undefined : undefined;
		let thinking: ThinkingLevel | undefined;
		if (frontmatter.thinking !== undefined) {
			const rawThinking = typeof frontmatter.thinking === "string" ? frontmatter.thinking.trim() : frontmatter.thinking;
			if (isThinkingLevel(rawThinking)) {
				thinking = rawThinking;
			} else {
				diagnostics.push({
					agent: name,
					sourcePath: filePath,
					field: "thinking",
					message: `Expected one of ${Array.from(THINKING_LEVELS).join(", ")}; received ${JSON.stringify(frontmatter.thinking)}.`,
				});
			}
		}

		agents.push({
			name,
			description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model,
			thinking,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return { agents, diagnostics };
}

async function findNearestProjectDir(cwd: string): Promise<string | null> {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".pi", "subagents");
		if (await isDirectory(candidate)) return candidate;

		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

async function discoverAgentsUncached(cwd: string, extensionDir: string): Promise<AgentDiscoveryResult> {
	const builtinDir = path.join(extensionDir, "agents");
	const userDir = path.join(getAgentDir(), "subagents");
	const projectDir = await findNearestProjectDir(cwd);

	const map = new Map<string, AgentConfig>();
	const diagnostics: AgentDiscoveryDiagnostic[] = [];
	for (const source of [
		await readAgentDirectory(builtinDir, "builtin"),
		await readAgentDirectory(userDir, "user"),
		...(projectDir ? [await readAgentDirectory(projectDir, "project")] : []),
	]) {
		for (const agent of source.agents) map.set(agent.name, agent);
		diagnostics.push(...source.diagnostics);
	}

	return {
		agents: Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name)),
		diagnostics,
		builtinDir,
		userDir,
		projectDir,
	};
}

export async function discoverAgents(cwd: string, extensionDir: string): Promise<AgentDiscoveryResult> {
	const key = `${extensionDir}\u0000${cwd}`;
	const cached = discoveryCache.get(key);
	const currentTime = Date.now();
	if (cached && cached.expiresAt > currentTime) {
		if (cached.value) return cached.value;
		if (cached.promise) return cached.promise;
	}

	const promise = discoverAgentsUncached(cwd, extensionDir);
	discoveryCache.set(key, { expiresAt: currentTime + DISCOVERY_CACHE_TTL_MS, promise });
	try {
		const value = await promise;
		discoveryCache.set(key, { expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS, value });
		return value;
	} catch (error) {
		const current = discoveryCache.get(key);
		if (current?.promise === promise) discoveryCache.delete(key);
		throw error;
	}
}

export function clearAgentDiscoveryCache(): void {
	discoveryCache.clear();
}

export function formatAgentList(agents: AgentConfig[], maxItems = 12): string {
	if (agents.length === 0) return "(none)";
	const listed = agents.slice(0, maxItems).map((agent) => {
		const model = agent.model ? ` model=${agent.model}` : "";
		const thinking = agent.thinking ? ` thinking=${agent.thinking}` : "";
		const tools = agent.tools?.length ? ` tools=${agent.tools.join(",")}` : "";
		return `- ${agent.name} [${agent.source}]${model}${thinking}${tools}: ${agent.description}`;
	});
	const remaining = agents.length - listed.length;
	if (remaining > 0) listed.push(`- ... and ${remaining} more`);
	return listed.join("\n");
}
