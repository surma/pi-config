# Subagent extension

This extension gives a parent Pi persistent child Pi processes through the native Pi RPC protocol.

## Child processes

`subagent_start` launches `pi --mode rpc`. The child loads `child.ts` and uses a private session directory.

The child starts with `--offline` and `--approve`. Set `PI_SUBAGENT_PI_BIN` when tests or development need a specific Pi executable.

The child process stays alive after a run settles. The parent can send another message, interrupt a run, or remove the process.

A child cannot start another delegated child.

Native lifecycle events define run state:

- `agent_start` begins a low-level run.
- `agent_end` ends one low-level attempt.
- `agent_settled` marks the point where Pi will not continue the run automatically.

The parent does not treat `agent_end` as completion. A settled run returns the child to idle, while the process remains alive.

Parent tool handlers must preserve Pi cancellation through every child wait. They must race unbounded storage and process waits against that signal, then use bounded cleanup.

Each child serializes at most 32 operations, including the active operation. A later operation receives a clear queue-full rejection instead of growing an unbounded waiter chain.

## Child-extension health

The child extension publishes an out-of-band health marker after its startup hook registers.

The default marker path is:

```text
<session-dir>/child-extension-health-<incarnation>.marker
```

The marker contains exactly these UTF-8 bytes:

```text
pi-subagent-child-extension-ready/v1
```

The file includes one final line-feed character. The marker has a strict 128-byte read bound and uses mode `0600` under a mode `0700` directory.

The marker does not use child stdout. It therefore cannot corrupt the RPC JSONL stream.

The parent must verify the exact marker after RPC process startup and before it sends the first prompt. A missing, malformed, oversized, or unreadable marker means that startup failed.

The child bounds marker file operations and cancels them during session shutdown. The parent must preserve the same startup deadline when it waits for health.

A successful `get_state` response does not prove that `child.ts` loaded. The parent must check both health and RPC readiness.

## Process-local ownership

The controller owns live child transports and runtime state in the current Pi process.

The extension has no central controller registry or lease. A parent session does not gate child launch, and no operation depends on lease state.

A child ID identifies one logical child. A random incarnation identifies one child process instance.

A process-wide runtime map preserves live RPC transports and memory ownership while Pi reloads the extension. Reload rebinds only retained live runtimes with the same owner and incarnation.

A fresh Pi process does not list or inspect children from another process.

## Storage and durable state

Each logical child uses this private directory:

```text
<agent-dir>/sessions/subagents/<child-id>/
  pi-effective-system-prompt.txt
  child-session.jsonl
```

The child captures the effective system prompt. The Pi session file provides the transcript, working directory, model, and thinking level.

The extension keeps process state, run cursors, settlement status, and diagnostics in memory. It does not write a second durable controller state file.

The child session file remains after the controller process exits. Nothing deletes it.

## RPC protocol

The transport uses strict LF-only JSONL framing. It strips one optional trailing carriage return from each record.

The transport accepts complete inbound records without a size limit. Native Pi defines no maximum, and `agent_end` can contain all run messages.

It uses UTF-8 decoding that supports a character split across stream chunks. Unicode line separators inside JSON strings do not split records.

Requests receive generated IDs. The transport resolves responses by ID, so responses can arrive out of order. Events remain asynchronous and pass to the lifecycle dispatcher.

The dispatcher scopes assistant events to the handle's child session, process incarnation, and active run. Within that scope, a local generation identifies each assistant message. Until `responseId` appears, the message timestamp provides a fallback key. The provider, API, and model fields remain metadata.

The parent sends these RPC commands:

- `get_state` captures the child session path and effective model state.
- `prompt` starts the initial or next child run.
- `follow_up` queues another run while a run is active.
- `steer` queues guidance during a run.
- `abort` requests a cooperative abort.

When the child is idle, the parent sends `prompt` because native `follow_up` and `steer` queue only active runs.

A production Pi `abort` response arrives only after the child session reaches idle. The response does not replace `agent_settled` as the lifecycle event boundary.

Production `agent_settled` normally has this bare shape:

```json
{"type":"agent_settled"}
```

It normally has no run ID or outcome. The parent records the abort request before it sends `abort` and keeps that evidence until the dispatcher accepts native settlement.

If a corroborated run remains active, `agent_settled` closes it and records the missing or rejected `agent_end`.

A late abort response does not clear the pending abort evidence. A native settlement without a final assistant message can still classify the run as aborted.

`subagent_start` observes run acceptance for at most one second. It does not wait for the model response.

Termination sends RPC `abort`, then `SIGTERM`, then `SIGKILL` with bounded waits. The extension has no watchdog that guesses whether a child stalled.

## Lifecycle and process-close evidence

The lifecycle separates process state from run state. A successful, failed, or aborted native settlement updates `runOutcome`, `lastSettledRunId`, and `settlement.status` to `settled`.

The process remains `alive` and the run becomes `idle` after settlement.

A process close before the current run settles updates `settlement.status` to `closed_without_settlement`. The status preserves the nullable exit code, exit signal, bounded stderr tail, bounded diagnostics, and final error.

The parent does not emit a success, failure, or abort wake for a close without settlement.

An initial close with no run keeps settlement status `pending`. A close after a settled run preserves `settled`. Explicit termination suppresses pending wakes for that child.

The inspector uses `processState` and `runState` as the coherent display model. Compatibility fields remain available for older serialized records.

An aborted settled child displays as alive and idle with an aborted outcome. It does not keep an inspector refresh timer.

## Reload event handling

`/reload` detaches runtime consumers while child processes remain active. Runtime callbacks carry the child incarnation and runtime identity.

