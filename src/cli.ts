import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { Contract, ErrorEnvelope, ReceiptLine } from "./schemas.ts";

/** The recording contract version this plugin speaks. See `delta --json thread contract`. */
export const CONTRACT_VERSION = 8;

const DEFAULT_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 600_000;

/**
 * A failed Delta CLI command.
 *
 * `code` comes from the CLI's JSON error envelope, or is `process_failed`, `timeout`, or `invalid_output` when the
 * process itself misbehaved. Only `retryable` should drive retry decisions; `reason` is diagnostic text whose values
 * the CLI may change.
 */
export class DeltaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** Build a `DeltaError` from a CLI error envelope, or return `undefined` when `value` isn't one. */
export function errorFromEnvelope(value: unknown): DeltaError | undefined {
  if (!Value.Check(ErrorEnvelope, value)) return undefined;

  const { code, message, retryable, retry_after_ms: retryAfterMs, reason } = value.error;
  return new DeltaError(code, message, retryable === true, retryAfterMs, reason);
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function parseOutput<T extends TSchema>(schema: T, value: unknown, command: readonly string[]): Static<T> {
  if (Value.Check(schema, value)) return value;

  throw new DeltaError("invalid_output", `Unexpected output from delta ${command.slice(0, 2).join(" ")}`, false);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * List executables that might be the Delta CLI, most specific first.
 *
 * `PI_DELTA_CLI` wins when set. The app bundle paths come before `PATH` because the `git-delta` diff pager is also
 * installed as `delta` and often shadows the Delta CLI on `PATH`.
 */
function candidatePaths(): string[] {
  const explicit = process.env.PI_DELTA_CLI;
  if (explicit) return [explicit];

  const bundles = [
    "/Applications/Delta.app/Contents/MacOS/delta",
    join(homedir(), "Applications/Delta.app/Contents/MacOS/delta"),
    join(homedir(), ".local/delta.app/bin/delta"),
  ];
  const onPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "delta"));

  return [...new Set([...bundles, ...onPath])].filter(isExecutable);
}

type Captured = { readonly stdout: string; readonly stderr: string; readonly exitCode: number | null };

function capture(executable: string, args: readonly string[], stdin: string, timeoutMs: number): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env, DELTA_CLI_INTEGRATION: "pi" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new DeltaError("timeout", `delta ${args.slice(1, 3).join(" ")} timed out`, true));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new DeltaError("process_failed", error.message, true));
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode });
    });

    child.stdin.end(stdin);
  });
}

/** A record receipt from `thread append`. */
export type Receipt = {
  readonly sequence: number;
  readonly disposition: "recorded" | "duplicate" | "fenced";
  readonly turnSequence: number | null;
};

/** The result of one `thread append` call: receipts for the prefix Delta acknowledged, then the error, if any. */
export type AppendResult = { readonly receipts: readonly Receipt[]; readonly error?: DeltaError };

/** A long-running Delta command, such as a mount or a watch, that keeps working while its process runs. */
export type LongRunning<T> = {
  readonly child: ChildProcess;
  /** Resolves with the first stdout line parsed as `T`, or rejects if the process fails or exits first. */
  readonly ready: Promise<T>;
  /** Stop the process with SIGTERM so Delta can finish uploading. Safe to call more than once. */
  stop(): void;
};

/**
 * A resolved Delta CLI executable.
 *
 * Every command runs with `--json` and fails with a `DeltaError` built from the CLI's error envelope.
 */
export class DeltaCli {
  private constructor(readonly executable: string) {}

  /**
   * Find a Delta CLI whose contract range includes `CONTRACT_VERSION`.
   *
   * Each candidate is asked for `thread contract`, which also rules out unrelated `delta` binaries. Throws a
   * `DeltaError` with code `cli_missing` or `incompatible_cli` that explains what the user should install or update.
   */
  static async resolve(): Promise<DeltaCli> {
    let incompatible: string | undefined;

    for (const path of candidatePaths()) {
      const result = await capture(path, ["--json", "thread", "contract"], "", 30_000).catch(() => undefined);
      const contract = result ? parseLine(result.stdout) : undefined;
      if (!Value.Check(Contract, contract)) continue;
      if (contract.min <= CONTRACT_VERSION && CONTRACT_VERSION <= contract.max) return new DeltaCli(path);

      incompatible = contract.max < CONTRACT_VERSION ? "Update Delta to 0.22.0 or later." : "Update the pi-delta extension.";
    }

    if (incompatible) throw new DeltaError("incompatible_cli", incompatible, false);

    throw new DeltaError(
      "cli_missing",
      "Delta CLI not found. Install Delta from https://delta.dev, or set PI_DELTA_CLI to the delta executable.",
      false,
    );
  }

