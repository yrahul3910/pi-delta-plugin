import { Type, type TSchema } from "typebox";

/**
 * Schemas for the Delta CLI's `--json` output under recording contract 8.
 *
 * Each schema lists only the fields this extension reads. TypeBox objects accept extra properties, so new fields the
 * CLI adds later don't break parsing.
 */

const Optional = Type.Optional;
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const ErrorEnvelope = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    reason: Optional(Type.String()),
    retryable: Optional(Type.Boolean()),
    retry_after_ms: Optional(Type.Number()),
  }),
});

export const Contract = Type.Object({ operation: Type.Literal("contract"), min: Type.Number(), max: Type.Number() });

export const ReceiptLine = Type.Object({
  operation: Type.Literal("appended"),
  sequence: Type.Number(),
  disposition: Type.Union([Type.Literal("recorded"), Type.Literal("duplicate"), Type.Literal("fenced")]),
  turn_sequence: Nullable(Type.Number()),
});

export const ThreadCreated = Type.Object({ thread_id: Type.String() });

export const WorktreeCreated = Type.Object({ reference: Type.String() });

export const WorktreeList = Type.Object({
  worktrees: Type.Array(
    Type.Object({ reference: Type.String(), directories: Type.Array(Type.Object({ directory: Type.String() })) }),
  ),
});

export const OrganizationList = Type.Object({
  organizations: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), current: Type.Boolean() })),
});

export const ThreadStatus = Type.Object({
  thread_id: Type.String(),
  url: Optional(Nullable(Type.String())),
  access: Type.Object({ state: Type.String() }),
});

/** Any JSON object, for commands whose output this extension doesn't read, such as `worktree attach`. */
export const AnyObject = Type.Object({});

export const MountReady = Type.Object({ operation: Type.Literal("mounted"), directory: Type.String() });

const ProducerTurn = Type.Object({ sequence: Type.Number(), status: Type.String() });

const Person = Nullable(Type.Object({ name: Optional(Type.String()) }));

/** The fields of an item's `content` that `renderItem` shows. */
export const ItemContent = Type.Object({
  text: Optional(Type.String()),
  title: Optional(Type.String()),
  status: Optional(Type.String()),
  raw_output: Optional(Type.Unknown()),
});

export const Item = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  open: Optional(Type.Boolean()),
  author: Optional(Person),
  content: Optional(Type.Unknown()),
});

/** The `thread watch` events this extension handles. Other event types are skipped. */
export const WatchEvent = Type.Union([
  Type.Object({ type: Type.Literal("ready"), producer: Optional(Nullable(Type.Object({ turn: Optional(Nullable(ProducerTurn)) }))) }),
  Type.Object({ type: Type.Literal("item"), item: Item }),
  Type.Object({ type: Type.Literal("item.append"), id: Type.String(), text: Type.String() }),
  Type.Object({ type: Type.Literal("remove"), id: Type.String() }),
  Type.Object({ type: Type.Literal("live") }),
  Type.Object({ type: Type.Literal("producer.turn"), sequence: Type.Number(), status: Type.String() }),
  Type.Object({ type: Type.Literal("turn"), state: Type.String(), user: Optional(Person) }),
  Type.Object({ type: Type.Literal("presence"), users: Type.Array(Type.Unknown()) }),
  Type.Object({ type: Type.Literal("worktrees") }),
]);
