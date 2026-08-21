# subagent

This extension gives a parent Pi persistent, visible child Pi sessions inside Zellij.

## Requirements

Zellij must be available. The extension creates one dedicated Zellij session for each persisted parent Pi session.

The session name is `pi` plus a 22-character base64url encoding of 128 random bits. Its exact length is 24 characters. This compact name fits the default macOS Zellij socket path limit. The extension never routes a child through the parent Zellij session.

The lifecycle persists an `arming`, `active`, or `cleanup_pending` record in `managed-session.json` before it makes destructive changes. The strict schema accepts only known keys, a 32-lowercase-hex generation, the exact owner-derived prefix truncated to 24 alphanumeric characters, a 32-lowercase-hex random suffix, and a nonnegative finite integer timestamp. Empty, malformed, overlong-prefix, wrong-owner-prefix, and extra-field records fail closed. It creates the exact name with `zellij attach --create-background <name>`.

A plain Node guardian owns an EOF cleanup fence. Startup accepts only an exact 32-lowercase-hex generation and an independent 64-lowercase-hex capability. Its `ready` frame carries both values, and the manager requires both exact matches before session creation. On unexpected parent EOF, it retries `zellij delete-session --force <exact-name>` and proves absence with `zellij list-sessions --short --no-formatting`. Zellij 0.44.3 reports an empty session list with code 1 and the canonical `No active zellij sessions found.` error. The manager and guardian treat only that exact nonzero result as an empty list. Normal retirement sends the same exact generation and capability, waits for the matching acknowledgement, closes the control pipe, and reaps the guardian. A bad or missing acknowledgement escalates through pipe close, process-group `SIGTERM`, and process-group `SIGKILL`, always awaiting the guardian close and fencing descendant cleanup clients. The fallback cannot leave a hung Zellij client orphaned after the guardian leader exits.

The process-global production manager is an immutable dependency-wired instance using real persistence, guardian spawning, and deadlines; tests create separate injected managers and cannot mutate production dependencies. It serializes provisioning, guardian exit, explicit retirement, recovery, and retry. It permits one active lifecycle and zero or more retiring lifecycles. Any unresolved retirement blocks every Zellij action and all new provisioning. Startup failure after the arming write enters the same exact deletion, child settlement, guardian-reap, and record-removal path.

Every parent-side deletion requires a successfully persisted `cleanup_pending` record, a fresh exact comparison of owner file, owner ID, generation, name, timestamp, and state, plus current lease authority for the retiring owner immediately before deletion. Record creation, identity-checked state/error updates, and compare-remove all share the same owner-record lock. After child settlement and guardian reap, the manager rechecks the retiring owner's exact lease authority; compare-remove then holds the record lock across its final reload, comparison, and unlink. A successor generation is neither overwritten, targeted, nor unlinked.

Each bounded Zellij client waits for its child process to close after TERM and KILL escalation. A timeout means that command completion is uncertain.

In every persisted Pi mode—TUI, RPC, JSON, and print—the dedicated session is provisioned and retained for the owner lifecycle. TUI displays its exact name in the standard footer; guardian loss or lifecycle blockage clears it. `--no-session`, or any context without both a persisted session file and session ID, creates no lifecycle, guardian, or Zellij client.

The validated runtime versions are Zellij 0.44.3 and Pi 0.83.0. Revalidate lifecycle behavior and action flags after an upgrade.

## Child launch

`subagent_start` opens a tab in the dedicated Zellij session. The tab runs a normal interactive Pi TUI.

Every Zellij action passes the durable exact session name through `--session`. The extension does not inspect the parent pane or trust `ZELLIJ_SESSION_NAME`.

The extension uses `devx pi` when an executable `devx` exists. Otherwise, it uses the current Pi executable.

Every child starts with `--offline` and `--approve`. The approval trusts project-local resources for the child run. The command loads `child.ts` through `-e`, so other extensions and provider proxies remain available.

The parent creates the listener before it opens the tab. The child connects to that listener and sends a fenced `hello` frame.

The initial task and later messages use IPC. The extension does not type prompts into a terminal or scrape the screen.

Nested children cannot start another delegated child.

## Authority and ownership

The extension separates durable ownership from live control.

- The canonical parent session file identifies the durable owner.
- The parent session ID validates that session file.
- A random process-wide controller ID identifies one live controller process.
- An exclusive renewable lease grants live control.
- The child ID identifies one logical child.
- A random incarnation identifies one child process.
- The saved child session file is the durable resume target.