  /**
   * Run a one-shot command and parse its single JSON object with `schema`.
   *
   * Throws the CLI's own `DeltaError` when it reports one, `command_failed` when it exits non-zero without one, and
   * `invalid_output` when the output doesn't match `schema`.
   */
  async run<T extends TSchema>(schema: T, args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Static<T>> {
    const result = await capture(this.executable, ["--json", ...args], "", timeoutMs);
    const output = parseLine(result.stdout.trim());

    const error = errorFromEnvelope(output);
    if (error) throw error;

    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new DeltaError("command_failed", `delta ${args.slice(0, 2).join(" ")}: ${detail}`, false);
    }

    return parseOutput(schema, output, args);
  }

  /**
   * Send JSON Lines `records` to `thread append` and collect one receipt per acknowledged record.
   *
   * Delta can record a prefix of the batch and then fail, so the result carries both the receipts and the error.
   */
  async append(thread: string, producer: readonly string[], records: string): Promise<AppendResult> {
    const args = ["--json", "thread", "append", thread, ...producer, "--producer-name", "Pi"];
    const result = await capture(this.executable, args, records, DEFAULT_TIMEOUT_MS);
    const receipts: Receipt[] = [];
    let error: DeltaError | undefined;

    for (const line of result.stdout.split("\n")) {
      const value = parseLine(line);

      if (Value.Check(ReceiptLine, value)) {
        receipts.push({ sequence: value.sequence, disposition: value.disposition, turnSequence: value.turn_sequence });
      }

      error = errorFromEnvelope(value) ?? error;
    }

    if (!error && result.exitCode !== 0) {
      error = new DeltaError("command_failed", result.stderr.trim() || `exit code ${result.exitCode}`, false);
    }

    return { receipts, error };
  }

  /**
   * Start a command that keeps running, such as `thread mount` or `thread watch`.
   *
   * The first stdout line is parsed with `schema` to resolve `ready`. `onLine` receives every later line, including
   * error envelopes, as unparsed JSON. `onExit` runs once when the process ends for any reason, including `stop()`.
   */
  spawn<T extends TSchema>(
    schema: T,
    args: readonly string[],
    handlers: { onLine?: (value: unknown) => void; onExit?: () => void } = {},
  ): LongRunning<Static<T>> {
    const child = spawn(this.executable, ["--json", ...args], {
      env: { ...process.env, DELTA_CLI_INTEGRATION: "pi" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    let isReady = false;

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

    const ready = new Promise<Static<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DeltaError("timeout", `delta ${args.slice(0, 2).join(" ")} did not become ready`, true));
      }, READY_TIMEOUT_MS);

      createInterface({ input: child.stdout }).on("line", (line) => {
        const value = parseLine(line);

        if (isReady) {
          handlers.onLine?.(value);
          return;
        }

        clearTimeout(timer);
        isReady = true;

        try {
          const error = errorFromEnvelope(value);
          if (error) throw error;

          resolve(parseOutput(schema, value, args));
        } catch (error) {
          reject(error);
        }
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new DeltaError("process_failed", error.message, true));
      });

      child.on("exit", (code) => {
        clearTimeout(timer);

        const detail = stderr.join("").trim() || `exit code ${code}`;
        reject(new DeltaError("process_failed", `delta ${args.slice(0, 2).join(" ")} exited: ${detail}`, true));
        handlers.onExit?.();
      });
    });

    // The caller may never await `ready` (for example after stopping early); keep that from crashing Pi.
    ready.catch(() => undefined);

    return {
      child,
      ready,
      stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      },
    };
  }
}
