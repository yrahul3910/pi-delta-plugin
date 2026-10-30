import { DeltaError, type DeltaCli, type Receipt } from "./cli.ts";
import { saveBinding, type Binding, type PendingRecord } from "./state.ts";
import type { Update } from "./translate.ts";

/** Stop adding records to a batch past this many bytes; a single larger record is still sent alone. */
const MAX_BATCH_BYTES = 2_000_000;
const DRAIN_DEBOUNCE_MS = 250;

export type RecorderEvents = {
  /** Someone else took over the turn this session was running. The host should stop its local turn. */
  onTurnLost(): void;
  /** Delivery stopped on an error that retrying won't fix. Records stay queued until `resume()`. */
  onPaused(error: DeltaError): void;
};

/**
 * Count how many leading `records` the `receipts` acknowledge.
 *
 * A receipt only counts when it matches the record's sequence and turn exactly; the first mismatch ends the
 * acknowledged prefix, because Delta stops at the first record it can't accept.
 */
export function acknowledgedPrefix(records: readonly PendingRecord[], receipts: readonly Receipt[]): number {
  let count = 0;

  for (const [index, record] of records.entries()) {
    const receipt = receipts[index];
    if (receipt?.sequence !== record.sequence || receipt.turnSequence !== record.turnSequence) break;

    count += 1;
  }

  return count;
}

/** Wait before retry number `attempt` (0-based), honoring a longer `retry_after_ms` from Delta. */
export function retryDelay(attempt: number, retryAfterMs = 0): number {
  const backoff = Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4));
  return Math.min(Math.max(retryAfterMs, backoff), 300_000);
}

/**
 * Records one Pi session into its Delta thread.
 *
 * Every update is saved to the binding before it is sent, numbered consecutively from the binding's `next` sequence,
 * and removed only after Delta acknowledges it. Delivery runs one `thread append` at a time; transient failures retry
 * with backoff and resend the same records unchanged, which Delta reports as duplicates.
 */
export class Recorder {
  private draining: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private paused: DeltaError | undefined;
  private stopped = false;

  constructor(
    private readonly cli: Pick<DeltaCli, "append">,
    readonly binding: Binding,
    private readonly events: RecorderEvents,
  ) {}

  get pausedError(): DeltaError | undefined {
    return this.paused;
  }

  private producerArgs(): string[] {
    return ["--source", "pi", "--external-id", this.binding.sessionId];
  }

  private stage(update: Update, turnSequence: number | null): void {
    const sequence = this.binding.next;
    const base = { schemaVersion: 1, sequence };
    const record = turnSequence === null ? { ...base, update } : { ...base, turnSequence, update };

    this.binding.pending.push({ sequence, turnSequence, line: JSON.stringify(record) });
    this.binding.next = sequence + 1;
    saveBinding(this.binding);
    this.scheduleDrain();
  }

  /** Record history, such as an exported transcript, that belongs to no live turn. */
  recordHistory(updates: readonly Update[]): void {
    for (const update of updates) this.stage(update, null);
  }

  /** Record content produced during the current turn. Late output from a lost turn keeps that turn's sequence. */
  recordContent(updates: readonly Update[]): void {
    const turnSequence = this.binding.turn?.sequence ?? null;
    for (const update of updates) this.stage(update, turnSequence);
  }

  /** Start a Delta turn unless one is already open. A `running` record's turn sequence is its own sequence. */
  ensureTurn(): void {
    if (this.binding.turn && !this.binding.turn.lost) return;

    const sequence = this.binding.next;
    this.binding.turn = { sequence, lost: false };
    this.stage({ sessionUpdate: "state_update", state: "running" }, sequence);
  }

  /** Finish the open turn with an `idle` record. Lost turns were already closed when they were lost. */
  endTurn(stopReason: "end_turn" | "cancelled"): void {
    const turn = this.binding.turn;
    if (!turn) return;

    this.binding.turn = undefined;

    if (turn.lost) saveBinding(this.binding);
    else this.stage({ sessionUpdate: "state_update", state: "idle", stopReason }, turn.sequence);
  }

  /**
   * Mark the turn with `sequence` as taken over by someone else and tell the host to stop.
   *
   * Does nothing for any other turn, so a stale supersession notice can't stop a newer turn.
   */
  loseTurn(sequence: number): void {
    const turn = this.binding.turn;
    if (turn?.sequence !== sequence || turn.lost) return;

    turn.lost = true;
    this.stage({ sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" }, sequence);
    this.events.onTurnLost();
  }

  /** Clear a paused error and try delivering again. */
  resume(): void {
    this.paused = undefined;
    this.attempt = 0;
    this.scheduleDrain(0);
  }

  private scheduleDrain(delayMs = DRAIN_DEBOUNCE_MS): void {
    if (this.stopped || this.paused) return;

    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.drain(), delayMs);
  }

  /** Send every pending record, waiting for any delivery already in progress. Resolves even when delivery fails. */
  drain(): Promise<void> {
    clearTimeout(this.timer);
    this.draining = this.draining.then(() => this.deliverAll());

    return this.draining;
  }

  /** Stop scheduling deliveries. Pending records stay saved and are sent when the session is activated again. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private nextBatch(): PendingRecord[] {
    const batch: PendingRecord[] = [];
    let bytes = 0;

    for (const record of this.binding.pending) {
      const size = Buffer.byteLength(record.line) + 1;
      if (batch.length && bytes + size > MAX_BATCH_BYTES) break;

      batch.push(record);
      bytes += size;
    }

    return batch;
  }

  private async deliverAll(): Promise<void> {
    while (!this.paused && this.binding.pending.length) {
      const batch = this.nextBatch();
      const lines = batch.map((record) => `${record.line}\n`).join("");
      const result = await this.cli.append(this.binding.thread, this.producerArgs(), lines).catch((error: unknown) => ({
        receipts: [],
        error: error instanceof DeltaError ? error : new DeltaError("process_failed", String(error), true),
      }));
      const acknowledged = acknowledgedPrefix(batch, result.receipts);

      for (const receipt of result.receipts.slice(0, acknowledged)) {
        if (receipt.disposition === "fenced" && receipt.turnSequence !== null) this.loseTurn(receipt.turnSequence);
      }

      if (acknowledged) {
        this.binding.pending.splice(0, acknowledged);
        saveBinding(this.binding);
        this.attempt = 0;
      }

      if (acknowledged === batch.length) continue;

      this.fail(result.error ?? new DeltaError("invalid_acknowledgment", "Delta acknowledged fewer records than sent", false));
      return;
    }
  }

  private fail(error: DeltaError): void {
    if (!error.retryable) {
      this.paused = error;
      this.events.onPaused(error);

      return;
    }

    this.scheduleDrain(retryDelay(this.attempt, error.retryAfterMs));
    this.attempt += 1;
  }
}
