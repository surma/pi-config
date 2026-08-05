# Dedicated Zellij Session Implementation Plan

**Goal:** Give each persisted logical Pi session one isolated, Pi-owned Zellij session with serialized, retryable ownership transitions.

**Architecture:** One immutable process-global production lifecycle manager is wired once to real persistence, process spawning, Zellij actions, and deadlines; tests instantiate separate dependency-injected managers and cannot mutate production dependencies. It owns one active lifecycle and zero or more retiring lifecycles. Provisioning, stale-record recovery, guardian exit, explicit retirement, and retry run through one operation chain, while a separate process-global retained-authority manager renews every unresolved retiring-owner lease across `/reload`. A synchronous transition to provisioning or retiring blocks every Zellij action. A plain-Node guardian supplies one-process abrupt-parent cleanup through control-pipe EOF.

**Tech stack:** TypeScript, plain JavaScript for the guardian, Node.js child processes, Unix pipes, Zellij 0.44.3, Pi 0.83.0, and Node's test runner.

---

## Invariants

- A persisted parent session owns at most one active session named `pi<128-bit-base64url-random>`.
- Manager state contains at most one active lifecycle and zero or more retiring lifecycles. Provisioning is separately manager-owned before guardian startup.
- Provisioning or any unresolved retirement blocks all Zellij action gateways and new provisioning.
- Every transition is serialized. Guardian exit, startup failure, explicit retirement, stale recovery, and later retry converge on the same lifecycle cleanup operation.
- Every child action includes the exact dedicated session name. The extension never routes through a host/current Zellij session.
- TUI footer status is the exact active name and is cleared immediately on guardian loss, blockage, failed establishment, replacement, or quit.
- `/reload` preserves the immutable production manager lifecycle object, guardian child object and control pipes, session name, current lease, retained retiring-owner authorities, and children.
- `quit`, `new`, `resume`, and `fork` delete the whole old dedicated session before another lifecycle provisions.
- Parent-side deletion requires retiring-owner lease authority and a fresh exact durable identity comparison immediately before the destructive call; unavailable old authority blocks every new owner.
- Failed replacement retirement and unresolved startup cleanup retain and safely renew that exact existing lease indefinitely while the same process remains responsible. Maintenance fails closed if the lease is absent, never overwrites a successor controller, and stops/releases only after successful record removal or final quit semantics.
- Whole-session settlement closes IPC ingress, fences new mutations, drains each handle's serialized IPC and settlement-persistence chains, and durably settles the registry before the managed ownership record is compare-and-removed.
- Ambiguous `new-tab` completion or pane discovery triggers exact whole-session retirement; missing-pane targeted cleanup is never accepted as permanent success.
- Exact deletion is proved by absence from `zellij list-sessions --short --no-formatting`.
- Zellij 0.44.3 returns code 1 and `No active zellij sessions found.` for an empty list. Only that exact result means absence.
- Every spawned Zellij client and guardian is awaited through `close`; timeout escalation is TERM then KILL.

## Durable state

Store the strict record at:

```text
<agent-dir>/sessions/subagents/controllers/<owner-key>/managed-session.json
```

```ts
interface ManagedSessionRecord {
  version: 1;
  ownerSessionFile: string;
  ownerSessionId: string;
  generation: string;
  sessionName: string;
  state: "arming" | "active" | "cleanup_pending";
  createdAt: number;
  cleanupError?: string;
}
```

Writes are atomic mode-`0600` operations below a mode-`0700` directory. The parser rejects arrays, empty files, unknown keys, empty owner fields, malformed values, and noncanonical names. `generation` is exactly 32 lowercase hexadecimal characters. `sessionName` is exactly `pi` plus 22 base64url characters from 128 random bits. The resulting 24-character name fits default macOS Zellij socket paths. `createdAt` is a finite, nonnegative integer. In a fresh process, `arming`, `active`, and `cleanup_pending` all become exact-name cleanup work. Only a matching process-global active lifecycle is reload-adoptable.

A startup failure after the arming write must:

