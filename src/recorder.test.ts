import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeltaError, type AppendResult, type Receipt } from "./cli.ts";
import { Recorder } from "./recorder.ts";
import type { Binding } from "./state.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-delta-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

type Record = { sequence: number; turnSequence?: number; update: { sessionUpdate: string; state?: string } };

function newBinding(): Binding {
  return {
    sessionId: "session-1",
    thread: "thread-1",
    membership: { kind: "shared", worktreeReference: "wt", checkout: "/repo" },
    next: 1,
    pending: [],
    injected: {},
  };
}

/** A fake `thread append` that answers each call with `respond` and remembers what it was sent. */
function fakeCli(respond: (records: Record[]) => AppendResult) {
  const calls: Record[][] = [];

  const append = async (_thread: string, _producer: readonly string[], lines: string) => {
    const records: Record[] = lines.trim().split("\n").map((line) => JSON.parse(line));
    calls.push(records);

    return respond(records);
  };

  return { calls, cli: { append } };
}

function receipt(record: Record, disposition: Receipt["disposition"] = "recorded"): Receipt {
  return { sequence: record.sequence, disposition, turnSequence: record.turnSequence ?? null };
}

describe("Recorder", () => {
  it("numbers a turn's records and removes them once Delta acknowledges them", async () => {
    const { calls, cli } = fakeCli((records) => ({ receipts: records.map((record) => receipt(record)) }));
    const binding = newBinding();
    const recorder = new Recorder(cli, binding, { onTurnLost: () => {}, onPaused: () => {} });

    recorder.ensureTurn();
    recorder.recordContent([{ sessionUpdate: "agent_message", messageId: "m", content: [] }]);
    recorder.endTurn("end_turn");
    await recorder.drain();
    recorder.stop();

    expect(calls.flat().map((record) => [record.sequence, record.turnSequence, record.update.sessionUpdate])).toEqual([
      [1, 1, "state_update"],
      [2, 1, "agent_message"],
      [3, 1, "state_update"],
    ]);
    expect(binding.pending).toEqual([]);
    expect(binding.next).toBe(4);
  });

  it("keeps unacknowledged records after a partial batch and resends them unchanged", async () => {
    let failOnce = true;

    const { calls, cli } = fakeCli((records) => {
      if (!failOnce) return { receipts: records.map((record) => receipt(record)) };

      failOnce = false;
      return { receipts: [receipt(records[0] ?? { sequence: 0, update: { sessionUpdate: "" } })], error: new DeltaError("offline", "offline", false) };
    });

    const binding = newBinding();
    const paused: string[] = [];
    const recorder = new Recorder(cli, binding, { onTurnLost: () => {}, onPaused: (error) => paused.push(error.code) });

    recorder.recordHistory([
      { sessionUpdate: "user_message", messageId: "a", content: [] },
      { sessionUpdate: "user_message", messageId: "b", content: [] },
    ]);
    await recorder.drain();

    expect(paused).toEqual(["offline"]);
    expect(binding.pending.map((record) => record.sequence)).toEqual([2]);

    recorder.resume();
    await recorder.drain();
    recorder.stop();

    expect(calls[1]?.map((record) => record.sequence)).toEqual([2]);
    expect(binding.pending).toEqual([]);
  });

  it("stops the local turn when its records come back fenced", async () => {
    const { calls, cli } = fakeCli((records) => ({ receipts: records.map((record) => receipt(record, "fenced")) }));
    const binding = newBinding();
    let lost = 0;
    const recorder = new Recorder(cli, binding, { onTurnLost: () => (lost += 1), onPaused: () => {} });

    recorder.ensureTurn();
    await recorder.drain();
    recorder.stop();

    expect(lost).toBe(1);
    expect(binding.turn).toEqual({ sequence: 1, lost: true });
    expect(calls.flat().map((record) => record.update.state)).toEqual(["running", "idle"]);
  });
});
