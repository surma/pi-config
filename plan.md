# IPC Heartbeat Liveness Implementation Plan

**Goal:** Replace Zellij liveness polling with fenced IPC heartbeats and direct cleanup of dead Pi panes.

**Architecture:** One controller watchdog evaluates IPC state for every owned child. Zellij executes cleanup actions but never determines background liveness.

**Tech stack:** TypeScript, Node.js Unix sockets, Pi extensions, Zellij 0.44.3, and the Node test runner.

---

## 1. Document status

This document specifies a future implementation. It does not authorize implementation on the current `main` branch.

The design goal is complete. No source file contains this implementation yet.

The repository state at design time was:

- Repository: `/Users/surma/.pi/agent/git/github.com/surma/pi-config`
- Repository commit: `1ae0e5a9972f228e1db6f4cdc06777d35d51ed16`
- Branch: `main`
- Zellij version: `0.44.3`
- Node.js version: `v24.15.0`

Before implementation, create an approved branch or worktree. Do not implement this plan directly on `main` without explicit approval.

## 2. Executive decision

IPC becomes the only authority for child liveness.

A missed fenced heartbeat declares the child dead. The controller does not ask Zellij whether the child remains alive.

A current socket closure starts a bounded reconnect grace period. Grace expiry also declares the child dead.

After either death decision, the controller directly closes the saved terminal pane. It does not request `list-panes` first.

Zellij remains an actuator. Zellij does not remain a liveness oracle.

## 3. Product requirements

The implementation must satisfy these requirements:

1. The parent must send heartbeats through the existing local IPC connection.
2. The child must answer each heartbeat through the same connection.
3. A missing heartbeat response must declare the child dead.
4. The controller must close the dead Pi pane directly.
5. An externally closed tab must disappear from parent state within dozens of seconds.
6. The controller must permit brief reconnects after socket closure.
7. No timer may invoke `zellij action list-panes`.
8. `subagent_wait` must not poll Zellij.
9. `subagent_status` must not probe Zellij.
10. Heartbeats must not update user activity timestamps.
11. Heartbeats must not cause registry writes or UI refreshes.
12. Stale frames must not revive a dead incarnation.
13. Zellij subprocesses must have bounded execution time.
14. Cleanup retries must be bounded and idempotent.
15. The controller must use one watchdog timer, not one timer per child.

## 4. Non-goals

This change does not redesign the following systems:

- Run settlement
- Exact result persistence
- Owner leases
- Child resume semantics
- The inspector layout
- Model selection
- Nested child restrictions
- The IPC schema version
- Zellij itself

This change must not add a general process supervisor. It must use the existing IPC and Zellij integration.

## 5. Incident context

### 5.1 Observed failure

The old design called Zellij once each second while any child remained alive.

`extensions/subagent/index.ts` contains the current one-second timer near `reconcileLivenessTimer()` and `livenessTick()`.

Each tick calls `listPanes()`. The call reconciles all live handles against one Zellij snapshot.

The extension also calls `probeProcess()` from these paths:

- IPC connection closure
- `subagent_status`
- The initial phase of `subagent_wait`
- The repeated wait probe
- Explicit termination

The repeated actions produced long-lived Zellij clients and action pressure.

The captured Zellij log contained these messages:

```text
Action DumpLayout did not complete within 1s timeout
Action NewTab did not complete within 1s timeout
Tab with index ... not found. Cannot apply layout!
```

The captured log path was:

```text
/private/var/folders/th/cvzz2s0x6yx3ykfz3j1b3dqw0000gn/T/zellij-501/zellij-log/zellij.log
```

Several orphaned `zellij action list-panes --json -a` processes remained for 20 to 21 hours.

### 5.2 Zellij timeout behavior

The inspected Zellij source commit was:

```text
812ad861bc3f4a8ba6f411c1a3b1163bfef43766
```

Zellij defines a one-second action deadline here:

```text
/Users/surma/src/github.com/zellij-org/zellij/zellij-server/src/route.rs:36
```

The relevant definition is:

```rust
const ACTION_COMPLETION_TIMEOUT: Duration = Duration::from_secs(1);
```

The route reports the timeout near lines 71 through 78 in the same file.

The extension currently adds no timeout around its own action subprocess. Therefore, the client process can survive a server-side timeout.

### 5.3 Current session resolution cost

`extensions/subagent/zellij.ts` resolves the current session before every action.

Inside Zellij, `ensureZellij()` performs these operations:

1. It lists every session.
2. It calls `list-panes --json -a` for every session.
3. It finds the session that contains the parent pane.
4. It then performs the requested action.

This behavior multiplies one logical action into several Zellij actions.

### 5.4 Existing IPC support

The protocol already includes the required heartbeat frames.

`extensions/subagent/ipc.ts` defines these parent and child frames:

```ts
| { type: "ping"; id: string }
```

```ts
export interface PongFrame extends ChildFrameBase {
  type: "pong";
  id?: string;
}
```

`extensions/subagent/child.ts` already answers a parent ping with the same identifier.

`extensions/subagent/ipc.ts` already exposes these callbacks:

- `onPong`
- `onConnectionClose`
- `onConnectionError`

`extensions/subagent/ipc-child.ts` reconnects automatically after socket closure.

The reconnect delay starts at 200 milliseconds. It caps at 3,000 milliseconds.

Each reconnect creates a new child connection identifier. A reconnect sends a new `hello` and snapshot.

Every child frame carries these fences:

- The schema version
- The child identifier
- The child connection identifier
- The owner session file
- The owner session identifier
- The launch controller identifier
- The child incarnation
- The child timestamp

The controller already validates these fences before state mutations.

## 6. Safety facts from Zellij

### 6.1 Tab identifiers can be reused

Zellij allocates a new tab identifier from the highest live tab identifier plus one.

The implementation is here:

```text
/Users/surma/src/github.com/zellij-org/zellij/zellij-server/src/screen.rs:1701
```

The function is:

```rust
fn get_new_tab_id(&self) -> usize {
    if let Some(id) = self.tabs.keys().last() {
        *id + 1
    } else {
        0
    }
}
```

If the highest tab closes, the next tab can receive that identifier. A delayed `close-tab-by-id` can therefore close an unrelated replacement tab.

The heartbeat cleanup path must not use `close-tab-by-id`.

### 6.2 Terminal pane identifiers do not repeat

The Unix backend allocates terminal identifiers from one atomic counter.

The implementation is here:

```text
/Users/surma/src/github.com/zellij-org/zellij/zellij-server/src/os_input_output_unix.rs:453
```

The function uses `fetch_add(1, Ordering::Relaxed)`. It does not recycle a removed terminal identifier.

The cleanup path must target the captured terminal pane identifier.

The required command is:

```text
zellij --session <session> action close-pane --pane-id terminal_<paneId>
```

Zellij 0.44.3 documents this option through:

```text
zellij action close-pane --help
```

The help output accepts `terminal_1`, `plugin_2`, or a bare integer.

### 6.3 Dedicated tab behavior

A delegated child starts in a dedicated tab with one terminal pane.

Closing that terminal pane removes the dedicated tab. If a user added panes, cleanup preserves those unrelated panes.

This behavior is safer than closing the entire tab. It still terminates the dead Pi pane.

### 6.4 Session scope

Terminal identifiers are unique only within one live Zellij server session.

The controller must save the resolved session name with each handle. It must send cleanup to that saved session.

If a session rename causes an action failure, the controller may resolve the parent session once. It must not poll for the child.

The resolver must prove that the new name contains the current parent pane. It must not trust only a stale environment variable.

## 7. Design alternatives

### 7.1 Recommended: parent-driven ping and direct pane cleanup

The parent owns one watchdog. It sends a ping only after IPC silence.

The existing child immediately returns a pong. The parent treats a missed pong as authoritative death.

Advantages:

- The protocol already supports this design.
- The parent controls all deadlines.
- Active children do not receive unnecessary heartbeats.
- One timer handles all children.
- No Zellij query determines liveness.
- Cleanup targets one stable pane identifier.

This plan selects this approach.

### 7.2 Rejected: child-pushed heartbeat

Each child could send a periodic heartbeat without a parent request.

This approach adds one timer per child. It also adds frames while normal event traffic already proves connectivity.

The parent still needs a timeout sweep. Therefore, the child timer adds complexity without removing parent state.

### 7.3 Rejected: Zellij probe after heartbeat timeout

The parent could request one Zellij snapshot after a missed heartbeat.

This approach contradicts the selected failure meaning. A missed heartbeat already means death.

It also restores the dependency that caused the incident. The plan therefore rejects this approach.

### 7.4 Rejected: direct tab closure

The parent could call `close-tab-by-id` after heartbeat expiry.

Zellij can reuse the highest closed tab identifier. A delayed action could close a replacement tab.

The plan therefore closes the monotonic terminal pane identifier instead.

### 7.5 Rejected: direct PID signals

The parent receives the child Pi process identifier in `hello`.

A delayed signal can target a reused operating system process identifier. The current protocol does not carry a process birth token.

Zellij already owns the process tree. The controller should ask Zellij to close the stable terminal pane.

## 8. Timing model

Use these constants:

```ts
export const HEARTBEAT_SWEEP_MS = 5_000;
export const HEARTBEAT_IDLE_MS = 10_000;
export const HEARTBEAT_RESPONSE_MS = 15_000;
export const RECONNECT_GRACE_MS = 30_000;
export const WATCHDOG_STALL_MS = 15_000;
export const ZELLIJ_ACTION_TIMEOUT_MS = 2_500;
export const ZELLIJ_ACTION_KILL_GRACE_MS = 250;
export const CLEANUP_RETRY_DELAYS_MS = [0, 2_000, 10_000] as const;
```

### 8.1 Healthy connection

Normal child frames suppress unnecessary pings.

After 10 seconds without a valid current frame, the next sweep sends one ping.

The child gets 15 seconds to return the matching pong. Sweep alignment adds at most five seconds.

The worst normal detection time is approximately 30 seconds after the last valid frame.

### 8.2 Disconnected connection

A current socket closure starts a 30-second reconnect grace period.

Sweep alignment adds at most five seconds. The parent therefore classifies the child within approximately 35 seconds.

The child reconnect backoff reaches only three seconds. A healthy child gets several reconnect attempts before grace expires.

### 8.3 Clean quit

A `bye` frame with reason `quit` skips reconnect grace.

The parent marks the child stopped immediately. It then performs idempotent pane cleanup.

### 8.4 Controller suspension

A suspended parent must not kill every healthy child after it resumes.

The watchdog tracks its prior sweep time. A gap above `WATCHDOG_STALL_MS` means the parent missed its own observation window.

After such a gap, the watchdog resets connected heartbeat baselines. It restarts disconnected grace periods.

The parent must observe one complete response window before it declares death.

Use a monotonic clock for watchdog decisions. Use wall time only for durable user timestamps.

In Node.js, use `performance.now()` for watchdog deadlines. Continue to use `Date.now()` for persisted timestamps.

## 9. State model

### 9.1 Per-handle state

Add this state to `SubagentHandle`:

```ts
interface PendingHeartbeat {
  id: string;
  sentAt: number;
  deadlineAt: number;
  parentConnectionId: string;
  childConnectionId: string;
}

interface TerminalCleanupState {
  status: "none" | "pending" | "complete" | "failed";
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
}
```

Add these fields:

```ts
zellijSessionName?: string;
lastIpcFrameAt: number;
pendingHeartbeat?: PendingHeartbeat;
disconnectedAt?: number;
disconnectDeadlineAt?: number;
deathReason?: "heartbeat_timeout" | "reconnect_timeout" | "quit" | "kill";
terminalCleanup: TerminalCleanupState;
```

`lastIpcFrameAt` uses monotonic time. Do not persist it.

`pendingHeartbeat` uses monotonic time. Do not persist it.

The disconnect fields use monotonic time. Do not persist them.

Persist the Zellij session name and cleanup requirement. The persistence rules appear in Section 13.

### 9.2 Controller state

Add these controller fields:

```ts
let watchdogTimer: NodeJS.Timeout | undefined;
let watchdogSweepActive = false;
let lastWatchdogSweepAt = performance.now();
```

The controller owns only one watchdog timer.

The timer remains active while one live handle or one pending cleanup exists.

### 9.3 State table

| State | Connection | Deadline | Allowed transition |
| --- | --- | --- | --- |
| Healthy | Current connection | None | Send a ping after idle time. |
| Awaiting pong | Current connection | Pong deadline | Return to healthy or declare death. |
| Reconnecting | No current connection | Reconnect deadline | Accept `hello` or declare death. |
| Dead | Ignored | None | Start or continue terminal cleanup. |
| Cleanup complete | Ignored | None | Retain artifacts only. |
| Cleanup failed | Ignored | Retry only by policy | Report the cleanup error. |

