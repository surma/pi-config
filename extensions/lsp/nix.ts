import { execFile } from "node:child_process";
import path from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

function execFileAsync(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				const message = [error.message, stderr?.trim()].filter(Boolean).join("\n");
				reject(new Error(message || String(error)));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function buildNixPackages(
	flake: string,
	packages: string[],
	timeoutMs: number,
	log: (message: string) => void,
): Promise<string[]> {
	if (packages.length === 0) return [];
	const specs = packages.map((pkg) => `${flake}#${pkg}`);
	log(`building missing LSP server package(s) via nix: ${packages.join(", ")} from ${flake}`);
	const { stdout } = await execFileAsync(
		"nix",
		[
			"--extra-experimental-features",
			"nix-command flakes",
			"build",
			"--print-out-paths",
			"--no-link",
			...specs,
		],
		timeoutMs,
	);
	const outputs = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	log(`built LSP server package(s) via nix: ${packages.join(", ")}`);
	return outputs;
}

export async function resolveCommandFromNixOutputs(command: string, outputs: string[]): Promise<string | undefined> {
	for (const output of outputs) {
		const candidate = path.join(output, "bin", command);
		if (await isExecutable(candidate)) return candidate;
	}
	return undefined;
}
