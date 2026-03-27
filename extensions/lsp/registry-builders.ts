import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { LspMatchSpec } from "./types.ts";

const execFileAsync = (command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> =>
	new Promise((resolve, reject) => {
		execFile(command, args, { cwd }, (error, stdout, stderr) => {
			if (error) {
				reject(error);
				return;
			}
			resolve({ stdout, stderr });
		});
	});

export function normalizeExtension(filePath: string): string {
	return path.extname(filePath).toLowerCase();
}

export function normalizeFilename(filePath: string): string {
	return path.basename(filePath);
}

export function byExtensions(extensions: string[]) {
	const normalized = new Set(extensions.map((value) => value.toLowerCase()));
	return async (filePath: string) => normalized.has(normalizeExtension(filePath));
}

export function byFilenames(filenames: string[]) {
	const allowed = new Set(filenames);
	return async (filePath: string) => allowed.has(normalizeFilename(filePath));
}

export function byMatchSpec(match: LspMatchSpec) {
	const byExt = match.extensions?.length ? byExtensions(match.extensions) : undefined;
	const byName = match.filenames?.length ? byFilenames(match.filenames) : undefined;
	return async (filePath: string) => {
		if (!byExt && !byName) return false;
		if (byExt && (await byExt(filePath))) return true;
		if (byName && (await byName(filePath))) return true;
		return false;
	};
}

export async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function isReadable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

export async function detectGitRoot(filePath: string): Promise<string | undefined> {
	const cwd = path.dirname(filePath);
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
		const root = stdout.trim();
		return root ? path.resolve(root) : undefined;
	} catch {
		return undefined;
	}
}

export async function getStopBoundary(filePath: string): Promise<string> {
	const gitRoot = await detectGitRoot(filePath);
	if (gitRoot) return gitRoot;
	const home = os.homedir();
	const absolute = path.resolve(filePath);
	const relativeToHome = path.relative(home, absolute);
	if (relativeToHome && !relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)) {
		return home;
	}
	if (absolute === home) return home;
	return path.parse(absolute).root;
}

export async function findNearestMarker(
	markers: string[],
	filePath: string,
	opts?: { stopAt?: string },
): Promise<{ dir: string; marker: string } | undefined> {
	let current = path.dirname(path.resolve(filePath));
	const stopAt = path.resolve(opts?.stopAt ?? (await getStopBoundary(filePath)));

	while (true) {
		for (const marker of markers) {
			if (await exists(path.join(current, marker))) {
				return { dir: current, marker };
			}
		}
		if (current === stopAt) return undefined;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export async function findUpwards(
	markers: string[],
	filePath: string,
	opts?: { stopAt?: string },
): Promise<string | undefined> {
	const found = await findNearestMarker(markers, filePath, opts);
	return found?.dir;
}

export function dirnameFallback(filePath: string): string {
	return path.dirname(path.resolve(filePath));
}

export async function byExtensionsAndNoMarkers(extensions: string[], markers: string[], filePath: string): Promise<boolean> {
	if (!(await byExtensions(extensions)(filePath))) return false;
	const stopAt = await getStopBoundary(filePath);
	const found = await findNearestMarker(markers, filePath, { stopAt });
	return !found;
}

export function buildSimpleRootDetector(markers: string[] | undefined, fallback: (filePath: string) => Promise<string> | string) {
	return async (filePath: string) => {
		if (markers && markers.length > 0) {
			const root = await findUpwards(markers, filePath);
			if (root) return root;
		}
		return typeof fallback === "string" ? fallback : fallback(filePath);
	};
}

export async function detectTypeScriptRoot(filePath: string): Promise<string> {
	const root = await findUpwards(
		[
			"package.json",
			"tsconfig.json",
			"jsconfig.json",
			"pnpm-workspace.yaml",
			"pnpm-lock.yaml",
			"yarn.lock",
			"package-lock.json",
			"bun.lockb",
			"bun.lock",
		],
		filePath,
	);
	return root ?? dirnameFallback(filePath);
}

export async function detectGoRoot(filePath: string): Promise<string> {
	return (
		(await findUpwards(["go.work"], filePath)) ??
		(await findUpwards(["go.mod"], filePath)) ??
		dirnameFallback(filePath)
	);
}

export async function detectRubyRoot(filePath: string): Promise<string> {
	return (
		(await findUpwards(["Gemfile"], filePath)) ??
		(await findUpwards([".ruby-version"], filePath)) ??
		dirnameFallback(filePath)
	);
}

export async function detectNixRoot(filePath: string): Promise<string> {
	return (await findUpwards(["flake.nix"], filePath)) ?? (await detectGitRoot(filePath)) ?? dirnameFallback(filePath);
}

export async function detectRustRoot(filePath: string): Promise<string> {
	const stopAt = await getStopBoundary(filePath);
	const crateRoot = await findUpwards(["Cargo.toml"], filePath, { stopAt });
	if (!crateRoot) return dirnameFallback(filePath);

	let current = crateRoot;
	let workspaceRoot = crateRoot;
	while (true) {
		const cargoToml = path.join(current, "Cargo.toml");
		if (await exists(cargoToml)) {
			try {
				const content = await readFile(cargoToml, "utf8");
				if (/^\s*\[workspace\]\s*$/m.test(content)) {
					workspaceRoot = current;
				}
			} catch {
				// ignore unreadable Cargo.toml and keep walking
			}
		}
		if (current === stopAt) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return workspaceRoot;
}

export async function detectClangdRoot(filePath: string): Promise<string> {
	return (
		(await findUpwards(["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt", "Makefile"], filePath)) ??
		dirnameFallback(filePath)
	);
}

export async function isCommandOnPath(command: string, env?: Record<string, string>): Promise<boolean> {
	const envPath = env?.PATH ?? process.env.PATH ?? "";
	for (const segment of envPath.split(path.delimiter)) {
		if (!segment) continue;
		const fullPath = path.join(segment, command);
		try {
			await access(fullPath, constants.X_OK);
			return true;
		} catch {
			// continue
		}
	}
	return false;
}

export function resolvePathArgument(filePath: string, ctx: ExtensionContext): string {
	const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	return path.resolve(ctx.cwd, normalized);
}