A consumer must verify that identity before it mutates a handle. A stale runtime cannot update a replacement incarnation.

Reload queues retain at most 512 records and drain at most 128 records per event-loop turn. An update flood enters a terminal runtime fence, reports one diagnostic, and rejects later updates.

The queue reserves bounded slots for critical lifecycle and tool boundary records. It keeps accepted `agent_start`, `agent_end`, and `agent_settled` records deliverable after an update overflow.

A failed consumer retains its record and schedules a later retry with a 25-millisecond delay. The runtime makes at most eight failed-drain retries, then leaves retained records queued.

A process close callback runs only after the retained queue drains. The overflow fence closes the transport after settlement or after a bounded 250-millisecond grace period.

The caller must schedule another drain turn after each batch. It must not drain an unbounded queue synchronously.

## Transcript inspection

`subagent_inspect` reads the child Pi session JSONL file. The transcript reader accepts complete LF-framed records only.

It filters the transcript to user messages, assistant messages, and normalized error messages. It drops thinking blocks, tool calls, and tool results.

A read returns the last `n` messages, oldest first. The default is one message. The maximum is fifty.

A message has no size cap. The reader returns its complete text.

The reader reports one of these statuses:

- `available`: the snapshot has valid complete records.
- `missing`: no session path exists, or the file does not exist.
- `incomplete`: the file has a non-empty trailing fragment without LF.
- `unreadable`: one or more complete records are malformed, or the file cannot be read.

The inspector reads at most the most recent 512 KiB of transcript data. It keeps recent records and reports when earlier records fall outside that bound.

The inspector reads at most the first 64 KiB of the captured effective prompt. It reports prompt truncation instead of reading the complete file before display bounds apply.

Each inspector file operation has a deadline and an AbortSignal. Selection changes and inspector disposal cancel stale reads. A stalled read cannot block the next selected child indefinitely.

The inspector sanitizes all untrusted text before terminal rendering. These bounds do not weaken terminal sanitization.

The result also reports `totalMessages`, so the caller knows how many messages the tail omitted.

Transcript text and file presence do not prove that a run settled.

## Long deliverables

The parent writes no output file. A child run reports its result through the transcript only.

To collect a long deliverable, instruct the child to write it to a file. The child owns the path, the content, and any retry. The parent then reads that file with its own tools.

## Stop notifications

A subagent stops in four ways. Each one queues exactly one non-durable steering wake:

- It finished its turn. The run settled with outcome `succeeded`.
- It errored. The run settled with outcome `failed`.
- You interrupted it. The run settled with outcome `aborted`.
- Its process died. The process closed before any settlement, so the record uses `eventKind: "process_died"` and outcome `died`.

The queue suppresses duplicate records by owner, child, incarnation, run ID, and event kind.

It retries one failed send and limits each flush to a bounded batch. A later batch runs in another event-loop turn.

Each wake uses `triggerTurn: true` and `deliverAs: "steer"`. Its content follows this shape:

```text
Subagent <id> (<name>) stopped: <reason>. Read its last message with subagent_inspect.
```

A `process_died` wake adds the exit code or signal, the close error, and a bounded stderr tail.

The custom message details include the direct owner session file, owner session ID, child ID, incarnation, run ID, event kind, outcome, and a `settlements` array containing that record.

Shutdown and explicit removal suppress unsent wakes. The caller asked for those stops, so no wake is needed.

Reload queues accept at most 512 records. Overflow retains accepted records, emits one terminal diagnostic, and fences the runtime against later updates. Bounded critical lifecycle records remain accepted so `agent_start`, `agent_end`, and `agent_settled` remain deliverable after an update flood.

The queue sends records separately. It does not promise durability, recovery after process loss, or notification for process stalls or close events.

## Tools

The extension registers six tools:

- `subagent_start {prompt, model, thinking, name?, cwd?}` starts a child and returns its handle at once. The prompt accepts at most 64 KiB. A missing `cwd` inherits the caller working directory.
- `subagent_list {}` lists every tracked child, one block per child.
- `subagent_inspect {id, n?}` returns the child state, its last `n` messages with timestamps, and the path to its full log. The default `n` is one.
- `subagent_steer {id, message}` sends a message. A running child receives it at its next step. An idle child starts a new turn.
- `subagent_interrupt {id}` stops the current turn and keeps the process alive.
- `subagent_remove {id}` ends the process with bounded escalation and keeps every file.

The model and thinking fields are mandatory for `subagent_start`. Nested delegated children cannot call `subagent_start`. The inspector displays at most 32 KiB of the original prompt text.

The calling agent never polls. A stop notification arrives on its own.

`subagent_inspect` reports one of three states: `running`, `idle`, or `stopped`. A stopped child reports its exit code or signal. The tool text also carries the model, the thinking level, the last run outcome, the start and last-activity timestamps, and any error.

## Commands and inspector

- `/subagents` opens the interactive inspector in TUI mode or prints summaries in other modes.
- `/subagents-toggle` toggles the compact active-child widget.
- `/subagents-kill-all` terminates all live children owned by the current controller.

The inspector shows lifecycle state, RPC readiness, live assistant text, tool activity, transcript history, settlement evidence, and process-close evidence.

It sanitizes untrusted text before rendering it.

## Verification

Run the deterministic suite from this directory:

```sh
PI_TEST_PACKAGE_DIR=/path/to/pi-0.84.1 ./test.sh
```

The suite covers lifecycle dispatch, transcript projection and tail reads, stop notifications, strict RPC framing, correlated responses, bounded termination, launch arguments, all six tools, reload, process-close evidence, abort acceptance, child-extension health helpers, and the inspector.