## 10. Frame handling rules

### 10.1 Current frame definition

A frame counts as current only after all existing identity checks pass.

The frame must match these values:

- The logical child identifier
- The owner session file
- The owner session identifier
- The launch controller identifier
- The incarnation
- The parent connection identifier
- The child connection identifier

A malformed frame never updates liveness.

A stale frame never updates liveness.

A frame from a stopped incarnation never updates liveness.

### 10.2 Passive liveness

Every valid current frame updates `lastIpcFrameAt`.

This rule includes these frame types:

- `hello`
- `snapshot`
- `event`
- `ack`
- `bye`
- `pong`

Normal event traffic therefore suppresses idle pings.

### 10.3 Strict pong completion

Once the parent sends a ping, only its matching pong clears the heartbeat deadline.

The pong must match:

- `pendingHeartbeat.id`
- `pendingHeartbeat.parentConnectionId`
- `pendingHeartbeat.childConnectionId`
- The current owner and incarnation fences

Another valid frame still updates passive liveness. It does not clear an outstanding ping.

This strict rule tests the control path itself. It also rejects old buffered pongs.

### 10.4 Hello behavior

A valid current `hello` establishes a new connection epoch.

It performs these heartbeat changes:

```ts
handle.lastIpcFrameAt = monotonicNow();
handle.pendingHeartbeat = undefined;
handle.disconnectedAt = undefined;
handle.disconnectDeadlineAt = undefined;
handle.reconnecting = false;
```

A valid hello may preserve an alive handle during reconnect grace.

A hello must not revive a stopped handle. Resume must create a new incarnation.

### 10.5 Socket closure behavior

Only the current connection can start reconnect grace.

A stale connection closure does nothing.

A current closure performs these changes:

```ts
handle.ipcConn = undefined;
handle.pendingHeartbeat = undefined;
handle.disconnectedAt = monotonicNow();
handle.disconnectDeadlineAt =
  handle.disconnectedAt + RECONNECT_GRACE_MS;
handle.reconnecting = true;
```

If the prior `bye` reason was `quit`, the closure declares death immediately.

The callback must not call `probeProcess()`. It must not call any Zellij query.

## 11. Watchdog algorithm

### 11.1 Sweep outline

The watchdog runs every five seconds.

Each sweep follows this order:

1. Reject an overlapping sweep.
2. Verify current lease authority once.
3. Detect a parent stall.
4. Iterate all owned handles.
5. Enqueue each handle decision on its IPC mutation chain.
6. Recheck each deadline inside that chain.
7. Send due pings.
8. Declare expired handles dead.
9. Schedule due terminal cleanup actions.
10. Reconcile whether the single timer remains necessary.

### 11.2 No overlap

Use `watchdogSweepActive` as a controller guard.

The timer callback must return if a prior sweep still holds the guard.

Always clear the guard in `finally`.

A per-handle death or cleanup action must also use its existing serialized mutation chain.

### 11.3 Ping decision

Send a ping only if all conditions are true:

- The process state is `alive`.
- A current IPC connection exists.
- A child connection identifier exists.
- No heartbeat remains pending.
- The idle threshold expired.
- The controller still owns the lease.

Create an unpredictable identifier with the existing `createId()` helper.

Capture both connection identifiers before the send.

Set pending state before `connection.send()`. If the send throws, start reconnect grace or declare a transport failure.

The parent frame already includes the owner and incarnation identity.

### 11.4 Expiry decision

A pending heartbeat expires only if its exact connection epoch remains current.

Recheck these values inside `ipcMutationChain`:

- Process state
- Parent connection identifier
- Child connection identifier
- Ping identifier
- Ping deadline
- Lease authority

If any value changed, discard the stale expiry decision.

If all values still match, call the shared death transition with `heartbeat_timeout`.

### 11.5 Reconnect expiry

A reconnect deadline expires only while no current connection exists.

A valid hello clears the deadline before the watchdog can declare death.

If grace expires, call the shared death transition with `reconnect_timeout`.

### 11.6 Parent stall recovery

If the sweep gap exceeds `WATCHDOG_STALL_MS`, do not process expiries during that sweep.

For each connected child, clear the pending heartbeat and reset `lastIpcFrameAt`.

For each disconnected child, restart the reconnect deadline from the current monotonic time.

This rule prevents false death after machine sleep, debugger pauses, or controller stalls.

## 12. Authoritative death transition

Create one function for all liveness deaths:

```ts
async function declareDead(
  handle: SubagentHandle,
  reason: "heartbeat_timeout" | "reconnect_timeout" | "quit" | "kill",
): Promise<void>
```

The function must run on the handle mutation chain.

It performs these steps exactly once:

1. Verify lease authority.
2. Return if the handle already stopped.
3. Record `deathReason`.
4. Clear heartbeat and reconnect state.
5. Reject all pending acknowledgements.
6. Set `reconnecting` to false.
7. Mark the lifecycle stopped.
8. Set terminal cleanup to pending.
9. Notify all waiters.
10. Close the IPC connection and listener.
11. Refresh the UI once.
12. Persist the terminal state once.
13. Start the first direct cleanup action.

Use these error messages for liveness failures:

```text
IPC heartbeat timed out.
IPC reconnect grace expired.
```

A heartbeat must not update `lastActivityAt`. The terminal death transition may update it once.

A late frame after this transition must fail the process-state check.

## 13. Terminal cleanup

### 13.1 Direct action

Add a direct helper to `extensions/subagent/zellij.ts`:

```ts
export async function closePaneInSession(
  sessionName: string,
  paneId: number,
): Promise<void> {
  await actionInSession(zellijBinary(), sessionName, [
    "close-pane",
    "--pane-id",
    `terminal_${paneId}`,
  ]);
}
```

This helper must not call `ensureZellij()`. It must not call `listPanes()`.

### 13.2 Cleanup prerequisites

Cleanup requires these saved values:

- `zellijSessionName`
- `paneId`

If either value is missing, mark cleanup failed with a precise diagnostic.

The diagnostic must not claim that cleanup succeeded.

### 13.3 Retry schedule

Attempt cleanup immediately after the death transition.

If the action fails, retry after two seconds. If that action fails, retry after ten seconds.

Do not overlap cleanup actions for one handle.

After three failures, set `terminalCleanup.status` to `failed`. Keep the last error for status output.

The retries are direct idempotent actions. They are not Zellij probes.

### 13.4 Cleanup success

A successful action marks cleanup complete.

