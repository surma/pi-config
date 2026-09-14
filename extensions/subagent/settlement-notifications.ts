import type { RunOutcome } from "./lifecycle.js";

export type SettledRunOutcome = Exclude<RunOutcome, "pending">;

/** Schedule delivery after the settlement callback returns to the RPC host. */
export const SETTLEMENT_NOTIFICATION_DELAY_MS = 0;
const MAX_SEND_RETRIES = 1;
const MAX_ACCEPTED_KEYS = 4096;
const MAX_SENDS_PER_FLUSH = 32;

/** Why a subagent stopped. `died` means the process closed without settling. */
export type StopReason = SettledRunOutcome | "died";

export interface SettlementNotificationRecord {
	ownerSessionFile: string;
	ownerSessionId: string;
	childId: string;
	incarnation: string;
	/** The run that settled, or 0 when the process died outside a run. */
	runId: number;
	eventKind: "run_settled" | "process_died";
	outcome: StopReason;
	/** A short human-readable label, such as the child name or the exit code. */
	name?: string;
	detail?: string;
}

export interface SettlementCustomMessage {
	customType: "subagent-settlement";
	content: string;
	display: boolean;
	details: SettlementNotificationRecord & {
		settlements: SettlementNotificationRecord[];
	};
}

function isStopReason(value: unknown): value is StopReason {
	return (
		value === "succeeded" ||
		value === "failed" ||
		value === "aborted" ||
		value === "died"
	);
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
		Number.isSafeInteger(record.runId) &&
		record.runId >= 0 &&
		(record.eventKind === "run_settled"
			? record.runId > 0 && record.outcome !== "died"
			: record.eventKind === "process_died") &&
		isStopReason(record.outcome)
	);
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

const REASON_TEXT: Record<StopReason, string> = {
	succeeded: "it finished its turn",
	failed: "it errored",
	aborted: "you interrupted it",
	died: "its process died",
};

function messageFor(record: SettlementNotificationRecord): SettlementCustomMessage {
	const label = record.name ? `${record.childId} (${record.name})` : record.childId;
	const detail = record.detail ? ` ${record.detail}` : "";
	return {
		customType: "subagent-settlement",
		content: `Subagent ${label} stopped: ${REASON_TEXT[record.outcome]}.${detail} Read its last message with subagent_inspect.`,
		display: true,
		details: {
			...record,
			settlements: [record],
		},
	};
}

/**
 * Delivers one non-durable wake for each accepted subagent stop.
 *
 * A stop is a settled run or a process that closed without settling.
 * It sends each record in its own steering message and retries one failure.
 * It does not persist records, recover records after process loss, or report stalls.
 */
export class SettlementNotificationQueue {
	private readonly pending = new Map<string, SettlementNotificationRecord>();
	private readonly attempts = new Map<string, number>();
	private readonly accepted = new Set<string>();
	private readonly acceptedOrder: string[] = [];
	private readonly childSuppressionEpochs = new Map<string, number>();
	private suppressionEpoch = 0;
	private timer: NodeJS.Timeout | undefined;
	private flushing = false;

	constructor(
		private readonly send: (
			message: SettlementCustomMessage,
			options: { triggerTurn: true; deliverAs: "steer" },
		) => void | Promise<void>,
		private readonly eligible: (record: SettlementNotificationRecord) => boolean = () => true,
	) {}

	queue(record: SettlementNotificationRecord): void {
		if (!isRealSettlement(record)) return;
		const recordKey = key(record);
		if (this.accepted.has(recordKey)) return;
		this.accepted.add(recordKey);
		this.acceptedOrder.push(recordKey);
		if (this.acceptedOrder.length > MAX_ACCEPTED_KEYS) {
			const oldest = this.acceptedOrder.shift();
			if (oldest) this.accepted.delete(oldest);
		}
		this.pending.set(recordKey, record);
		this.schedule(SETTLEMENT_NOTIFICATION_DELAY_MS);
	}

	suppressChild(childId: string): void {
		this.childSuppressionEpochs.set(
			childId,
			(this.childSuppressionEpochs.get(childId) ?? 0) + 1,
		);
		for (const [recordKey, record] of this.pending) {
			if (record.childId !== childId) continue;
			this.pending.delete(recordKey);
			this.attempts.delete(recordKey);
		}
	}

	suppressAll(): void {
		this.suppressionEpoch++;
		this.pending.clear();
		this.attempts.clear();
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private schedule(delayMs: number): void {
		if (this.timer || this.flushing) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, delayMs);
		this.timer.unref?.();
	}

	private async flush(): Promise<void> {
		if (this.flushing) return;
		this.flushing = true;
		try {
			const entries = [...this.pending.entries()].slice(0, MAX_SENDS_PER_FLUSH);
			for (const [recordKey] of entries) this.pending.delete(recordKey);
			const suppressionEpoch = this.suppressionEpoch;
			const childSuppressionEpochs = new Map(
				entries.map(([_, record]) => [
					record.childId,
					this.childSuppressionEpochs.get(record.childId) ?? 0,
				]),
			);
			for (const [recordKey, record] of entries) {
				const childSuppressionEpoch =
					childSuppressionEpochs.get(record.childId) ?? 0;
				const suppressed = () =>
					this.suppressionEpoch !== suppressionEpoch ||
					(this.childSuppressionEpochs.get(record.childId) ?? 0) !==
						childSuppressionEpoch;
				if (suppressed()) {
					this.attempts.delete(recordKey);
					continue;
				}
				let eligible = false;
				try {
					eligible = this.eligible(record);
				} catch {
					eligible = false;
				}
				if (!eligible || suppressed()) {
					this.attempts.delete(recordKey);
					continue;
				}
				try {
					await this.send(messageFor(record), {
						triggerTurn: true,
						deliverAs: "steer",
					});
					this.attempts.delete(recordKey);
				} catch {
					if (suppressed()) {
						this.attempts.delete(recordKey);
						continue;
					}
					const attempts = (this.attempts.get(recordKey) ?? 0) + 1;
					if (attempts <= MAX_SEND_RETRIES) {
						this.attempts.set(recordKey, attempts);
						this.pending.set(recordKey, record);
					} else {
						this.attempts.delete(recordKey);
					}
				}
			}
		} finally {
			this.flushing = false;
			if (this.pending.size > 0) this.schedule(SETTLEMENT_NOTIFICATION_DELAY_MS);
		}
	}
}
