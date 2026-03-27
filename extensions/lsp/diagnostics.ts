import path from "node:path";
import { createEmptySeverityCounts, type LspPublishedDiagnostic, type LspSeverityCounts } from "./types.ts";

const DEFAULT_MAX_TOUCHED_ERRORS = 10;
const DEFAULT_MAX_SPILLOVER_FILES = 3;
const DEFAULT_MAX_SPILLOVER_ERRORS = 5;

export function countDiagnostics(diagnostics: LspPublishedDiagnostic[]): LspSeverityCounts {
	const counts = createEmptySeverityCounts();
	for (const diagnostic of diagnostics) {
		switch (diagnostic.severity) {
			case 1:
				counts.errors += 1;
				break;
			case 2:
				counts.warnings += 1;
				break;
			case 3:
				counts.infos += 1;
				break;
			default:
				counts.hints += 1;
				break;
		}
	}
	return counts;
}

export function mergeSeverityCounts(target: LspSeverityCounts, next: LspSeverityCounts): LspSeverityCounts {
	return {
		errors: target.errors + next.errors,
		warnings: target.warnings + next.warnings,
		infos: target.infos + next.infos,
		hints: target.hints + next.hints,
	};
}

export function sortDiagnostics(diagnostics: LspPublishedDiagnostic[]): LspPublishedDiagnostic[] {
	return [...diagnostics].sort(
		(a, b) =>
			a.line - b.line ||
			a.character - b.character ||
			a.endLine - b.endLine ||
			a.endCharacter - b.endCharacter ||
			a.message.localeCompare(b.message),
	);
}

export function errorDiagnostics(diagnostics: LspPublishedDiagnostic[]): LspPublishedDiagnostic[] {
	return sortDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === 1 || diagnostic.severity === undefined));
}

export function formatDiagnosticLine(diagnostic: LspPublishedDiagnostic): string {
	const meta: string[] = [];
	if (diagnostic.code) meta.push(diagnostic.code);
	if (diagnostic.source) meta.push(diagnostic.source);
	const suffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
	return `- ERROR [${diagnostic.line}:${diagnostic.character}] ${diagnostic.message}${suffix}`;
}

export function displayPath(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
	return relative;
}

export function formatMutationDiagnosticsSection(
	filePath: string,
	touchedDiagnostics: LspPublishedDiagnostic[],
	otherDiagnostics: Map<string, LspPublishedDiagnostic[]>,
	cwd: string,
): string | undefined {
	const touchedErrors = errorDiagnostics(touchedDiagnostics);
	const sections: string[] = [];
	if (touchedErrors.length > 0) {
		const shown = touchedErrors.slice(0, DEFAULT_MAX_TOUCHED_ERRORS);
		sections.push(`LSP errors for ${displayPath(filePath, cwd)}:`);
		for (const diagnostic of shown) {
			sections.push(formatDiagnosticLine(diagnostic));
		}
		if (touchedErrors.length > shown.length) {
			sections.push(`- ... ${touchedErrors.length - shown.length} more error(s) omitted`);
		}
	}

	if (touchedErrors.length === 0 && otherDiagnostics.size > 0) {
		const spilloverEntries = [...otherDiagnostics.entries()]
			.map(([otherPath, diagnostics]) => [otherPath, errorDiagnostics(diagnostics)] as const)
			.filter((entry) => entry[1].length > 0)
			.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
			.slice(0, DEFAULT_MAX_SPILLOVER_FILES);

		if (spilloverEntries.length > 0) {
			sections.push("LSP errors in other files:");
			for (const [otherPath, diagnostics] of spilloverEntries) {
				sections.push(`- ${displayPath(otherPath, cwd)}:`);
				for (const diagnostic of diagnostics.slice(0, DEFAULT_MAX_SPILLOVER_ERRORS)) {
					sections.push(`  ${formatDiagnosticLine(diagnostic).slice(2)}`);
				}
				if (diagnostics.length > DEFAULT_MAX_SPILLOVER_ERRORS) {
					sections.push(`  ... ${diagnostics.length - DEFAULT_MAX_SPILLOVER_ERRORS} more error(s) omitted`);
				}
			}
		}
	}

	return sections.length > 0 ? sections.join("\n") : undefined;
}