If Zellij reports that the pane is already absent, treat cleanup as complete. Add a test for the exact 0.44.3 behavior.

After success, perform these actions:

- Set cleanup status to `complete`.
- Clear `nextAttemptAt`.
- Clear the cleanup error.
- Persist once.
- Reconcile the watchdog timer.

### 13.5 Durable cleanup intent

Add these optional fields to `RegistryEntry`:

```ts
zellijSessionName?: string;
terminalCleanupPending?: boolean;
terminalCleanupError?: string;
```

Persist `terminalCleanupPending: true` before or with the stopped state.

Persist `terminalCleanupPending: false` after cleanup succeeds.

A controller restart must retry pending cleanup without any liveness probe.

Retention must not remove a stopped handle while cleanup remains pending.

### 13.6 Session rename recovery

Use the saved session name for the first cleanup attempt.

If the action reports a missing session, invalidate the cached session name. Resolve the parent session once before the next attempt.

The resolver may inspect the parent pane. It must not inspect the child to determine liveness.

Update all same-session handle records after a confirmed rename.

Do not automatically retry non-idempotent actions after a timeout. A `new-tab` timeout has an ambiguous result.

## 14. Zellij subprocess bounds

### 14.1 Current defect

`actionInSession()` currently waits without a client-side timeout.

An orphaned client can remain after Zellij abandons the action completion channel.

### 14.2 Required process control

Add one timeout to each spawned action process.

After `ZELLIJ_ACTION_TIMEOUT_MS`, send `SIGTERM` to the client process.

After `ZELLIJ_ACTION_KILL_GRACE_MS`, send `SIGKILL` if the process remains open.

Use one settlement guard. Clear both timers on `error` and `close`.

Reject with this message shape:

```text
zellij action <action> timed out after 2500ms for session <session>
```

Never merge stderr into stdout. Preserve each stream separately.

### 14.3 Cache behavior

Resolve the current Zellij session once. Cache the result.

Do not scan every session before every action.

Invalidate the cache only after a session-target failure. Do not invalidate it after an action-specific error.

Do not retry `new-tab` automatically. The server may have created the tab before the client timeout.

Direct pane closure is idempotent and may use the bounded retry policy.

## 15. Status and wait semantics

### 15.1 `subagent_status`

Remove the call to `probeProcess(handle)`.

Return the controller's current IPC state immediately.

Add these optional status details:

```ts
ipcLiveness: {
  state: "healthy" | "awaiting_pong" | "reconnecting" | "dead";
  heartbeatPending: boolean;
  deathReason?: string;
};
terminalCleanup: {
  status: "none" | "pending" | "complete" | "failed";
  attempts: number;
  lastError?: string;
};
```

Do not expose monotonic timestamps as wall-clock dates.

### 15.2 `subagent_wait`

Remove the initial Zellij probe.

Remove the 500-millisecond probe interval.

Keep these completion sources:

- A run settlement notification
- A terminal death transition
- The caller timeout
- Caller cancellation

The watchdog already notifies handle waiters after death.

### 15.3 `subagent_result`

Do not change exact result retrieval.

A death transition must not overwrite an available settled result.

## 16. Explicit termination

### 16.1 Current issue

`terminate()` currently performs repeated Zellij probes after it requests closure.

This loop runs every 100 milliseconds until the kill deadline.

The new implementation must remove that loop.

### 16.2 New kill sequence

Use this sequence for `subagent_kill`:

1. Verify lease authority.
2. Mark kill requested.
3. Suppress child settlement notifications.
4. Attempt the cooperative interrupt.
5. Wait for the existing short interrupt deadline.
6. Directly close the stable terminal pane.
7. Call the shared death transition with `kill`.
8. Report cleanup success or failure.

The close action itself replaces pane revalidation and process polling.

### 16.3 Interrupt action

`subagent_interrupt` may send `Esc` directly to the stable pane identifier.

It must not call `list-panes` first. The monotonic pane identifier prevents replacement targeting in the same session.

If the action fails, return a precise error. Do not infer liveness from that failure.

### 16.4 Parent shutdown

Normal parent shutdown must close each owned stable pane directly.

Do not validate each pane with `list-panes` first.

Use `Promise.allSettled()` so one failed cleanup does not block other children.

## 17. Startup reconciliation

### 17.1 Remove pane-based liveness

`reconcile()` currently loads the registry and obtains one Zellij pane snapshot.

It then calls `reconcileRegistryForOwner()` to mark absent panes stopped.

Replace that behavior with owner filtering and IPC reattachment.

### 17.2 New startup behavior

For each same-owner registry entry:

- Preserve stopped entries.
- Retry any durable cleanup requirement.
- Recreate live handles.
- Attach the IPC listener for each live handle.
- Mark each live handle as reconnecting.
- Start a 30-second reconnect deadline.
- Accept a valid fenced hello during that deadline.
- Declare death after expiry.

This approach uses IPC for recovery and liveness.

### 17.3 Registry helper replacement

Replace pane-based reconciliation with a helper such as:

```ts
export function registryEntriesForOwner(
  entries: RegistryEntry[],
  owner: OwnerIdentity,
): RegistryEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.ownerSessionFile === owner.ownerSessionFile &&
        entry.ownerSessionId === owner.ownerSessionId &&
        !!entry.incarnation,
    )
    .map((entry) => ({ ...entry }));
}
```

Remove obsolete pane reconciliation helpers if no caller remains.

## 18. File-level change map

### 18.1 Create `extensions/subagent/liveness.ts`

This module should contain pure timing state and decisions.

It should export:

- Timing constants
- `PendingHeartbeat`
- `TerminalCleanupState`
- A liveness state view
- Pure ping-due checks
- Pure heartbeat-expiry checks
- Pure reconnect-expiry checks
- Parent stall detection

The module must not import Zellij or Pi APIs.

### 18.2 Create `extensions/subagent/liveness.test.ts`

Use a fake monotonic clock through explicit numeric arguments.

Do not use real sleeps for pure state tests.

Test every threshold boundary and stale epoch condition.

### 18.3 Modify `extensions/subagent/test.sh`

Add `liveness.ts` to the `sources` array.

Add `liveness.test.ts` to the `tests` array.

Keep the current isolated temporary package layout.

### 18.4 Modify `extensions/subagent/index.ts`

Make these changes:

- Replace `livenessTimer` with `watchdogTimer`.
- Add the watchdog controller state.
- Add heartbeat state to `SubagentHandle`.
- Record current frames without `update()`.
- Implement `onPong`.
- Replace close probes with reconnect deadlines.
- Add `declareDead()`.
- Add direct cleanup scheduling.
- Remove `probeProcess()`.
- Remove `livenessTick()`.
- Remove `reconcileLivenessTimer()`.
- Remove Zellij probes from waits and status.
- Replace startup pane reconciliation.
- Remove the termination probe loop.
- Serialize cleanup details.
- Preserve late-frame fences.

### 18.5 Modify `extensions/subagent/zellij.ts`

Make these changes:

- Add bounded action subprocesses.
- Cache a successful session resolution.
- Add explicit cache invalidation.
- Return the session name from tab creation.
- Add `closePaneInSession()`.
- Stop calling `ensureZellij()` from direct cleanup.
- Remove `closeValidatedSubagentTab()` after callers migrate.
- Remove `revalidatePane()` after callers migrate.
- Retain launch-time pane discovery.
- Retain parent session selection.

### 18.6 Modify `extensions/subagent/registry.ts`

Make these changes:

- Add the session name field.
- Add durable cleanup fields.
- Replace pane-based owner reconciliation.
- Remove unused Zellij imports.
- Preserve compatibility with old registry entries.

### 18.7 Modify `extensions/subagent/tools.test.ts`

Replace both periodic Zellij liveness tests.

Add controller integration tests for heartbeat, reconnect, status, waits, and direct cleanup.

Update fake Zellij scripts to support `close-pane` with `--pane-id`.

Record every fake command so tests can assert zero `list-panes` calls.

### 18.8 Modify `extensions/subagent/ipc.test.ts`

Add strict ping and pong tests.

Verify that malformed and missing pong identifiers do not satisfy heartbeat state.

Keep protocol compatibility because the wire schema does not change.

### 18.9 Modify `extensions/subagent/ipc-child.test.ts`

Verify that reconnect creates a new connection identifier.

Verify that a ping after reconnect returns a pong from the new epoch.

### 18.10 Modify `extensions/subagent/child-bridge.test.ts`

Verify that the child echoes the exact ping identifier.

Verify that normal event flow remains unchanged.

### 18.11 Modify `extensions/subagent/launch.test.ts`

Replace validated tab-close tests with stable pane-close tests.

Add session cache and subprocess timeout tests.

Add a test that a non-idempotent action does not retry after timeout.

### 18.12 Modify `extensions/subagent/registry.test.ts`

Remove pane-based liveness expectations.

Add owner filtering, session persistence, and durable cleanup tests.

### 18.13 Modify `extensions/subagent/README.md`

Replace the complete `Liveness` section.

Update the IPC fence section with strict heartbeat matching.

Update parent shutdown behavior.

Update the test coverage summary.

## 19. Detailed implementation sequence

Follow test-driven development for each task. Run the complete extension suite after every task.

### Task 0: Establish an approved implementation branch

**Files:** None.

**Step 1: Confirm repository state**

Run:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
```

Expected result:

- The worktree contains only approved changes.
- The branch is not an unapproved implementation target.
- The baseline commit is known.

**Step 2: Create the approved branch or worktree**

Use the branch or worktree name that the user approves.

Do not guess a persistent workflow choice.

### Task 1: Record the baseline

**Files:** None.

**Step 1: Run the existing test suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All current subagent tests pass.
```

If the baseline fails, stop and diagnose the baseline before this implementation.

### Task 2: Add pure heartbeat decisions

**Files:**

- Create: `extensions/subagent/liveness.ts`
- Create: `extensions/subagent/liveness.test.ts`
- Modify: `extensions/subagent/test.sh`

**Step 1: Write failing boundary tests**

Cover these cases:

- No ping before 10,000 milliseconds
- A ping at 10,000 milliseconds
- No death before the 15,000-millisecond response deadline
- Death at the exact response deadline
- Reconnect expiry at 30,000 milliseconds
- No expiry after a detected parent stall
- No decision for a stopped child
- No expiry for a stale connection epoch

**Step 2: Run the suite and confirm failure**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
The new liveness tests fail because the module does not exist or lacks decisions.
```

**Step 3: Implement the pure module**

Keep the module free from timers, sockets, Pi APIs, and Zellij calls.

Pass all time values as monotonic numbers.

**Step 4: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass.
```

**Step 5: Review scope**

Confirm that this task adds no controller side effects.

### Task 3: Test strict heartbeat protocol behavior

**Files:**

- Modify: `extensions/subagent/ipc.test.ts`
- Modify: `extensions/subagent/ipc-child.test.ts`
- Modify: `extensions/subagent/child-bridge.test.ts`

**Step 1: Add strict pong tests**

Test exact identifier echo and reconnect epochs.

Test missing identifiers, stale identifiers, stale incarnations, and old connection identifiers.

**Step 2: Run the suite and confirm expected failures**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
Only tests that require new controller matching may fail.
```

The existing child echo test should already pass.

**Step 3: Make only required protocol changes**

Do not change `IPC_SCHEMA_VERSION`.

Do not make `PongFrame.id` wire-required until compatibility tests justify that change.

Require the identifier only in controller heartbeat completion.

**Step 4: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All protocol tests pass.
```

### Task 4: Add bounded Zellij actions

**Files:**

- Modify: `extensions/subagent/zellij.ts`
- Modify: `extensions/subagent/launch.test.ts`

**Step 1: Add a failing hung-client test**

Create a fake Zellij process that never exits.

Assert that the helper rejects after 2,500 milliseconds.

Assert that the fake process receives termination and does not remain alive.

**Step 2: Add a failing stderr separation test**

Make the fake process write different content to stdout and stderr.

Assert that the error preserves stderr without stream merging.

**Step 3: Implement the subprocess timeout**

Add `SIGTERM`, the 250-millisecond kill grace, and one settlement guard.

**Step 4: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass, and no fake Zellij process remains.
```

### Task 5: Cache session resolution

**Files:**

- Modify: `extensions/subagent/zellij.ts`
- Modify: `extensions/subagent/launch.test.ts`

**Step 1: Add a failing cache test**

Invoke several actions after one successful resolution.

Assert that only the first action lists sessions and parent panes.

**Step 2: Add a failing invalidation test**

Make the cached session reject an action with a missing-session error.

Assert that the cache invalidates once.

Assert that a later resolution identifies the parent pane again.

**Step 3: Add a non-idempotent action test**

Make `new-tab` time out after the server records its request.

Assert that the extension does not issue a second `new-tab` command.

**Step 4: Implement cache behavior**

Cache successful resolution. Invalidate only for session-target errors.

**Step 5: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass.
```