The process-wide controller ID survives a real `/reload`. A fresh process gets a different controller ID.

Canonicalization resolves the nearest existing ancestor. Owner identity stays stable before and after the parent session file appears.

The lease expires after 30 seconds. Another controller can reclaim it only after an additional 5-second grace period.

The lease records a PID for diagnostics only. The extension never uses PID state as takeover authority. Expiry authorizes a takeover by a *different* controller; it never forces the recorded holder to abandon a record that still names it. Ordinary renewal and retained maintenance therefore share one rule: they require the exact lease file and exact owner/controller identity to remain present, they can extend that existing record after expiry, and they never recreate an absent lease or overwrite a lease elected for another controller. Because expiry is wall-clock based, a suspended host can lapse a lease that no other process ever contested; on-demand renewal before each authorized action reclaims it instead of latching a permanent loss.

When the lease genuinely is not held, the failure text names the exact record path, the recorded PID, whether that PID is still running, the expiry instant, and whether the record belongs to this controller or a foreign one. Only an actively held foreign lease is worth waiting for; every other case is resolved by `/reload`, which re-establishes the controller with the same process-wide controller ID.

A non-holder does not load children, bind sockets, poll panes, write the owner registry, or perform destructive parent actions. Failed replacement retirement and unresolved startup cleanup retain the exact old lease in a process-global authority manager that survives `/reload` and renews every unresolved retiring-owner lease independently of the current owner. Safe maintenance can extend the same controller's existing authority after its ordinary expiry window, but never recreates a missing lease or overwrites a lease elected for another controller. Later establishment first requires authority for every retained retirement, finishes old cleanup before provisioning, and releases each old lease only after compare-and-remove has removed its managed-session record. Missing or stolen old authority blocks the new owner. Final process quit stops retained renewal and releases those leases so guardian EOF semantics can take over.

A same-process `/reload` can reattach live children for the same owner because it preserves the active dedicated session and each pane's original launch-controller marker. A fresh process treats any durable managed-session record as cleanup work rather than adopting live panes.

## Storage

The extension derives `owner-key` from the canonical parent session file.

```text
<agent-dir>/sessions/subagents/controllers/<owner-key>/
  lease.json
  registry.json
  managed-session.json
  children/<child-id>/<incarnation>/bridge.sock
```

Per-child artifacts remain at this path:

```text
<agent-dir>/sessions/subagents/<child-id>/
```

These artifacts include the prompt, child event log, saved Pi session, and the latest-result compatibility file.

The shared `result.md` file atomically mirrors the latest settled run after exact persistence succeeds. Empty failed or aborted output replaces older content.

Each settled run also has durable exact artifacts:

```text
<agent-dir>/sessions/subagents/<child-id>/runs/<run-id>/
  result.md
  result.json
```

The Markdown file contains only the exact run output. The JSON file records the run outcome, incarnation, and settlement time.

The extension writes both files in a private temporary directory. An atomic directory rename publishes the complete immutable pair.

The first concurrent publisher wins. Later writers read that pair and never replace it.

Result persistence is best-effort. A settlement continues after a write failure, and diagnostics record the failure.

The extension creates private directories with mode `0700`. It creates lease, registry, prompt, result, and socket files with restrictive permissions.

Long socket paths use a private incarnation-specific directory below `/tmp`. The extension never changes permissions on the shared temporary directory.

The legacy global registry remains untouched:

```text
<agent-dir>/sessions/subagents/registry.json
```

The extension never reads, writes, deletes, or automatically adopts entries from that file. Old unfenced children remain orphaned for safety.

## IPC fences

Every child frame carries these values:

- the canonical owner session file
- the owner session ID
- the launch-controller ID
- the child ID
- the child incarnation
- the connection ID

Parent frames carry the same owner and incarnation identity. The child validates them before it accepts a parent action.

The parent validates frame identity before each state change. It also checks the current lease on disk before an authorized mutation.

Each child handle serializes its IPC mutations. This queue preserves wire order across asynchronous lease checks.

A new connection cannot change its identity after `hello`. Delayed frames from an old incarnation cannot mutate a resumed child.

Pane markers contain the full identity and socket path. Launch-time discovery validates the tab, pane, command, and markers. Later interaction and cleanup target the saved stable terminal pane directly without a pane snapshot. If `new-tab` completion or launch-time pane discovery is ambiguous, targeted cleanup is not accepted without a pane ID: the manager retires the whole dedicated session and proves it absent, or remains blocked in durable cleanup. Whole-session settlement first closes IPC ingress and drains each handle's serialized mutation chain and persistence before writing the final registry, so no queued frame can mutate or persist after settlement.

