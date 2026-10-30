import { createHash } from "node:crypto";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { DeltaError, errorFromEnvelope, type DeltaCli, type LongRunning } from "./cli.ts";
import { Item, ItemContent, WatchEvent } from "./schemas.ts";

type ThreadItem = Static<typeof Item>;
type Event = Static<typeof WatchEvent>;

/** Item kinds that never go into the agent's context. */
const HIDDEN_KINDS = new Set(["agent_thought", "unknown"]);
const MAX_ITEM_CHARS = 8_000;
/** When joining a long thread, only the newest items of the initial snapshot go into context. */
const MAX_SNAPSHOT_ITEMS = 40;

export type RemoteItem = { readonly id: string; readonly fingerprint: string; readonly text: string };

export type WatchEvents = {
  /** Completed teammate activity, in thread order, that this session hasn't seen yet. */
  onItems(items: readonly RemoteItem[]): void;
  /** Delta reports that someone else took over this session's turn `sequence`. */
  onSuperseded(sequence: number): void;
  /** The set of worktrees attached to the thread changed. */
  onWorktreesChanged(): void;
  /** A short status line: who else is here and whether someone else's turn is running. */
  onStatus(text: string): void;
  /** The watch stopped on an error that reconnecting won't fix. */
  onFailed(error: DeltaError): void;
};

function fingerprint(item: ThreadItem): string {
  return createHash("sha256").update(JSON.stringify([item.kind, item.content])).digest("hex").slice(0, 16);
}

function clip(text: string): string {
  if (text.length <= MAX_ITEM_CHARS) return text;

  return `${text.slice(0, MAX_ITEM_CHARS)}\n[truncated; run \`delta thread show\` for the rest]`;
}

/**
 * Render a thread item as context for the agent.
 *
 * Text content is shown as is; tool calls show their title, status, and output; anything else falls back to JSON so
 * no information is silently dropped.
 */
export function renderItem(item: ThreadItem): string {
  const author = item.author === null ? "Delta agent" : (item.author?.name ?? "Someone in Delta");
  const header = `[Delta] ${author}, ${item.kind.replaceAll("_", " ")}:`;
  const content = Value.Check(ItemContent, item.content) ? item.content : {};

  if (content.text !== undefined) return `${header}\n${clip(content.text)}`;
  if (content.title === undefined) return `${header}\n${clip(JSON.stringify(item.content))}`;

  const output = content.raw_output === undefined ? "" : `\n${JSON.stringify(content.raw_output)}`;
  return clip(`${header} ${content.title} (${content.status ?? "unknown"})${output}`);
}

/**
 * Follow a Delta thread with `thread watch` for as long as the session is bound to it.
 *
 * Items recorded by this session are hidden by passing its producer IDs. The watch reconnects with backoff when its
 * process exits; each connection starts from a fresh snapshot, and `injected` (shared with the binding) keeps already
 * delivered items from reaching the agent twice.
 */
export class ThreadWatch {
  private process: LongRunning<Event> | undefined;
  private items = new Map<string, ThreadItem>();
  private isLive = false;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private presence = 0;
  private remoteTurn: string | undefined;

  constructor(
    private readonly cli: DeltaCli,
    private readonly thread: string,
    private readonly sessionId: string,
    private readonly injected: Readonly<Record<string, string>>,
    private readonly events: WatchEvents,
  ) {}

  start(): void {
    if (this.stopped) return;

    this.items.clear();
    this.isLive = false;

    const args = ["thread", "watch", this.thread, "--source", "pi", "--external-id", this.sessionId, "--participate", "Pi"];

    this.process = this.cli.spawn(WatchEvent, args, {
      onLine: (value) => this.handleLine(value),
      onExit: () => this.reconnect(),
    });

    this.process.ready.then(
      (ready) => this.handle(ready),
      (error: unknown) => {
        if (error instanceof DeltaError) this.fail(error);
      },
    );
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.process?.stop();
  }

  private reconnect(): void {
    if (this.stopped) return;

    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt, 5));
    this.attempt += 1;
    this.timer = setTimeout(() => this.start(), delay);
  }

  /** Stop for good on an error that reconnecting won't fix; retryable errors are left to the reconnect timer. */
  private fail(error: DeltaError): void {
    if (error.retryable) return;

    this.stop();
    this.events.onFailed(error);
  }

  /** Handle one raw line: a known event, an error envelope, or an event type to skip. */
  private handleLine(value: unknown): void {
    const error = errorFromEnvelope(value);
    if (error) return this.fail(error);

    if (Value.Check(WatchEvent, value)) this.handle(value);
  }

  private handle(event: Event): void {
    switch (event.type) {
      case "ready":
        this.handleProducerTurn(event.producer?.turn);
        break;
      case "item":
        this.upsert(event.item);
        break;
      case "item.append":
        this.append(event.id, event.text);
        break;
      case "remove":
        this.items.delete(event.id);
        break;
      case "live":
        this.isLive = true;
        this.attempt = 0;
        this.deliverSnapshot();
        break;
      case "producer.turn":
        this.handleProducerTurn(event);
        break;
      case "turn":
        this.remoteTurn = event.state === "running" ? (event.user?.name ?? "Someone") : undefined;
        this.reportStatus();
        break;
      case "presence":
        this.presence = event.users.length;
        this.reportStatus();
        break;
      case "worktrees":
        if (this.isLive) this.events.onWorktreesChanged();
        break;
    }
  }

  private handleProducerTurn(turn: { sequence: number; status: string } | null | undefined): void {
    if (turn?.status === "superseded") this.events.onSuperseded(turn.sequence);
  }

  private reportStatus(): void {
    const others = Math.max(0, this.presence - 1);
    const people = others ? `${others} other${others === 1 ? "" : "s"} here` : "no one else here";
    this.events.onStatus(this.remoteTurn ? `${people}, ${this.remoteTurn} is running a turn` : people);
  }

  private upsert(item: ThreadItem): void {
    this.items.set(item.id, item);
    if (this.isLive) this.deliver([item]);
  }

  private append(id: string, text: string): void {
    const item = this.items.get(id);
    if (!item || !Value.Check(ItemContent, item.content)) return;

    this.items.set(id, { ...item, content: { ...item.content, text: `${item.content.text ?? ""}${text}` } });
  }

  private isDeliverable(item: ThreadItem): boolean {
    if (item.open === true || HIDDEN_KINDS.has(item.kind)) return false;

    return this.injected[item.id] !== fingerprint(item);
  }

  private deliverSnapshot(): void {
    const fresh = [...this.items.values()].filter((item) => this.isDeliverable(item));
    const skipped = fresh.slice(0, Math.max(0, fresh.length - MAX_SNAPSHOT_ITEMS));
    const kept = fresh.slice(skipped.length).map((item) => this.toRemote(item));

    // Skipped items are reported as already delivered, so later reconnects don't bring them back either.
    const omitted = skipped.map((item) => ({ ...this.toRemote(item), text: "" }));

    if (skipped.length) {
      const note = `[Delta] ${skipped.length} earlier thread items were left out of your context. Run \`delta thread show ${this.thread}\` to read them.`;
      this.events.onItems([...omitted, { id: "omitted", fingerprint: "", text: note }]);
    }

    if (kept.length) this.events.onItems(kept);
  }

  private deliver(items: readonly ThreadItem[]): void {
    const remote = items.filter((item) => this.isDeliverable(item)).map((item) => this.toRemote(item));
    if (remote.length) this.events.onItems(remote);
  }

  private toRemote(item: ThreadItem): RemoteItem {
    return { id: item.id, fingerprint: fingerprint(item), text: renderItem(item) };
  }
}
