import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";

const SKILL_PREFIX = "skill:";

function getSkillAliases(pi: ExtensionAPI): Map<string, string> {
	const commands = pi.getCommands();
	const reservedNames = new Set(
		commands.filter((command) => command.source !== "skill").map((command) => command.name),
	);
	const aliases = new Map<string, string>();

	for (const command of commands) {
		if (command.source !== "skill" || !command.name.startsWith(SKILL_PREFIX)) continue;
		const alias = command.name.slice(SKILL_PREFIX.length);
		if (!reservedNames.has(alias)) aliases.set(alias, command.name);
	}

	return aliases;
}

function rewriteSkillAlias(text: string, aliases: ReadonlyMap<string, string>): string {
	if (!text.startsWith("/")) return text;

	const spaceIndex = text.indexOf(" ");
	const alias = text.slice(1, spaceIndex === -1 ? text.length : spaceIndex);
	const skillCommand = aliases.get(alias);
	if (!skillCommand) return text;

	const argumentsText = spaceIndex === -1 ? "" : text.slice(spaceIndex);
	return `/${skillCommand}${argumentsText}`;
}

function bareSkillItems(items: AutocompleteItem[]): AutocompleteItem[] {
	const reservedNames = new Set(
		items.filter((item) => !item.value.startsWith(SKILL_PREFIX)).map((item) => item.value),
	);
	const seen = new Set<string>();
	const result: AutocompleteItem[] = [];

	for (const item of items) {
		const isSkill = item.value.startsWith(SKILL_PREFIX);
		const value = isSkill ? item.value.slice(SKILL_PREFIX.length) : item.value;
		if ((isSkill && reservedNames.has(value)) || seen.has(value)) continue;
		seen.add(value);
		result.push(isSkill ? { ...item, value, label: value } : item);
	}

	return result;
}

function addBareSkillAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!suggestions || !suggestions.prefix.startsWith("/") || suggestions.prefix.includes(" ")) {
				return suggestions;
			}
			return { ...suggestions, items: bareSkillItems(suggestions.items) };
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
		...(current.shouldTriggerFileCompletion && {
			shouldTriggerFileCompletion: (lines: string[], cursorLine: number, cursorCol: number) =>
				current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol),
		}),
	};
}

export default function skillAliasesExtension(pi: ExtensionAPI) {
	pi.on("input", (event) => {
		const text = rewriteSkillAlias(event.text, getSkillAliases(pi));
		return text === event.text ? { action: "continue" } : { action: "transform", text };
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.addAutocompleteProvider(addBareSkillAutocomplete);
	});
}
