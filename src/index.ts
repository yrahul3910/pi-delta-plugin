import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { DeltaCli, DeltaError, type LongRunning } from "./cli.ts";
import { Recorder } from "./recorder.ts";
import { AnyObject, MountReady, OrganizationList, ThreadCreated, ThreadStatus, WorktreeCreated, WorktreeList } from "./schemas.ts";
import { deleteBinding, loadBinding, saveBinding, type Binding } from "./state.ts";
import { asRecordedMessage, translateMessage } from "./translate.ts";
import { ThreadWatch, type RemoteItem } from "./watch.ts";

const STATUS_KEY = "delta";
const REMOTE_MESSAGE_TYPE = "delta-remote";

type Mount = LongRunning<Static<typeof MountReady>>;

declare global {
  /**
   * Mount processes that must outlive one extension runtime, keyed by Pi session ID.
   *
   * `/delta join` starts the mount, then switches Pi to a new session inside it, which replaces this runtime. Reloads
   * replace the runtime too. Keeping the process here lets the next runtime adopt it; remounting instead would delete
   * and recreate the checkouts.
   */
  var piDeltaMounts: Map<string, Mount> | undefined;
}

const handoff = (globalThis.piDeltaMounts ??= new Map());

/** One activated session: its binding, recorder, watch, and the mount that keeps its files synced. */
type Active = {
  readonly binding: Binding;
  readonly recorder: Recorder;
  readonly watch: ThreadWatch;
  mount: Mount | undefined;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function gitToplevel(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function currentOrganization(cli: DeltaCli): Promise<{ id: string; name: string }> {
  const { organizations } = await cli.run(OrganizationList, ["org", "list"]);
  const current = organizations.find((org) => org.current);
  if (!current) throw new DeltaError("organization_required", "Select a Delta organization first: delta org select", false);

  return current;
}

/** Find this checkout's existing worktree, or create one. Reusing it keeps retries from creating duplicates. */
async function worktreeFor(cli: DeltaCli, checkout: string): Promise<string> {
  const { worktrees } = await cli.run(WorktreeList, ["worktree", "list"]);
  const existing = worktrees.find((worktree) => worktree.directories.some((dir) => dir.directory === checkout));
  if (existing) return existing.reference;

  return (await cli.run(WorktreeCreated, ["worktree", "create", checkout])).reference;
}

function mountArgs(binding: Binding): string[] {
  const membership = binding.membership;

  return membership.kind === "shared"
    ? ["worktree", "mount", membership.worktreeReference, membership.checkout, "--existing-checkout"]
    : ["thread", "mount", membership.locator, "--owner", membership.owner, "--join"];
}

/** Ask who should see the session. Returns the visibility to create the thread with, or `undefined` to cancel. */
async function askVisibility(ctx: ExtensionCommandContext, checkout: string, organization: string, emails: string[]) {
  const disclosure = `Delta will sync this conversation and a copy of ${checkout}, including uncommitted changes.`;

  if (emails.length) {
    const confirmed = await ctx.ui.confirm("Share with Delta?", `${disclosure} Invite: ${emails.join(", ")}`);
    return confirmed ? "private" : undefined;
  }

  const shareWithOrg = `Share with ${organization}`;
  const choice = await ctx.ui.select(`Who should see this session? ${disclosure}`, [shareWithOrg, "Just me (sync privately)", "Cancel"]);

  if (choice === shareWithOrg) return "organization";
  return choice === "Just me (sync privately)" ? "private" : undefined;
}

export default function (pi: ExtensionAPI) {
  let active: Active | undefined;
  let context: ExtensionContext | undefined;
  let cli: DeltaCli | undefined;

  const resolveCli = async () => (cli ??= await DeltaCli.resolve());

  function notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    context?.ui.notify(message, type);
  }

  function setStatus(text: string | undefined): void {
    context?.ui.setStatus(STATUS_KEY, text && `Delta: ${text}`);
  }

  function addRemoteItems(binding: Binding, items: readonly RemoteItem[]): void {
    for (const item of items) {
      const message = { customType: REMOTE_MESSAGE_TYPE, content: item.text, display: true };

      // Without `triggerTurn`, Pi appends the message while idle and holds it until the current turn ends otherwise.
      if (item.text) pi.sendMessage(message, { triggerTurn: false });
      binding.injected[item.id] = item.fingerprint;
    }

    saveBinding(binding);
  }

  /** Start a mount for `binding` and wait until its files are ready. */
  async function startMount(delta: DeltaCli, binding: Binding): Promise<Mount> {
    const mount = delta.spawn(MountReady, mountArgs(binding), {
      onExit: () => {
        if (active?.mount === mount) notify("Delta stopped syncing this session's files. Run /delta status for details.", "warning");
      },
    });

    await mount.ready;
    return mount;
  }

  /** Replace a joined thread's mount after its worktrees change: start the new one, then stop the old one. */
  async function remount(session: Active, delta: DeltaCli): Promise<void> {
    const previous = session.mount;
    session.mount = await startMount(delta, session.binding);
    previous?.stop();

    const note = "[Delta] This thread's worktrees changed; the mounted files were updated.";
    addRemoteItems(session.binding, [{ id: `worktrees-${Date.now()}`, fingerprint: "", text: note }]);
  }

  /**
   * Start recording, watching, and syncing files for `binding`.
   *
   * Reuses a mount handed over by a previous runtime when there is one. Pending records from an earlier run are sent
   * once the recorder starts. Throws when the CLI can't be found or the files can't be mounted.
   */
  async function activate(binding: Binding): Promise<Active> {
    const delta = await resolveCli();

    const recorder = new Recorder(delta, binding, {
      onTurnLost: () => {
        notify("Someone else took over this thread's turn; stopped Pi. Tool effects that already ran are not undone.", "warning");
        context?.abort();
      },
      onPaused: (error) => notify(`Delta recording paused: ${error.message}. Run /delta retry after fixing it.`, "error"),
    });

    const onWorktreesChanged = () => {
      if (active?.binding.membership.kind !== "joined") return;

      remount(active, delta).catch((error: unknown) => notify(`Delta remount failed: ${describe(error)}`, "error"));
    };

    const watch = new ThreadWatch(delta, binding.thread, binding.sessionId, binding.injected, {
      onItems: (items) => addRemoteItems(binding, items),
      onSuperseded: (sequence) => recorder.loseTurn(sequence),
      onWorktreesChanged,
      onStatus: (text) => setStatus(text),
      onFailed: (error) => notify(`Delta watch stopped: ${error.message}`, "error"),
    });

    const session: Active = { binding, recorder, watch, mount: handoff.get(binding.sessionId) };
    handoff.delete(binding.sessionId);
    active = session;

    session.mount ??= await startMount(delta, binding);
    watch.start();
    void recorder.drain();
    setStatus("connected");

    return session;
  }

  /** Stop recording and watching. The mount is kept for the next runtime only when `keepMount` is set. */
  async function deactivate(keepMount: boolean): Promise<void> {
    const session = active;
    if (!session) return;

    active = undefined;
    session.recorder.endTurn("cancelled");

    // Give Delta a moment to take the last records; anything left is sent on the next activation.
    await Promise.race([session.recorder.drain(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    session.recorder.stop();
    session.watch.stop();

    if (keepMount && session.mount) handoff.set(session.binding.sessionId, session.mount);
    else session.mount?.stop();

    setStatus(undefined);
  }

  async function share(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (active) return notify(`This session is already in Delta: ${active.binding.url ?? active.binding.thread}`);
    if (!ctx.isIdle()) return notify("Wait for the current turn to finish before sharing.", "warning");

    const checkout = await gitToplevel(ctx.cwd);
    if (!checkout) return notify("Delta shares a git checkout. Start Pi inside a git repository to share it.", "error");

    const delta = await resolveCli();
    const organization = await currentOrganization(delta);
    const emails = args.split(/[\s,]+/).filter(Boolean);
    const visibility = await askVisibility(ctx, checkout, organization.name, emails);
    if (!visibility) return;

    const sessionId = ctx.sessionManager.getSessionId();
    const producer = ["--source", "pi", "--external-id", sessionId];
    const createArgs = ["thread", "create", ...producer, "--organization", organization.id, "--visibility", visibility];

    // The worktree comes first so a checkout Delta can't use fails before any thread exists. `thread create` returns
    // the same thread for the same producer IDs, so a retried share is safe.
    const worktreeReference = await worktreeFor(delta, checkout);
    const { thread_id: thread } = await delta.run(ThreadCreated, createArgs);

    await delta.run(AnyObject, ["worktree", "attach", worktreeReference, "--thread", thread]);
    if (emails.length) await delta.run(AnyObject, ["thread", "invite", thread, "--", ...emails]);

    const binding: Binding = {
      sessionId,
      thread,
      membership: { kind: "shared", worktreeReference, checkout },
      next: 1,
      pending: [],
      injected: {},
    };

    const title = pi.getSessionName();
    const history = ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    const updates = history.map(asRecordedMessage).flatMap((message) => (message ? translateMessage(message) : []));

    saveBinding(binding);

    const session = await activate(binding);
    session.recorder.recordHistory(title ? [{ sessionUpdate: "session_info_update", title }, ...updates] : updates);
    await session.recorder.drain();

    const status = await delta.run(ThreadStatus, ["thread", "status", thread, ...producer]);
    binding.url = status.url ?? undefined;
    saveBinding(binding);

    notify(`Shared this session in Delta${binding.url ? `: ${binding.url}` : ""}`);
  }

  /**
   * Join someone else's thread: mount its files, then switch Pi to a new session inside the mounted directory.
   *
   * Pi only writes a session file once it holds conversation content, so this writes the header and a join notice
   * itself. The new session's runtime adopts the mount and starts recording when it starts.
   */
  async function join(locator: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!locator) return notify("Usage: /delta join <share link or thread ID>", "warning");
    if (active) return notify("This session is already in Delta. Start a new session with /new to join another thread.", "warning");

    // The session ID is chosen up front because `thread status` needs the producer's ID before anything is mounted.
    const sessionId = randomUUID();
    const delta = await resolveCli();
    const status = await delta.run(ThreadStatus, ["thread", "status", locator, "--source", "pi", "--external-id", sessionId]);
    if (status.access.state !== "granted") return notify("You don't have access to that thread. Ask its owner to share it with you.", "error");

    const membership = { kind: "joined", locator, owner: sessionId, directory: "" } as const;
    const url = status.url ?? undefined;

    notify("Mounting the thread's files...");

    const thread = status.thread_id;
    const mount = await startMount(delta, { sessionId, thread, membership, next: 1, pending: [], injected: {} });
    const { directory } = await mount.ready;

    const session = SessionManager.create(directory, undefined, { id: sessionId });
    session.appendCustomMessageEntry("delta-joined", `[Delta] Joined thread ${url ?? thread}. Files are in ${directory}.`, true);

    const file = session.getSessionFile();
    if (!file) throw new Error("Pi did not assign a session file");

    writeFileSync(file, [session.getHeader(), ...session.getEntries()].map((entry) => `${JSON.stringify(entry)}\n`).join(""));

    const joined = { ...membership, directory };
    saveBinding({ sessionId, thread, membership: joined, url, next: 1, pending: [], injected: {} });
    handoff.set(sessionId, mount);

    const result = await ctx.switchSession(file);
    if (!result.cancelled) return;

    handoff.delete(sessionId);
    mount.stop();
    deleteBinding(sessionId);
  }

  async function leave(ctx: ExtensionCommandContext): Promise<void> {
    if (!active) return notify("This session isn't in Delta.");

    const sessionId = active.binding.sessionId;
    const message = "Pi stops recording this session and releases its synced files. The thread stays in Delta.";
    if (!(await ctx.ui.confirm("Leave Delta thread?", message))) return;

    await deactivate(false);
    deleteBinding(sessionId);
    notify("Left the Delta thread.");
  }

  function showStatus(): void {
    if (!active) return notify("This session isn't in Delta. Use /delta share or /delta join <link>.");

    const { binding, recorder, mount } = active;

    const lines = [
      `Thread: ${binding.url ?? binding.thread}`,
      `Mode: ${binding.membership.kind}`,
      `Files syncing: ${mount?.child.exitCode === null ? "yes" : "no"}`,
      `Records waiting to send: ${binding.pending.length}`,
    ];

    if (recorder.pausedError) lines.push(`Paused: ${recorder.pausedError.message}`);
    notify(lines.join("\n"));
  }

  pi.registerCommand("delta", {
    description: "Multiplayer Delta threads: share [emails], join <link>, status, retry, leave",
    handler: async (args, ctx) => {
      context = ctx;

      const [subcommand = "status", ...rest] = args.trim().split(/\s+/);
      const argument = rest.join(" ");

      try {
        switch (subcommand) {
          case "share":
            return await share(argument, ctx);
          case "join":
            return await join(argument, ctx);
          case "leave":
            return await leave(ctx);
          case "retry":
            active?.recorder.resume();
            return showStatus();
          case "":
          case "status":
            return showStatus();
          default:
            return notify(`Unknown /delta command "${subcommand}". Try share, join, status, retry, or leave.`, "warning");
        }
      } catch (error) {
        notify(`Delta: ${describe(error)}`, "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;

    const binding = loadBinding(ctx.sessionManager.getSessionId());
    if (!binding) return;

    // Activation waits for the files to mount, which can take a while; don't hold up Pi's startup for it.
    activate(binding).catch((error: unknown) => notify(`Delta couldn't reconnect this session: ${describe(error)}`, "error"));
  });

  pi.on("session_shutdown", async (event) => {
    await deactivate(event.reason === "reload");
  });

  pi.on("agent_start", () => {
    active?.recorder.ensureTurn();
  });

  pi.on("message_end", (event) => {
    const message = asRecordedMessage(event.message);
    if (!active || !message) return;

    if (message.role === "user") active.recorder.ensureTurn();
    active.recorder.recordContent(translateMessage(message));
  });

  pi.on("agent_settled", (event) => {
    active?.recorder.endTurn(event.aborted ? "cancelled" : "end_turn");
  });

  pi.on("session_info_changed", (event) => {
    if (active?.binding.membership.kind !== "shared" || !event.name) return;

    active.recorder.recordContent([{ sessionUpdate: "session_info_update", title: event.name.slice(0, 200) }]);
  });
}