## Results and notifications

The child streams structured lifecycle events to the parent. Existing assistant events provide the final response.

The extension saves each response in an immutable `runs/<run-id>` artifact pair. A later run never overwrites that pair.

Settlement notifications arrive automatically after a run settles. Each notification includes the child ID and exact run ID. It starts a parent follow-up turn while the child remains alive.

`subagent_result` retrieves one exact run by child ID and run ID. It never falls back to the latest result.

The tool returns these stable status and reason combinations:

| Status | Reason | Meaning |
| --- | --- | --- |
| `unknown_child` | `unknown_child` | The child ID is unknown. |
| `pending` | `run_active` | The requested run is the current active run. |
| `missing` | `artifact_missing` | A known historical run has no artifact pair. |
| `missing` | `run_not_known` | The requested run is newer than the child run cursor. |
| `incomplete` | `artifact_incomplete` | Only one file exists in the final run directory. |
| `invalid_metadata` | `metadata_invalid` | The metadata file is invalid or describes another run. |
| `unreadable` | `artifact_unreadable` | The tool cannot read one or both files. |
| `available` | `result_available` | The complete exact result is available. |

Only an `available` result includes `outcome`. Empty output remains an available result with its actual outcome.

Notifications batch nearby settlements and direct the parent to `subagent_result`.

After `subagent_start`, continue other work or end the current turn. Rely on settlement notifications for completion.

Do not poll `subagent_status` or use sleep loops to wait for completion.

Use `subagent_status` only for live lifecycle and diagnostic information. Never use it as a completion check.

A settled child remains available for later turns. The child remains interactive during the active parent lifecycle.

## Resume

`subagent_resume` applies only to a stopped child with a nonempty saved Pi session file.

The extension launches Pi with this exact saved file:

```text
--session <absolute-child-session-file>
```

Resume keeps the logical child ID. It creates a new incarnation, socket, tab, pane, process, and connection.

Resume is blocked while required terminal cleanup remains pending or failed. The controller must complete cleanup before it can create a new pane.

The resumed child starts its run counter from the prior parent cursor. Run and settlement IDs therefore remain monotonic.

Resume clears the prior kill fence and stale settlement state. It preserves the monotonic run and settlement cursors.

The full owner and incarnation fence makes logical ID reuse safe. Old frames and old pane identities cannot affect the new incarnation.

## Liveness

IPC is the only authority for child liveness. Zellij performs actions, but it never proves background liveness.

One controller watchdog sweeps every 5 seconds. It sends a ping after 10 seconds without a valid current IPC frame.

The child must return a pong with the exact ping ID on the same connection epoch. A missed matching pong after 15 seconds declares the incarnation dead.

A current socket close starts a 30-second reconnect grace period. A valid fenced hello clears that deadline.

A clean `quit` bypasses reconnect grace. A late frame cannot revive a stopped incarnation.

The watchdog uses a monotonic clock. If the controller stalls for more than 15 seconds, it resets connected observation windows and restarts disconnected grace periods.

After death, the controller closes the saved stable terminal pane with `close-pane --pane-id terminal_<id>`. It never closes a reusable tab ID.

Cleanup uses the saved Zellij session name. It retries direct idempotent pane closure immediately, after 2 seconds, and after 10 seconds.

Each Zellij action has a 2,500-millisecond client timeout. The client receives `SIGTERM`, then `SIGKILL` after 250 milliseconds if necessary.

The registry persists pending cleanup intent before the first close action. A failed write postpones cleanup until a durable retry succeeds.

Queued registry writes capture their state when requested. An earlier write cannot duplicate a later terminal-state snapshot.

A same-process `/reload` controller retries pending pane cleanup without pane discovery. A fresh process instead retires the recorded whole dedicated session before provisioning.

Heartbeats do not update user activity, write the registry, or refresh the UI. Status and result return controller state without Zellij queries.

Stopped children leave the active widget. Their metadata, history, and artifacts remain available until retention or explicit cleanup removes them.

## Parent lifecycle

The extension treats parent lifecycle events as follows:

| Event | Behavior |
| --- | --- |
| `/reload` | The same process preserves the lifecycle object, exact session, guardian object/control pipes, controller ID, lease, and child processes. The replacement extension restores the same footer and reattaches IPC. |
| `/new` | Delete the prior owner's entire dedicated session, settle and persist its registry, reap its guardian, remove its ownership record, then allow the new owner to provision. |
| `/resume` | Apply the same whole-session retirement before the resumed owner provisions. |
| `/fork` or `/clone` | Apply the same whole-session retirement before the forked owner provisions. |
| Normal quit | Delete the entire dedicated session, settle and persist every tracked child, reap the guardian, then remove `managed-session.json` and release the lease. |
| Unexpected guardian death | Immediately clear the footer and block actions, persist `cleanup_pending`, delete and verify the exact session, settle the registry, reap the guardian, and remove the record. An unresolved step remains retryable and blocks provisioning. |
| Abrupt Pi-parent failure, including `SIGKILL` | One abrupt Pi-parent process failure is covered by guardian control-pipe EOF when the guardian, host and pipe semantics, Zellij server, and configured executables remain operational. |

The registry is settled durably before the managed ownership record disappears. A later establish attempt first retries every pending retirement and creates nothing until all retries succeed.

The abrupt-failure guarantee covers only one failed Pi parent process. Simultaneous Pi-parent and guardian failure, host or power failure, and persistently broken Zellij are not guaranteed. A later controller performs best-effort durable recovery from `arming`, `active`, or `cleanup_pending`; this is recovery, not a guarantee that cleanup happened at crash time.

A settled child remains alive and interactive during the active parent lifecycle. Settlement never calls `ctx.shutdown()`.

## Tools

The extension registers nine tools.

- `subagent_start {task, model, thinking, name?, cwd?, systemPrompt?}`
  - The model and thinking level are mandatory.
  - The tool starts a visible child and waits for a bounded IPC handshake.
- `subagent_list {includeFinished?}`
  - The tool lists current and retained children for the active owner.
- `subagent_status {id}`
  - The tool returns lifecycle, activity, identity, usage, diagnostics, and artifact paths.
- `subagent_result {id, runId}`
  - The tool returns the exact persisted output and actual outcome for one settled run.
- `subagent_steer {id, message}`
  - The tool sends guidance during the current child turn.
- `subagent_follow_up {id, message}`
  - The tool sends another child turn.
- `subagent_interrupt {id}`
  - The tool sends `Esc` directly to the saved stable terminal pane.
- `subagent_kill {id}`
  - The tool interrupts, then declares death and closes the saved stable terminal pane.
- `subagent_resume {id, task?}`
  - The tool reopens the exact saved child conversation in a new process incarnation.

## Commands

- `/subagents` opens the interactive inspector.
- `/subagents-toggle` toggles the compact active-child widget.
- `/subagents-kill-all` terminates all live children that this controller owns.

## State authorities

The extension uses separate authorities for separate facts.

- Companion IPC frames define liveness, live run state, output, tools, usage, and errors.
- Direct Zellij actions operate only on saved stable pane identities.
- The owner lease defines control authority.
- The Pi session JSONL defines durable conversation history.
- `child-events.log` and `dump-screen` provide diagnostics only.

## Verification

Run the deterministic suite from this directory:

```sh
PI_TEST_PACKAGE_DIR=/path/to/pi-0.83.0 ./test.sh
```

The suite covers per-run results, settlement notifications, owner isolation, lease races, strict IPC fences, reconnect state, stable pane cleanup, action bounds, resume, lifecycle, liveness, and UI behavior.

A separate disposable integration gate must use a real Pi and a real Zellij session. It must set a disposable `PI_CODING_AGENT_DIR`.

The integration gate must not use a normal user registry, session, socket, process, tab, or pane.

A non-TTY process cannot host this interactive gate because Zellij requires terminal raw mode. In that environment, run the deterministic IPC suite and a disposable `close-pane` command smoke test instead.

## Residual risks

- Pi lifecycle and Zellij action behavior remain version-specific.
- Simultaneous parent-and-guardian failure, host or power loss, broken pipe semantics, an unavailable guardian executable, and persistently broken Zellij are outside the abrupt-parent cleanup guarantee.
- Durable records permit later best-effort recovery, but cannot guarantee immediate cleanup under those failures.
- A Zellij action timeout leaves its result uncertain. Exact whole-session deletion and direct pane closure are retried only through their idempotent lifecycle paths.
- IPC assumes same-user local trust. Multi-user control requires authentication and a different protocol.
