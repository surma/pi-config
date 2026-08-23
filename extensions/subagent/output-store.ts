import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CallerOutputRequest {
	/** The exact file path selected by the caller. Omit it to skip output. */
	path?: string;
	/** The exact text to write. An empty string creates an empty output file. */
	content: string;
}

export type OutputStatus =
	| "not_requested"
	| "pending"
	| "written"
	| "collision"
	| "failed";

export type OutputWriteStatus = Exclude<OutputStatus, "pending">;

export type OutputWriteResult =
	| { status: "not_requested" }
	| { status: "written"; path: string }
	| { status: "collision"; path: string }
	| { status: "failed"; path: string; error: string };

function temporaryName(): string {
	return `.pi-output.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function removeTemporary(path: string): Promise<void> {
	await fs.unlink(path).catch(() => {});
}

/**
 * Writes caller-selected output without replacing an earlier deliverable.
 *
 * An omitted path returns `not_requested` and touches no filesystem path. A
 * supplied path creates missing parent directories, then publishes the exact
 * content as a mode-0600 file. An existing path returns `collision`, including
 * a path that appears during a concurrent write. Other filesystem errors return
 * `failed`. The writer writes a same-directory temporary file, syncs it, and
 * publishes it with an exclusive hard link, so a published file is complete.
 */
export async function writeCallerOutput(
	request: CallerOutputRequest,
): Promise<OutputWriteResult> {
	if (request.path === undefined) return { status: "not_requested" };
	const path = typeof request.path === "string" ? request.path : "";
	if (!path) {
		return {
			status: "failed",
			path,
			error: "The caller output path must be a non-empty string.",
		};
	}
	if (typeof request.content !== "string") {
		return {
			status: "failed",
			path,
			error: "The caller output content must be a string.",
		};
	}

	const parent = dirname(path);
	try {
		await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	} catch (error) {
		return { status: "failed", path, error: errorMessage(error) };
	}

	try {
		await fs.lstat(path);
		return { status: "collision", path };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			return { status: "failed", path, error: errorMessage(error) };
	}

	const temporaryPath = join(parent, temporaryName());
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		await handle.writeFile(request.content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
	} catch (error) {
		await handle?.close().catch(() => {});
		await removeTemporary(temporaryPath);
		return { status: "failed", path, error: errorMessage(error) };
	}

	try {
		await fs.link(temporaryPath, path);
	} catch (error) {
		await removeTemporary(temporaryPath);
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			return { status: "collision", path };
		return { status: "failed", path, error: errorMessage(error) };
	}

	// The hard link already published a complete target. Cleanup cannot change that result.
	await removeTemporary(temporaryPath);
	return { status: "written", path };
}
