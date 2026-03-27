import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { findUpwards, detectRustRoot } from "../registry-builders.ts";
import { createDefaultLspDefaults } from "../types.ts";
import { buildRegistry, selectEntryForFile } from "../registry.ts";
import { deepMerge, mergeEntryConfig } from "../config.ts";
import { formatMutationDiagnosticsSection } from "../diagnostics.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-test-"));
	await fn(dir);
}

test("findUpwards respects stopAt boundary", async () => {
	await withTempDir(async (dir) => {
		const stop = path.join(dir, "stop");
		const nested = path.join(stop, "a", "b");
		await mkdir(nested, { recursive: true });
		await writeFile(path.join(dir, "marker.txt"), "root");
		await writeFile(path.join(stop, "stop-marker.txt"), "stop");
		await writeFile(path.join(stop, "inside.txt"), "inside");
		const filePath = path.join(nested, "file.ts");
		await writeFile(filePath, "export const x = 1;\n");
		const found = await findUpwards(["marker.txt"], filePath, { stopAt: stop });
		assert.equal(found, undefined);
		const foundStop = await findUpwards(["stop-marker.txt"], filePath, { stopAt: stop });
		assert.equal(foundStop, stop);
	});
});

test("detectRustRoot prefers workspace Cargo.toml", async () => {
	await withTempDir(async (dir) => {
		const workspace = path.join(dir, "workspace");
		const crate = path.join(workspace, "crates", "app", "src");
		await mkdir(crate, { recursive: true });
		await writeFile(path.join(workspace, "Cargo.toml"), "[workspace]\nmembers = [\"crates/app\"]\n");
		await writeFile(path.join(workspace, "crates", "app", "Cargo.toml"), "[package]\nname = \"app\"\nversion = \"0.1.0\"\n");
		const filePath = path.join(crate, "main.rs");
		await writeFile(filePath, "fn main() {}\n");
		const root = await detectRustRoot(filePath);
		assert.equal(root, workspace);
	});
});

test("registry prefers deno over typescript in Deno projects", async () => {
	await withTempDir(async (dir) => {
		const cwd = path.join(dir, "repo");
		const src = path.join(cwd, "src");
		await mkdir(src, { recursive: true });
		await writeFile(path.join(cwd, "deno.json"), "{}\n");
		const filePath = path.join(src, "mod.ts");
		await writeFile(filePath, "export const value = 1;\n");
		const { entries } = buildRegistry({ defaults: createDefaultLspDefaults(), entries: {}, errors: [] });
		const ctx = { cwd } as any;
		const selected = await selectEntryForFile(entries, filePath, ctx);
		assert.equal(selected.entry?.id, "deno");
	});
});

test("overlay merge deep-merges nested objects and replaces arrays", () => {
	const merged = mergeEntryConfig(
		{
			command: ["base", "--stdio"],
			env: { A: "1" },
			initializationOptions: { preferences: { quoteStyle: "single" } },
			rootMarkers: ["package.json"],
		},
		{
			command: ["override", "--stdio"],
			env: { B: "2" },
			initializationOptions: { preferences: { importModuleSpecifierPreference: "relative" } },
			rootMarkers: ["tsconfig.json"],
		},
	);
	assert.deepEqual(merged.command, ["override", "--stdio"]);
	assert.deepEqual(merged.env, { A: "1", B: "2" });
	assert.deepEqual(merged.initializationOptions, {
		preferences: { quoteStyle: "single", importModuleSpecifierPreference: "relative" },
	});
	assert.deepEqual(merged.rootMarkers, ["tsconfig.json"]);
	assert.deepEqual(deepMerge({ a: { b: 1 }, list: [1, 2] }, { a: { c: 2 }, list: [3] }), {
		a: { b: 1, c: 2 },
		list: [3],
	});
});

test("diagnostic formatting caps touched file and spillover output", () => {
	const touched = Array.from({ length: 12 }, (_, index) => ({
		uri: "file:///repo/src/main.ts",
		path: "/repo/src/main.ts",
		message: `Problem ${index + 1}`,
		severity: 1,
		line: index + 1,
		character: 1,
		endLine: index + 1,
		endCharacter: 2,
		code: `E${index + 1}`,
	}));
	const spillover = new Map<string, typeof touched>();
	spillover.set("/repo/src/other.ts", touched.slice(0, 6));
	const section = formatMutationDiagnosticsSection("/repo/src/main.ts", touched, spillover as any, "/repo");
	assert.ok(section?.includes("LSP errors for src/main.ts:"));
	assert.ok(section?.includes("... 2 more error(s) omitted"));
	assert.ok(!section?.includes("LSP errors in other files:"), "spillover should not be included when touched file has errors");
	const cleanTouched: typeof touched = [];
	const spilloverOnly = formatMutationDiagnosticsSection("/repo/src/main.ts", cleanTouched, spillover as any, "/repo");
	assert.ok(spilloverOnly?.includes("LSP errors in other files:"));
	assert.ok(spilloverOnly?.includes("src/other.ts"));
	assert.ok(spilloverOnly?.includes("... 1 more error(s) omitted"));
});