1. install retryable manager-owned retirement;
2. hold the shared owner-record lock while comparing the complete durable identity and mandatorily persisting `cleanup_pending`—a failed write forbids deletion;
3. verify the retiring owner's exact current lease authority;
4. reload and compare version, owner file, owner ID, generation, name, timestamp, and `cleanup_pending` state immediately before deleting the exact session and proving absence, including uncertain creation outcomes;
5. close child IPC ingress, drain queued mutations and persistence, then settle and persist tracked children;
6. validly disarm or forcibly terminate the guardian process group, including descendant cleanup clients;
7. await guardian `close` after process-group TERM/KILL escalation;
8. recheck the exact retiring-owner lease authority after settlement and reap; and
9. hold the owner-record lock across final reload, comparison, and unlink so only the same cleanup identity can be removed.

A successor generation is never deleted, overwritten by cleanup state/error persistence, or unlinked. An unresolved step retains `cleanup_pending`, `cleanupError`, manager blockage, and retiring-owner authority. A later establish attempt renews and verifies every retained authority, retries all retirement work first, and provisions nothing until all cleanup succeeds. A successful current retry clears a historical `cleanupError`.

## Retiring-owner authority

The lease verifier is stored on each lifecycle and receives that lifecycle's immutable owner identity; it never consults only the mutable current owner. A failed non-quit replacement or establishment with unresolved cleanup keeps the old lease in a process-global retained-authority manager. Its unreferenced interval safely maintains every retained lease across arbitrarily delayed same-process retries and `/reload`, including extension of an expired-but-still-present exact lease when no successor won it. Missing lease files fail closed and are never recreated. Maintenance is serialized with release and cannot overwrite another controller's elected lease.

Before acquiring or provisioning a new owner, establishment must successfully maintain all retained old authorities. If any old lease is missing, stolen, or otherwise unavailable, cleanup and new provisioning stay blocked. After the lifecycle manager has deleted the exact old session, settled children, reaped the guardian, and compare-removed the old record, the retained manager stops renewing and releases the old lease. If the active replacement has the same owner identity, it keeps that lease as current authority rather than releasing it. Final process quit stops retained renewal and releases retained leases so the guardian's control-pipe EOF behavior takes over.

## Guardian protocol

The guardian accepts only one exact generated name, a 32-lowercase-hex generation, a 64-lowercase-hex independent capability, and a Zellij executable. Malformed startup arguments exit before readiness or client creation. It writes `{type:"ready", generation, capability}` before session creation, and the manager accepts readiness only when both fences exactly match the values it generated.

Normal retirement sends `{type:"disarm", generation, capability}`. The guardian replies with the same exact generation and capability, flushes that acknowledgement, and waits for control EOF before successful natural exit. The manager accepts only the matching acknowledgement, closes the control pipe, and requires a successful close.

Missing, wrong, or delayed acknowledgement; premature exit; control-stdin failure; and a hung guardian use pipe close, TERM, then KILL as needed. The manager always awaits close and retains `cleanup_pending` until reap completes.

Unexpected guardian death synchronously moves the lifecycle out of active/provisioning and into retiring, clears the footer through the owner callback, then serially persists cleanup intent, proves exact session deletion, settles the registry, and removes the record only after reap.

## Parent and mode behavior

- Persisted TUI, RPC, JSON, and print sessions all provision the same lifecycle behavior.
- TUI additionally shows the exact dedicated session in the standard footer.
- A context without a persisted session file and ID (`--no-session`) starts no guardian or Zellij process.
- `/reload` preserves objects and pipes; it does not recreate or retire the session.
- Quit/new/resume/fork perform whole-session retirement and block replacement provisioning until it resolves.

## Abrupt-parent guarantee (C6)

Only one abrupt Pi-parent process failure, including `SIGKILL`, is guaranteed to trigger guardian EOF cleanup, and only while the guardian process, host and pipe semantics, Zellij server, and configured executables remain operational.

Simultaneous Pi-parent and guardian failure, host or power failure, and persistently broken Zellij are not guaranteed. Durable `arming`, `active`, and `cleanup_pending` records support later best-effort recovery; they do not guarantee cleanup at crash time.

## B/C audit

