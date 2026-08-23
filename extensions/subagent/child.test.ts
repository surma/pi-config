import assert from "node:assert/strict";
import test from "node:test";
import { isValidChildLeaseRecord } from "./child.ts";

const identity = {
	ownerSessionFile: "/tmp/parent.jsonl",
	ownerSessionId: "parent-session",
	controllerInstanceId: "controller-a",
};

function record(expiresAt: number): Record<string, unknown> {
	return {
		ownerSessionFile: identity.ownerSessionFile,
		ownerSessionId: identity.ownerSessionId,
		controllerInstanceId: identity.controllerInstanceId,
		expiresAt,
	};
}

test("child lease validation requires exact identity and an unexpired finite expiry", () => {
	assert.equal(isValidChildLeaseRecord(record(1_001), identity, 1_000), true);
	assert.equal(isValidChildLeaseRecord(record(1_000), identity, 1_000), true);
	assert.equal(isValidChildLeaseRecord(record(999), identity, 1_000), false);
	assert.equal(
		isValidChildLeaseRecord(
			{ ...record(1_001), controllerInstanceId: "controller-b" },
			identity,
			1_000,
		),
		false,
	);
	assert.equal(isValidChildLeaseRecord({ ...record(Number.NaN) }, identity, 1_000), false);
	assert.equal(isValidChildLeaseRecord({ ...record(Number.POSITIVE_INFINITY) }, identity, 1_000), false);
	assert.equal(isValidChildLeaseRecord("not-json", identity, 1_000), false);
});
