import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { RunOutcome } from "./lifecycle.js";

export type SettledRunOutcome = Exclude<RunOutcome, "pending">;

export interface StoredRunResult {
	runId: number;
	outcome: SettledRunOutcome;
	incarnation: string;
	settledAt: number;
	result: string;
	directory: string;
	resultPath: string;
	metadataPath: string;
}

interface RunResultMetadata {
	version: 1;
	runId: number;
	outcome: SettledRunOutcome;
	incarnation: string;
	settledAt: number;
}

type UnavailableResultStatus =
	| "missing"
	| "incomplete"
	| "invalid_metadata"
	| "unreadable";

type UnavailableResultReason =
	| "artifact_missing"
	| "artifact_incomplete"
	| "metadata_invalid"
	| "artifact_unreadable";

export type RunResultRead =
	| { status: "available"; reason: "result_available"; record: StoredRunResult }
	| {
			status: UnavailableResultStatus;
			reason: UnavailableResultReason;
			message: string;
			directory: string;
			resultPath: string;
			metadataPath: string;
	  };

export function runResultPaths(sessionDir: string, runId: number) {
	const directory = join(sessionDir, "runs", String(runId));
	return {
		directory,
		resultPath: join(directory, "result.md"),
		metadataPath: join(directory, "result.json"),
	};
}

function temporaryName(prefix: string): string {
	return `.${prefix}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
}

function isOutcome(value: unknown): value is SettledRunOutcome {
	return value === "succeeded" || value === "failed" || value === "aborted";
}

async function readOptional(path: string): Promise<
	| { status: "present"; content: string }
	| { status: "missing" }
	| { status: "error"; error: unknown }
> {
	try {
		return { status: "present", content: await fs.readFile(path, "utf8") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { status: "missing" };
		return { status: "error", error };
	}
}

export async function readRunResult(
	sessionDir: string,
	runId: number,
): Promise<RunResultRead> {
	const paths = runResultPaths(sessionDir, runId);
	const [result, rawMetadata] = await Promise.all([
		readOptional(paths.resultPath),
		readOptional(paths.metadataPath),
	]);
	if (result.status === "error" || rawMetadata.status === "error")
		return {
			status: "unreadable",
			reason: "artifact_unreadable",
			message: `The exact result artifact for run ${runId} could not be read.`,
			...paths,
		};
	if (result.status === "missing" && rawMetadata.status === "missing")
		return {
			status: "missing",
			reason: "artifact_missing",
			message: `No exact result artifact exists for run ${runId}.`,
			...paths,
		};
	if (result.status === "missing" || rawMetadata.status === "missing")
		return {
			status: "incomplete",
			reason: "artifact_incomplete",
			message: `The exact result artifact for run ${runId} is incomplete.`,
			...paths,
		};
	try {
		const metadata = JSON.parse(
			rawMetadata.content,
		) as Partial<RunResultMetadata>;
		if (
			metadata.version !== 1 ||
			metadata.runId !== runId ||
			!isOutcome(metadata.outcome) ||
			typeof metadata.incarnation !== "string" ||
			typeof metadata.settledAt !== "number" ||
			!Number.isFinite(metadata.settledAt)
		) {
			throw new Error("invalid metadata");
		}
		return {
			status: "available",
			reason: "result_available",
			record: {
				runId,
				outcome: metadata.outcome,
				incarnation: metadata.incarnation,
				settledAt: metadata.settledAt,
				result: result.content,
				...paths,
			},
		};
	} catch {
		return {
			status: "invalid_metadata",
			reason: "metadata_invalid",
			message: `The exact result metadata for run ${runId} is invalid.`,
			...paths,
		};
	}
}

export async function persistRunResult(
	sessionDir: string,
	input: Omit<StoredRunResult, "directory" | "resultPath" | "metadataPath">,
): Promise<StoredRunResult> {
	if (!Number.isInteger(input.runId) || input.runId < 1)
		throw new Error(`Invalid settled run id: ${input.runId}`);
	const paths = runResultPaths(sessionDir, input.runId);
	const existingDirectory = await fs.lstat(paths.directory).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (existingDirectory) {
		const existing = await readRunResult(sessionDir, input.runId);
		if (existing.status === "available") return existing.record;
		throw new Error(
			`Cannot publish run ${input.runId}; an existing final artifact is ${existing.status}.`,
		);
	}

	const runsDirectory = join(sessionDir, "runs");
	await fs.mkdir(runsDirectory, { recursive: true, mode: 0o700 });
	await fs.chmod(runsDirectory, 0o700).catch(() => {});
	const temporaryDirectory = join(
		runsDirectory,
		temporaryName(String(input.runId)),
	);
	await fs.mkdir(temporaryDirectory, { mode: 0o700 });
	const metadata: RunResultMetadata = {
		version: 1,
		runId: input.runId,
		outcome: input.outcome,
		incarnation: input.incarnation,
		settledAt: input.settledAt,
	};
	try {
		await Promise.all([
			fs.writeFile(join(temporaryDirectory, "result.md"), input.result, {
				encoding: "utf8",
				mode: 0o600,
			}),
			fs.writeFile(
				join(temporaryDirectory, "result.json"),
				`${JSON.stringify(metadata)}\n`,
				{ encoding: "utf8", mode: 0o600 },
			),
		]);
		await fs.rename(temporaryDirectory, paths.directory);
		return { ...input, ...paths };
	} catch (error) {
		await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
		const winner = await readRunResult(sessionDir, input.runId);
		if (winner.status === "available") return winner.record;
		throw error;
	}
}

export async function writeLatestResult(
	sessionDir: string,
	result: string,
): Promise<string> {
	await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
	await fs.chmod(sessionDir, 0o700).catch(() => {});
	const resultPath = join(sessionDir, "result.md");
	const temporaryPath = join(sessionDir, temporaryName("result.md"));
	try {
		await fs.writeFile(temporaryPath, result, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.rename(temporaryPath, resultPath);
		await fs.chmod(resultPath, 0o600).catch(() => {});
		return resultPath;
	} catch (error) {
		await fs.unlink(temporaryPath).catch(() => {});
		throw error;
	}
}
