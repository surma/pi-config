import type { SettledRunOutcome } from "./result-store.js";

export const SETTLEMENT_NOTIFICATION_BATCH_MS = 50;
const MAX_SEND_RETRIES = 1;

export interface SettlementNotificationRecord {
	ownerSessionFile: string;
	ownerSessionId: string;
	childId: string;
	name?: string;
	incarnation: string;
	runId: number;
	eventKind: "run_settled";
	outcome: SettledRunOutcome;
	childAlive: boolean;
	preview: string;
}

export interface SettlementCustomMessage {
	customType: "subagent-settlement";
	content: string;
	display: true;
	details: { settlements: SettlementNotificationRecord[] };
}

function key(record: SettlementNotificationRecord): string {
	return JSON.stringify([
		record.ownerSessionFile,
		record.ownerSessionId,
		record.childId,
		record.incarnation,
		record.runId,
		record.eventKind,
	]);
}

function formatLine(record: SettlementNotificationRecord): string {
	const child = `#${record.childId}${record.name ? ` (${record.name})` : ""}`;
	const process = record.childAlive ? "child remains alive" : "child stopped";
	return `- ${child} · run ${record.runId} · ${record.outcome} · ${process}${record.preview ? ` · ${record.preview}` : ""}`;
}

export class SettlementNotificationQueue {
	private readonly pending = new Map<string, SettlementNotificationRecord>();
	private readonly attempts = new Map<string, number>();
	private readonly sent = new Set<string>();
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly send: (
			message: SettlementCustomMessage,
			options: { triggerTurn: true; deliverAs: "steer" },
		) => void,
		private readonly eligible: (record: SettlementNotificationRecord) => boolean,
	) {}

	queue(record: SettlementNotificationRecord): void {
		const recordKey = key(record);
		if (this.sent.has(recordKey) || this.pending.has(recordKey)) return;
		this.pending.set(recordKey, record);
		this.schedule();
	}

	suppressChild(childId: string): void {
		for (const [recordKey, record] of this.pending) {
			if (record.childId !== childId) continue;
			this.pending.delete(recordKey);
			this.attempts.delete(recordKey);
		}
		this.clearEmptyTimer();
	}

	suppressAll(): void {
		this.pending.clear();
		this.attempts.clear();
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private schedule(): void {
		this.timer ??= setTimeout(() => this.flush(), SETTLEMENT_NOTIFICATION_BATCH_MS);
		this.timer.unref?.();
	}

	private clearEmptyTimer(): void {
		if (this.pending.size > 0 || !this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private flush(): void {
		this.timer = undefined;
		const entries = [...this.pending.entries()];
		this.pending.clear();
		const eligible: [string, SettlementNotificationRecord][] = [];
		for (const entry of entries) {
			if (this.eligible(entry[1])) eligible.push(entry);
			else this.attempts.delete(entry[0]);
		}
		if (eligible.length === 0) return;
		const records = eligible.map(([, record]) => record);
		try {
			this.send(
				{
					customType: "subagent-settlement",
					content: [
						"Subagent run settlements:",
						...records.map(formatLine),
						"Use subagent_result with the child ID and run ID for exact output.",
					].join("\n"),
					display: true,
					details: { settlements: records },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			for (const [recordKey] of eligible) {
				this.attempts.delete(recordKey);
				this.sent.add(recordKey);
				if (this.sent.size > 2048) {
					const oldest = this.sent.values().next().value;
					if (oldest) this.sent.delete(oldest);
				}
			}
		} catch {
			for (const [recordKey, record] of eligible) {
				const attempts = (this.attempts.get(recordKey) ?? 0) + 1;
				if (attempts <= MAX_SEND_RETRIES) {
					this.attempts.set(recordKey, attempts);
					this.pending.set(recordKey, record);
				} else {
					this.attempts.delete(recordKey);
				}
			}
			if (this.pending.size > 0) this.schedule();
		}
	}
}
