# pi-delta

A [Pi](https://pi.dev) extension that turns Pi sessions into multiplayer [Delta](https://delta.dev) threads. It follows Delta's [plugin guide](https://delta.dev/docs/cli/build-a-plugin) and speaks recording contract 8 (Delta 0.22.0 or later).

## Install

```bash
pi install /path/to/pi-delta-plugin
```

For a one-off run, use `pi --extension /path/to/pi-delta-plugin/src/index.ts`.

The extension looks for the Delta CLI in the Delta app bundle first, then on `PATH`, and uses the first `delta` that answers `delta --json thread contract`. This skips the `git-delta` pager, which also installs a `delta` binary. Set `PI_DELTA_CLI` to point at a specific executable. You need to be signed in to Delta with an organization selected (`delta org list`).

## Commands

- `/delta share` asks whether to share the session with your current organization or sync it privately. It then creates the thread, attaches and syncs the git checkout (including uncommitted changes), and uploads the conversation so far.
- `/delta share ada@example.com, lin@example.com` shares privately and invites those people.
- `/delta join <share link or thread ID>` mounts the thread's files and switches Pi to a new session inside the mounted directory.
- `/delta status` shows the thread link, whether files are syncing, and how many records are waiting to send.
- `/delta retry` resumes recording after a paused error.
- `/delta leave` stops recording and releases the synced files. The thread stays in Delta.

A shared or joined session reconnects by itself when you resume it in Pi.

## How it works

- Each finished Pi message becomes a Delta record: user prompts become `user_message`, assistant text becomes `agent_message`, thinking becomes `agent_thought`, and tool calls and results become `tool_call_update`. Each Pi run is a Delta turn, opened with a `running` state update and closed with `idle`.
- Records are saved to `~/.pi/agent/delta/sessions/<session id>.json` before they are sent with `delta thread append`, and removed once Delta acknowledges them. Failed sends are retried with the same sequence numbers, so nothing is lost or duplicated across crashes and restarts.
- `delta thread watch --participate Pi` runs for the whole session. Teammates' completed messages and tool calls are added to Pi's context as `[Delta]` messages without starting a turn. Messages that arrive mid-turn are held until the turn ends.
- If a teammate takes over the thread's turn, Pi stops its own turn. Tool effects that already ran are not undone.

## Not supported yet

- Subagent child threads.
- Offline recording (`--acknowledge local`).
- The `.delta/settings.json` automatic sharing policy.
- Installing the Delta CLI automatically.

## Development

```bash
bun install
bun run check   # typecheck and tests
bun run lint
```