### Task 6: Add stable pane cleanup

**Files:**

- Modify: `extensions/subagent/zellij.ts`
- Modify: `extensions/subagent/launch.test.ts`

**Step 1: Add a failing command test**

Call `closePaneInSession("world-home", 42)`.

Assert this exact action shape:

```text
--session world-home action close-pane --pane-id terminal_42
```

Assert that no `list-panes` action occurs.

**Step 2: Add a tab reuse safety test**

Simulate a closed child tab and a replacement tab with the same tab identifier.

Give the replacement a different terminal pane identifier.

Assert that cleanup targets only the original terminal pane identifier.

**Step 3: Implement `closePaneInSession()`**

Use the provided session name directly.

Do not validate the tab or pane through a snapshot.

**Step 4: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass.
```

### Task 7: Extend registry state

**Files:**

- Modify: `extensions/subagent/registry.ts`
- Modify: `extensions/subagent/registry.test.ts`

**Step 1: Add persistence tests**

Cover the session name, pending cleanup, cleanup error, and old entries without new fields.

**Step 2: Add owner filter tests**

Assert that owner filtering does not infer liveness from pane snapshots.

**Step 3: Run the suite and confirm failure**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
The new registry tests fail against pane-based reconciliation.
```

**Step 4: Replace pane reconciliation**

Remove unused Zellij imports and pane liveness helpers.

Preserve stopped entries and durable cleanup requirements.

**Step 5: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass.
```

### Task 8: Integrate heartbeat receipt

**Files:**

- Modify: `extensions/subagent/index.ts`
- Modify: `extensions/subagent/tools.test.ts`

**Step 1: Add failing frame-accounting tests**

Verify that each valid current frame refreshes passive liveness.

Verify that stale frames do not refresh it.

Verify that no heartbeat frame changes `lastActivityAt`.

Verify that no heartbeat frame writes the registry or refreshes the UI.

**Step 2: Add failing pong tests**

Verify exact nonce and connection epoch matching.

Verify that another valid frame does not clear an outstanding ping.

**Step 3: Implement frame accounting**

Record monotonic heartbeat state after current-epoch validation.

Do not call `update()` for heartbeat state.

**Step 4: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass.
```

### Task 9: Integrate the single watchdog

**Files:**

- Modify: `extensions/subagent/index.ts`
- Modify: `extensions/subagent/tools.test.ts`

**Step 1: Add failing fake-clock tests**

Cover idle ping, pong deadline, reconnect deadline, parent stall, lease loss, and stale decisions.

**Step 2: Add a single-timer test**

Create several live handles.

Assert that the controller creates only one watchdog timer.

**Step 3: Add an overlap test**

Delay one authority check beyond another interval.

Assert that the controller does not overlap sweeps.

**Step 4: Implement watchdog scheduling**

Use one interval and the existing per-handle mutation chain.

**Step 5: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass.
```

### Task 10: Replace connection-close probes

**Files:**

- Modify: `extensions/subagent/index.ts`
- Modify: `extensions/subagent/tools.test.ts`

**Step 1: Add reconnect grace tests**

Test abrupt closure, reload closure, valid reconnect, clean quit, and grace expiry.

**Step 2: Add a late hello test**

Expire grace and declare death.

Then send a valid hello from the same incarnation.

Assert that the handle remains stopped and rejects the connection.

**Step 3: Implement reconnect deadlines**

Remove the immediate `probeProcess()` timer from `onConnectionClose`.

**Step 4: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass.
```

### Task 11: Add the death and cleanup transition

**Files:**

- Modify: `extensions/subagent/index.ts`
- Modify: `extensions/subagent/tools.test.ts`

**Step 1: Add heartbeat death tests**

Assert that timeout marks the handle stopped and closes `terminal_<paneId>`.

Assert zero `list-panes` calls.

**Step 2: Add reconnect death tests**

Assert the same direct cleanup after grace expiry.

**Step 3: Add durable cleanup tests**

Simulate a parent crash between stopped-state persistence and cleanup success.

Assert that a replacement controller retries cleanup from the registry.

**Step 4: Add bounded retry tests**

Fail all three close actions.

Assert delays of zero, two, and ten seconds.

Assert one final failed cleanup state.

**Step 5: Implement `declareDead()` and cleanup scheduling**

Use one transition for heartbeat timeout, reconnect timeout, clean quit, and explicit kill.

**Step 6: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass.
```

### Task 12: Remove background Zellij liveness

**Files:**

- Modify: `extensions/subagent/index.ts`
- Modify: `extensions/subagent/tools.test.ts`
- Modify: `extensions/subagent/registry.ts`
- Modify: `extensions/subagent/registry.test.ts`

**Step 1: Add a zero-poll integration test**

Run a healthy child through at least six watchdog intervals.

Deliver enough current frames to exercise both active and idle periods.

Assert that the fake Zellij command log contains zero `list-panes` actions after launch.

**Step 2: Add status and wait tests**

Call `subagent_status` repeatedly.

Run `subagent_wait` until timeout and until heartbeat death.

Assert zero Zellij queries from both tools.

**Step 3: Remove old code**

Remove these functions and fields:

- `probeProcess`
- `livenessTimer`
- `livenessTick`
- `reconcileLivenessTimer`
- The wait probe interval
- The status probe
- Pane-based startup reconciliation

**Step 4: Remove unused imports**

Remove `listPanes`, `paneMatchesSubagent`, and obsolete registry helpers from `index.ts`.

Keep launch-only Zellij functions.

**Step 5: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass, and the zero-poll assertions pass.
```

### Task 13: Simplify explicit termination

**Files:**

- Modify: `extensions/subagent/index.ts`
- Modify: `extensions/subagent/tools.test.ts`
- Modify: `extensions/subagent/launch.test.ts`

**Step 1: Add direct kill tests**

Assert that `subagent_kill` closes the stable pane without a preflight snapshot.

Assert that a failed cooperative interrupt does not prevent direct pane closure.

**Step 2: Add direct interrupt tests**

Assert that `subagent_interrupt` sends `Esc` to the stable pane without `list-panes`.

**Step 3: Remove termination polling**

Delete the 100-millisecond process probe loop.

Use direct close completion and the shared death transition.

