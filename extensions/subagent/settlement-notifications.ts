import type { RunOutcome } from "./lifecycle.js";

export type SettledRunOutcome = Exclude<RunOutcome, "pending">;

/** Delay delivery until the settlement callback returns to the RPC host. */
export const SETTLEMENT_NOTIFICATION_DELAY_MS = 0;
const MAX_SEND_RETRIES = 1;

export interface SettlementNotificationRecord {
	ownerSessionFile: string;
	ownerSessionId: string;
	childId: string;
	incarnation: string;
	runId: number;
	eventKind: "run_settled";
	outcome: SettledRunOutcome;
}

export interface SettlementCustomMessage {
	customType: "subagent-settlement";
	content: string;
	display: true;
	details: { settlements: SettlementNotificationRecord[] };
}

function isSettledRunOutcome(value: unknown): value is SettledRunOutcome {
	return value === "succeeded" || value === "failed" || value === "aborted";
}

function isRealSettlement(record: SettlementNotificationRecord): boolean {
	return (
		typeof record.ownerSessionFile === "string" &&
		record.ownerSessionFile.length > 0 &&
		typeof record.ownerSessionId === "string" &&
		record.ownerSessionId.length > 0 &&
		typeof record.childId === "string" &&
		record.childId.length > 0 &&
		typeof record.incarnation === "string" &&
		record.incarnation.length > 0 &&
		numberIsPositiveSafeInteger(record.runId) &&
		record.eventKind === "run_settled" &&
		isSettledRunOutcome(record.outcome)
	);
}

function numberIsPositiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
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

function messageFor(record: SettlementNotificationRecord): SettlementCustomMessage {
	return {
		customType: "subagent-settlement",
		content: `Subagent ${record.childId} reached idle after run ${record.runId}. Check subagent_status with messages=3.`,
		display: true,
		details: { settlements: [record] },
	};
}

/**
 * Delivers one non-durable wake for each accepted run settlement.
 *
 * The queue accepts only succeeded, failed, and aborted `run_settled` records.
 * It delivers each record in its own steering message. It does not persist
 * records, recover records after process loss, or report idle and process events.
 */
export class SettlementNotificationQueue {
	private readonly pending = new Map<string, SettlementNotificationRecord>();
	private readonly attempts = new Map<string, number>();
	private readonly accepted = new Set<string>();
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly send: (
			message: SettlementCustomMessage,
			options: { triggerTurn: true; deliverAs: "steer" },
		) => void,
		private readonly eligible: (record: SettlementNotificationRecord) => boolean = () => true,
	) {}

	queue(record: SettlementNotificationRecord): void {
		if (!isRealSettlement(record)) return;
		const recordKey = key(record);
		if (this.accepted.has(recordKey)) return;
		this.accepted.add(recordKey);
		this.pending.set(recordKey, record);
		this.schedule(SETTLEMENT_NOTIFICATION_DELAY_MS);
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

	private schedule(delayMs: number): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, delayMs);
		this.timer.unref?.();
	}

	private clearEmptyTimer(): void {
		if (this.pending.size > 0 || !this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private flush(): void {
		const entries = [...this.pending.entries()];
		this.pending.clear();
		for (const [recordKey, record] of entries) {
			let eligible = false;
			try {
				eligible = this.eligible(record);
			} catch {
				eligible = false;
			}
			if (!eligible) {
				this.attempts.delete(recordKey);
				continue;
			}
			try {
				this.send(messageFor(record), {
					triggerTurn: true,
					deliverAs: "steer",
				});
				this.attempts.delete(recordKey);
			} catch {
				const attempts = (this.attempts.get(recordKey) ?? 0) + 1;
				if (attempts <= MAX_SEND_RETRIES) {
					this.attempts.set(recordKey, attempts);
					this.pending.set(recordKey, record);
				} else {
					this.attempts.delete(recordKey);
				}
			}
		}
		if (this.pending.size > 0) this.schedule(SETTLEMENT_NOTIFICATION_DELAY_MS);
	}
}