- [x] **B1 — active + retiring:** one active, zero-or-more retiring, manager-owned provisioning, and synchronous action blockage.
- [x] **B2 — await close:** every bounded Zellij client awaits `close`; guardian fallback TERM/KILL fences its detached process group and descendant clients before accepting leader reap.
- [x] **B3 — guardian death cleanup:** death is serialized with provisioning/retirement and drives exact whole-session cleanup.
- [x] **B4 — registry before record:** IPC ingress is closed, mutation/persistence queues are drained, and child settlement is durable before ownership-record removal.
- [x] **B5 — detached creation:** creation is `attach --create-background <exact-name>` followed by exact presence proof.
- [x] **C1 — exact absence:** deletion is accepted only after the exact name is absent.
- [x] **C2 — reload objects/pipes:** process-global lifecycle, guardian object/control pipes, lease, and children survive reload.
- [x] **C3 — strict records:** only the exact known key set is accepted; generation and suffix are 32 lowercase hex characters; the sanitized owner-derived prefix is exactly truncated to 24 characters; timestamps are finite nonnegative integers; empty/malformed records fail closed; writes and compare-remove share an owner-record lock; state/error writes compare identity under that lock; final unlink locks across reload/compare/unlink and follows a second authority check.
- [x] **C4 — ready/ack/capability/reap:** startup validates 32-hex generation and 64-hex capability; readiness and acknowledgement both require exact matches for both fences; EOF and successful reap are awaited.
- [x] **C5 — footer clear:** guardian loss, blockage, failed establishment, replacement, and quit clear the status.
- [x] **C6 — one-process docs:** guarantee and exclusions are stated without simultaneous-failure or live-child recovery claims.

## Work checklist

- [x] Add strict `managed-session.json` helpers and tests.
- [x] Add the plain-JavaScript EOF guardian and fake-Zellij process tests.
- [x] Bound Zellij clients and await close after TERM/KILL escalation.
- [x] Add exact named background creation, presence proof, deletion, and absence proof.
- [x] Implement serialized manager-owned provisioning/active/retiring transitions.
- [x] Route every post-arming startup failure through cleanup and reap.
- [x] Add retirement retries before provisioning and stale-error clearing.
- [x] Retain and safely renew every unresolved replacement/startup cleanup lease across `/reload`, fail closed on an absent lease, block replacement without old authority, and test retry beyond the normal expiry window.
- [x] Lock managed-record writes and compare-remove against successor races, with authority rechecked immediately before removal.
- [x] Drain IPC mutation/persistence queues before whole-session settlement and record removal.
- [x] Retire the whole session for ambiguous launch/pane discovery and prove no potentially launched child remains.
- [x] Kill/reap the guardian process group on fallback and test a real guardian with a fake hung descendant client.
- [x] Serialize unexpected guardian death and registry settlement.
- [x] Validate generation/capability startup shapes, require both in readiness and acknowledgement, and preserve forced-reap fallback.
- [x] Integrate startup, reload, footer, no-session, replacement, and quit behavior in `index.ts`.
- [x] Route launch, resume, discovery, interrupt, and child cleanup through the owned session.
- [x] Add focused fake-process lifecycle tests for startup, death, concurrency, retry, protocol failure, ordering, and blockage.
- [x] Update `README.md`, tool guidance, and this plan.
- [x] Run focused tests after the final implementation edit.
- [x] Run two complete natural suite passes after the final edit with the required Pi package.
- [x] Run diff/static searches, inspect all changed and untracked files, and confirm no fake or guardian process remains.

## Verification

```sh
PI_TEST_PACKAGE_DIR=/Users/surma/.pi/pkg/pi-0.83.0 ./test.sh
PI_TEST_PACKAGE_DIR=/Users/surma/.pi/pkg/pi-0.83.0 ./test.sh
rg -n "ZELLIJ_SESSION_NAME|selectZellijSessionForPane|ensureZellij|requireZellij" extensions/subagent
rg -n "listPanes|list-panes" extensions/subagent
rg -n "spawn\\(" extensions/subagent/zellij.ts extensions/subagent/zellij-guardian.mjs extensions/subagent/zellij-manager.ts
rg -n "setZellijManagerTestHooks|PI_.*TEST.*HOOK|beforeSave" extensions/subagent
ps -axo pid=,ppid=,command=
git diff --check
git status --short
```