**Step 4: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass.
```

### Task 14: Update status serialization and the UI

**Files:**

- Modify: `extensions/subagent/index.ts`
- Modify: `extensions/subagent/ui.ts`
- Modify: `extensions/subagent/ui.test.ts`
- Modify: `extensions/subagent/tools.test.ts`

**Step 1: Add serialization tests**

Test healthy, awaiting-pong, reconnecting, dead, pending-cleanup, complete-cleanup, and failed-cleanup output.

**Step 2: Keep heartbeat noise out of the UI**

Assert that a ping and pong do not refresh the inspector or widget.

**Step 3: Show actionable cleanup failure**

Expose the final cleanup error in status and diagnostics.

Do not add a permanent widget row for completed cleanup.

**Step 4: Run the suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass.
```

### Task 15: Update documentation

**Files:**

- Modify: `extensions/subagent/README.md`

**Step 1: Replace the liveness section**

Document heartbeat timing, strict pong matching, reconnect grace, direct cleanup, and parent stall protection.

**Step 2: Update Zellij behavior**

Explain that launch uses bounded discovery. Explain that liveness never uses Zellij snapshots.

**Step 3: Update lifecycle tables**

Document clean quit, external tab closure, heartbeat death, reconnect expiry, and late frame rejection.

**Step 4: Update the test summary**

List zero-poll, stable pane cleanup, timeout, reconnect, and durable cleanup coverage.

**Step 5: Review documentation accuracy**

Compare every documented timing value with exported constants.

### Task 16: Run final verification

**Files:** None, unless verification finds a defect.

**Step 1: Run the complete suite**

Run:

```bash
extensions/subagent/test.sh
```

Expected result:

```text
All tests pass.
```

**Step 2: Search for removed polling paths**

Run:

```bash
rg -n "probeProcess|livenessTick|reconcileLivenessTimer|setInterval.*probe|closeValidatedSubagentTab" extensions/subagent
```

Expected result:

```text
No production match remains.
```

Test names may contain migration history only if the names remain accurate.

**Step 3: Inspect remaining pane listings**

Run:

```bash
rg -n "listPanes|list-panes" extensions/subagent
```

Expected result:

- Production matches exist only for bounded launch or parent session resolution.
- No watchdog, status, wait, disconnect, or termination path lists panes.

**Step 4: Inspect timers**

Run:

```bash
rg -n "setInterval|setTimeout" extensions/subagent/index.ts extensions/subagent/zellij.ts
```

Expected result:

- One controller watchdog exists.
- Lease renewal remains separate.
- Bounded request, action, and cleanup deadlines remain.
- No Zellij poll interval exists.

**Step 5: Inspect the diff**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Expected result:

- `git diff --check` reports no whitespace errors.
- Every changed file maps to this plan.
- No unrelated file changed.

**Step 6: Perform one real Zellij smoke test**

Run a parent Pi inside Zellij 0.44.3.

Perform these checks:

1. Start one child.
2. Observe normal ping and pong behavior after IPC silence.
3. Close the child tab manually.
4. Confirm stopped state within 35 seconds.
5. Confirm that no periodic `list-panes` clients appear.
6. Start another child.
7. Freeze or break its heartbeat response in a controlled test build.
8. Confirm direct pane closure within 30 seconds.
9. Confirm that the parent remains responsive.
10. Confirm that Zellij creates no orphaned action clients.

**Step 7: Inspect Zellij logs**

Look for these failures:

```text
Action DumpLayout did not complete within 1s timeout
Action NewTab did not complete within 1s timeout
Tab with index ... not found
```

Expected result:

```text
The smoke test adds none of these failures.
```

## 20. Test matrix

| Scenario | Expected state | Zellij query count | Cleanup action |
| --- | --- | ---: | --- |
| Busy child sends events | Alive | 0 | None |
| Idle child returns pong | Alive | 0 | None |
| Pong has wrong nonce | Dead after deadline | 0 | Close stable pane |
| Pong comes from old connection | Dead after deadline | 0 | Close stable pane |
| Socket closes and reconnects | Alive | 0 | None |
| Socket closes without reconnect | Dead after grace | 0 | Close stable pane |
| Child sends clean quit | Stopped immediately | 0 | Close stable pane |
| User closes child tab | Stopped after grace | 0 | Idempotent close |
| Parent pauses for one minute | Alive after fresh window | 0 | None |
| Status runs repeatedly | Unchanged | 0 | None |
| Wait runs until timeout | Unchanged | 0 | None |
| Explicit kill | Killed | 0 preflight queries | Close stable pane |
| First close action times out | Dead, cleanup pending | 0 | Retry close |
| All close actions fail | Dead, cleanup failed | 0 | Three total attempts |
| Parent crashes before cleanup | Dead after recovery | 0 | Retry durable cleanup |
| Late hello after death | Remains stopped | 0 | No revival |
| New incarnation resumes | Alive in new pane | Launch-only queries | None |

## 21. Failure semantics

### 21.1 Heartbeat timeout

The controller records an explicit diagnostic:

```text
IPC heartbeat timed out after 15000ms for the current connection epoch.
```

The process state becomes stopped. The controller starts direct pane cleanup.

### 21.2 Reconnect timeout

The controller records:

```text
IPC reconnect grace expired after 30000ms.
```

The process state becomes stopped. The controller starts direct pane cleanup.

### 21.3 Cleanup timeout

The controller records the action name, session, pane identifier, attempt count, and timeout.

It must not claim that the pane closed.

### 21.4 Cleanup failure

After the final retry, status reports `terminalCleanup.status: "failed"`.

The registry retains durable cleanup intent. A replacement controller can retry later.

An explicit `subagent_kill` may retry failed cleanup.

### 21.5 Lease loss

A controller without authority sends no pings and performs no cleanup.

It stops its watchdog. A later lease holder recovers state from the registry and IPC.

### 21.6 Missing session or pane identity

A missing saved session or pane identifier prevents safe cleanup.

The controller reports the missing field. It does not fall back to tab closure or PID signals.

## 22. Race analysis

### 22.1 Pong and timeout race

Both mutations use the handle mutation chain.

The timeout rechecks the nonce and connection epoch after earlier callbacks complete.

A matching pong that enters the chain first cancels death. An expiry that enters first makes later frames irrelevant.

### 22.2 Reconnect and grace race

A valid hello clears the exact reconnect deadline on the mutation chain.

The expiry callback rechecks that no connection exists. It cannot kill a handle after an accepted hello.

### 22.3 Old socket closure

A replaced connection can close after a new hello.

The close callback compares `handle.ipcConn.id` with the closing connection. A mismatch does nothing.

