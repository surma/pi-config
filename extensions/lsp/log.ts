import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function formatTimestamp(date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function defaultCacheRoot(): string {
	const xdg = process.env.XDG_CACHE_HOME?.trim();
	return xdg ? xdg : path.join(os.homedir(), ".cache");
}

function formatLines(message: string): string {
	const text = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = text.split("\n");
	const timestamp = new Date().toISOString();
	return lines.map((line) => `${timestamp} ${line}`).join("\n") + "\n";
}

export class LspLogSink {
	readonly dirPath: string;
	readonly filePath: string;

	private queue: Promise<void> = Promise.resolve();

	constructor(prefix = "lsp") {
		this.dirPath = path.join(defaultCacheRoot(), "pi", "logs");
		this.filePath = path.join(this.dirPath, `${prefix}-${formatTimestamp()}-${process.pid}.log`);
	}

	append(message: string): void {
		if (!message) return;
		const payload = formatLines(message);
		const write = async () => {
			await mkdir(this.dirPath, { recursive: true });
			await appendFile(this.filePath, payload, "utf8");
		};
		this.queue = this.queue.then(write, write);
	}

	flush(): Promise<void> {
		return this.queue;
	}
}
