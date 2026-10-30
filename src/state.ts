import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** A record saved before sending, kept until Delta acknowledges it. `line` is the exact JSON Lines text to resend. */
export type PendingRecord = { readonly sequence: number; readonly turnSequence: number | null; readonly line: string };

/** How this computer takes part in the thread. */
export type Membership =
  | {
      /** This Pi session created the thread and shares its own git checkout. */
      readonly kind: "shared";
      readonly worktreeReference: string;
      readonly checkout: string;
    }
  | {
      /** This Pi session joined someone else's thread and works in mounted copies of its worktrees. */
      readonly kind: "joined";
      readonly locator: string;
      readonly owner: string;
      readonly directory: string;
    };

/**
 * Everything the extension must remember about one Pi session's Delta thread.
 *
 * Losing `next` or `pending` makes it impossible to keep recording the session (Delta never accepts a sequence number
 * twice for different content), so the file is written atomically after every change.
 */
export type Binding = {
  readonly sessionId: string;
  readonly thread: string;
  readonly membership: Membership;
  url?: string;
  /** The next sequence number to assign. Sequences start at 1 and never repeat. */
  next: number;
  pending: PendingRecord[];
  /** The Delta turn this session is running. `lost` turns were taken over by someone else. */
  turn?: { readonly sequence: number; lost: boolean };
  /** Fingerprints of remote items already added to Pi's context, so reconnects don't repeat them. */
  injected: Record<string, string>;
};

function bindingsDir(): string {
  return join(getAgentDir(), "delta", "sessions");
}

function bindingPath(sessionId: string): string {
  return join(bindingsDir(), `${sessionId}.json`);
}

/**
 * Load the saved binding for `sessionId`.
 *
 * Returns `undefined` when the session was never shared or joined. Throws when the file can't be read for any other
 * reason or holds another session's state, since recording on top of corrupt state could reuse sequence numbers.
 */
export function loadBinding(sessionId: string): Binding | undefined {
  let text: string;

  try {
    text = readFileSync(bindingPath(sessionId), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }

  const binding: Binding = JSON.parse(text);
  if (binding.sessionId !== sessionId) throw new Error(`Delta state for session ${sessionId} is corrupt`);

  return binding;
}

/**
 * Atomically replace the saved binding.
 *
 * A temporary file in the same directory keeps the previous state intact if writing fails, so readers see either the
 * old binding or the complete new one.
 */
export function saveBinding(binding: Binding): void {
  mkdirSync(bindingsDir(), { recursive: true });

  const path = bindingPath(binding.sessionId);
  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, JSON.stringify(binding));
  renameSync(temporary, path);
}

export function deleteBinding(sessionId: string): void {
  rmSync(bindingPath(sessionId), { force: true });
}
