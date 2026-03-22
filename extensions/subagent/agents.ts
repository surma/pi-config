import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	builtinDir: string;
	userDir: string;
	projectDir: string | null;
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function readAgentDirectory(dir: string, source: AgentSource): AgentConfig[] {
	if (!isDirectory(dir)) return [];

	const agents: AgentConfig[] = [];
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content = "";
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((value) => value.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name.trim(),
			description: frontmatter.description.trim(),
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model?.trim() || undefined,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return agents;
}

function findNearestProjectDir(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".pi", "subagents");
		if (isDirectory(candidate)) return candidate;

		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function discoverAgents(cwd: string, extensionDir: string): AgentDiscoveryResult {
	const builtinDir = path.join(extensionDir, "agents");
	const userDir = path.join(getAgentDir(), "subagents");
	const projectDir = findNearestProjectDir(cwd);

	const map = new Map<string, AgentConfig>();
	for (const agent of readAgentDirectory(builtinDir, "builtin")) map.set(agent.name, agent);
	for (const agent of readAgentDirectory(userDir, "user")) map.set(agent.name, agent);
	if (projectDir) {
		for (const agent of readAgentDirectory(projectDir, "project")) map.set(agent.name, agent);
	}

	return {
		agents: Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name)),
		builtinDir,
		userDir,
		projectDir,
	};
}

export function formatAgentList(agents: AgentConfig[], maxItems = 12): string {
	if (agents.length === 0) return "(none)";
	const listed = agents.slice(0, maxItems).map((agent) => {
		const model = agent.model ? ` model=${agent.model}` : "";
		const tools = agent.tools?.length ? ` tools=${agent.tools.join(",")}` : "";
		return `- ${agent.name} [${agent.source}]${model}${tools}: ${agent.description}`;
	});
	const remaining = agents.length - listed.length;
	if (remaining > 0) listed.push(`- ... and ${remaining} more`);
	return listed.join("\n");
}
