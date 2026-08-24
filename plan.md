# Native RPC subagent architecture

This repository uses native Pi RPC child processes. This note replaces the old terminal-session implementation plan.

## Current design

- The parent launches one `pi --mode rpc` process for each logical child.
- The child loads `extensions/subagent/child.ts` and keeps its own Pi session.
- The child remains alive after `agent_settled`, so the parent can send another prompt.
- A logical child keeps its ID across resume. Each process incarnation has a new identity.
- Runtime callbacks require the current runtime object and incarnation. Stale callbacks remain inert.
- `/reload` detaches consumers and preserves live transports in process-global state.
- Reload queues retain at most 512 records and drain at most 128 records per event-loop turn.
- An update overflow emits one diagnostic, fences the runtime, and rejects later updates.
- Reserved critical lifecycle slots keep accepted `agent_start`, `agent_end`, and `agent_settled` records deliverable after overflow.
- A failed consumer retains its record and receives up to eight later retries with a 25-millisecond delay.
- The caller delivers a close callback only after retained records drain. The overflow fence closes the transport after settlement or a bounded 250-millisecond grace period.
- Each child accepts at most 32 serialized operations, including the active operation.
- The caller task and optional resume task each accept at most 64 KiB. The inspector displays at most 32 KiB of the original task.
- The caller schedules later drain turns. It does not create a synchronous event storm.

## Protocol contract

Native lifecycle records define completion:

- `agent_start` begins a run.
- `agent_end` ends one attempt and can precede retry or continuation.
- `agent_settled` returns the child to idle.

Production Pi sends the successful `abort` response only after the session reaches idle. A normal `agent_settled` record is usually:

```json
{"type":"agent_settled"}
```

The record normally has no run ID or outcome. The parent records an abort fence before it sends `abort`. The dispatcher keeps that fence until it accepts native settlement.

## Child health contract

The child publishes this exact UTF-8 marker after its startup hook registers:

```text
pi-subagent-child-extension-ready/v1
```

The marker includes one final line-feed character. The default path is:

```text
<session-dir>/child-extension-health-<incarnation>.marker
```

`PI_SUBAGENT_HEALTH_PATH` can override the path. The parent uses a unique path for each incarnation.

The parent verifies the marker with a 128-byte bound after RPC startup and before the first prompt. Missing, malformed, oversized, or unreadable health data fails startup.

The marker uses a file instead of RPC stdout. It cannot interfere with JSONL framing.

## Lease monitor contract

The child reads at most 4 KiB for each lease snapshot. Checks never overlap.

A monitor generation fences results from an older start or stop cycle. A stale asynchronous result cannot terminate a newer healthy monitor.

A valid lease resets the temporary read-error count. Three consecutive temporary read errors cause a bounded conservative self-fence. A successfully read missing, malformed, expired, or replaced record causes immediate self-fence.

## Diagnostics and presentation

The status reader uses bounded JSONL pages. The inspector reads only a bounded recent transcript tail and a bounded prompt prefix.

The inspector sanitizes untrusted text before terminal rendering. It displays at most 32 KiB of the original task text. It uses process state and run state for refresh decisions. An aborted settled idle child does not keep a refresh timer.

Settlement wakes use `numMessages=3`. They are best-effort steering messages and are not durable completion records.

The caller task and optional resume task accept at most 64 KiB. Each child serializes at most 32 operations, including the active operation.

## Historical archive

The previous version of this file described a Zellij session and guardian design. That design was never part of the current native RPC runtime.

The migration removed the terminal-session manager, guardian process, control pipes, liveness modules, and retained cleanup-session machinery. The old design remains only as repository history.

Do not add new Zellij, guardian, or terminal-session dependencies to the native RPC extension.