### 22.4 Cleanup and late reconnect

The death transition marks the incarnation stopped before cleanup starts.

A late hello cannot restore it. The parent closes the listener during transport cleanup.

### 22.5 Parent stall and deadline

The watchdog does not trust deadlines that expired while the parent could not observe IPC.

It restarts the observation window after a large sweep gap.

### 22.6 Session rename and cleanup

The first close action can fail against the old session name.

A bounded resolver identifies the current parent session once. The next cleanup attempt targets the same stable pane identifier there.

### 22.7 Tab replacement

Cleanup never targets a tab identifier. A replacement tab with a reused tab identifier remains safe.

### 22.8 Zellij action timeout

A timeout means the action result is uncertain.

The close-pane action is idempotent, so a bounded retry is safe. `new-tab` never retries automatically.

## 23. Observability

Do not log each successful heartbeat. That output would add noise.

Record only these events:

- The first missed heartbeat death
- Reconnect grace expiry
- Controller stall reset
- Cleanup retry
- Cleanup failure
- Session cache invalidation
- Zellij action timeout

`subagent_status` should expose current liveness and cleanup summaries.

Do not persist monotonic timestamps. They have meaning only inside one controller process.

## 24. Performance expectations

A busy child produces no heartbeat traffic beyond its normal event stream.

An idle child receives at most one ping per idle window. A successful pong starts a new idle window.

The controller performs one in-memory sweep every five seconds. The sweep does not spawn a subprocess.

Zellij receives actions only for these events:

- Launch
- Explicit terminal interaction
- Direct cleanup
- One bounded session re-resolution after a target failure

The steady-state Zellij process count must remain unchanged across watchdog intervals.

## 25. Security and authority

Keep all current owner and incarnation fences.

A heartbeat must carry the same parent identity as any other parent frame.

A pong must carry the same child identity as any other child frame.

Only the current lease holder may send pings, declare death, persist state, or close panes.

The cleanup action must use the session and pane captured for the owned handle.

The implementation must never fall back to a bare PID signal.

The implementation must never close a reused tab identifier.

## 26. Compatibility

The IPC schema remains version 1.

Older compatible children already understand `ping` and return `pong`.

The parent accepts the existing optional pong identifier at the parser level. It requires an exact identifier for heartbeat completion.

Old registry entries can lack a session name and cleanup fields.

Such entries can reconnect through IPC. Cleanup requires a safely resolved session before any action.

Do not infer an unsafe session from a stale tab identifier.

## 27. Completion criteria

Implementation is complete only after every condition holds:

- The extension sends parent-driven IPC heartbeats.
- A missed matching pong declares death.
- A current socket closure permits 30 seconds of reconnect time.
- Grace expiry declares death.
- Both death paths directly close the stable terminal pane.
- No death path asks Zellij for liveness.
- No timer calls `list-panes`.
- Status performs no Zellij query.
- Wait performs no Zellij query.
- Startup recovery uses IPC grace instead of pane snapshots.
- Explicit kill contains no Zellij poll loop.
- Heartbeats do not update activity or persistence.
- Late frames cannot revive a stopped incarnation.
- Parent stalls cannot trigger immediate mass death.
- Zellij action clients have hard timeouts.
- Close retries remain bounded and idempotent.
- Pending cleanup survives controller restart.
- The complete automated suite passes.
- The real Zellij smoke test passes.
- No orphaned Zellij action process remains.

## 28. References

### Repository files

- `extensions/subagent/index.ts`
- `extensions/subagent/ipc.ts`
- `extensions/subagent/ipc-child.ts`
- `extensions/subagent/child.ts`
- `extensions/subagent/zellij.ts`
- `extensions/subagent/registry.ts`
- `extensions/subagent/lifecycle.ts`
- `extensions/subagent/tools.test.ts`
- `extensions/subagent/ipc.test.ts`
- `extensions/subagent/ipc-child.test.ts`
- `extensions/subagent/child-bridge.test.ts`
- `extensions/subagent/launch.test.ts`
- `extensions/subagent/registry.test.ts`
- `extensions/subagent/ui.test.ts`
- `extensions/subagent/test.sh`
- `extensions/subagent/README.md`

### Current implementation anchors

- `extensions/subagent/index.ts:304` declares the old liveness timer.
- `extensions/subagent/index.ts:846` defines `probeProcess()`.
- `extensions/subagent/index.ts:991` leaves `onPong` empty.
- `extensions/subagent/index.ts:992` handles IPC closure.
- `extensions/subagent/index.ts:1007` schedules a Zellij probe after closure.
- `extensions/subagent/index.ts:1159` defines explicit termination.
- `extensions/subagent/index.ts:1193` starts the termination probe loop.
- `extensions/subagent/index.ts:1464` probes before a wait.
- `extensions/subagent/index.ts:1487` starts repeated wait probes.
- `extensions/subagent/index.ts:1543` starts registry reconciliation.
- `extensions/subagent/index.ts:1700` defines the old timer reconciliation.
- `extensions/subagent/index.ts:1711` defines the old liveness tick.
- `extensions/subagent/index.ts:1965` probes during status.
- `extensions/subagent/zellij.ts:92` resolves the session.
- `extensions/subagent/zellij.ts:196` spawns an unbounded action process.
- `extensions/subagent/zellij.ts:381` validates before tab closure.
- `extensions/subagent/tools.test.ts:1490` tests periodic liveness.
- `extensions/subagent/README.md:187` begins the old liveness section.

Line numbers describe commit `1ae0e5a9972f228e1db6f4cdc06777d35d51ed16`. Future edits will move them.

### Zellij source anchors

- `zellij-server/src/route.rs:36` defines the one-second action timeout.
- `zellij-server/src/route.rs:71-78` reports action timeout failures.
- `zellij-server/src/screen.rs:1701` allocates tab identifiers from live tabs.
- `zellij-server/src/os_input_output_unix.rs:453` allocates monotonic terminal identifiers.
- `zellij-utils/src/input/actions.rs:1367` parses close-pane identifiers.

These anchors describe local Zellij source commit `812ad861bc3f4a8ba6f411c1a3b1163bfef43766`.

### Runtime evidence

- Zellij version: `zellij 0.44.3`
- Node.js version: `v24.15.0`
- Captured log: `/private/var/folders/th/cvzz2s0x6yx3ykfz3j1b3dqw0000gn/T/zellij-501/zellij-log/zellij.log`

The log path is temporary. Preserve relevant excerpts in a durable issue or pull request before cleanup removes that file.
