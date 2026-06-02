/**
 * Shared, fail-safe reader for pi's compaction `reserveTokens` setting.
 *
 * pi does not expose compaction settings to extensions via the API, so we read
 * the settings file directly. This is a deliberate WORKAROUND with a known
 * limitation: it reads only the GLOBAL settings file
 * (`$PI_CODING_AGENT_DIR/settings.json` or `~/.pi/agent/settings.json`) and
 * ignores any project-level `<cwd>/.pi/settings.json` deep-merge that pi itself
 * performs. That is fine for setups without project settings; revisit if pi
 * ever surfaces `getCompactionSettings()` on `ExtensionContext`.
 *
 * NOT auto-loaded as an extension: it lives in a subdirectory with no
 * `index.ts` and no `package.json` "pi" manifest, and pi's discovery only loads
 * direct files in `extensions/` or a subdirectory's index — so this file is
 * never picked up as an extension, only imported.
 *
 * Every read fails SAFE: on a missing/unreadable/malformed file or an absent or
 * invalid value, it returns pi's documented default rather than `0`/`NaN`, so a
 * bad read degrades to "reasonable default", never to "warn at the hard limit".
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors pi's DEFAULT_COMPACTION_SETTINGS.reserveTokens (compaction.js).
const DEFAULT_RESERVE_TOKENS = 16384;

// Mirrors pi's getAgentDir(): honor PI_CODING_AGENT_DIR, else ~/.pi/agent.
function globalSettingsPath(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = envDir && envDir.length > 0 ? envDir : join(homedir(), ".pi", "agent");
	return join(agentDir, "settings.json");
}

/**
 * Read `compaction.reserveTokens` from the global settings file.
 *
 * Returns pi's default (16384) on any failure or invalid value, matching pi's
 * own fallback so the extensions and pi agree on the compaction boundary
 * (`contextTokens > contextWindow - reserveTokens`).
 */
export function readReserveTokens(path: string = globalSettingsPath()): number {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			compaction?: { reserveTokens?: unknown };
		};
		const value = parsed?.compaction?.reserveTokens;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return value;
		}
	} catch {
		// Missing / unreadable / malformed → fall through to default.
	}
	return DEFAULT_RESERVE_TOKENS;
}
