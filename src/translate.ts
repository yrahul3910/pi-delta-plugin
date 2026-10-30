import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const TextBlock = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const ImageBlock = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });
const ContentBlock = Type.Union([TextBlock, ImageBlock]);

type TextContent = Static<typeof TextBlock>;

/**
 * The ACP v2 session updates this extension records, as `thread append` expects them in each record's `update`.
 *
 * Delta also accepts streaming chunk updates elsewhere in ACP, but rejects them in recordings; a message is resent
 * with its full content under the same `messageId` instead.
 */
export type Update =
  | { readonly sessionUpdate: "user_message"; readonly messageId: string; readonly content: Static<typeof ContentBlock>[] }
  | { readonly sessionUpdate: "agent_message" | "agent_thought"; readonly messageId: string; readonly content: TextContent[] }
  | {
      readonly sessionUpdate: "tool_call_update";
      readonly toolCallId: string;
      readonly status: "in_progress" | "completed" | "failed";
      readonly title?: string;
      readonly kind?: string;
      readonly rawInput?: unknown;
      readonly rawOutput?: { readonly output: string };
      readonly content?: { readonly type: "content"; readonly content: TextContent }[];
    }
  | { readonly sessionUpdate: "state_update"; readonly state: "running" | "idle"; readonly stopReason?: "end_turn" | "cancelled" }
  | { readonly sessionUpdate: "session_info_update"; readonly title: string };

const ThinkingBlock = Type.Object({
  type: Type.Literal("thinking"),
  thinking: Type.String(),
  redacted: Type.Optional(Type.Boolean()),
});
const ToolCallBlock = Type.Object({ type: Type.Literal("toolCall"), id: Type.String(), name: Type.String(), arguments: Type.Unknown() });
const AssistantBlock = Type.Union([TextBlock, ThinkingBlock, ToolCallBlock]);

/** The arguments of Pi's built-in tools that their titles show. */
const ToolArguments = Type.Object({
  path: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  pattern: Type.Optional(Type.String()),
});

/** The Pi `AgentMessage` roles this module records. Unknown content blocks are skipped one by one. */
const RecordedMessageSchema = Type.Union([
  Type.Object({
    role: Type.Literal("user"),
    content: Type.Union([Type.String(), Type.Array(Type.Unknown())]),
    timestamp: Type.Number(),
  }),
  Type.Object({ role: Type.Literal("assistant"), content: Type.Array(Type.Unknown()), timestamp: Type.Number() }),
  Type.Object({
    role: Type.Literal("toolResult"),
    toolCallId: Type.String(),
    content: Type.Array(Type.Unknown()),
    isError: Type.Boolean(),
    timestamp: Type.Number(),
  }),
]);

export type RecordedMessage = Static<typeof RecordedMessageSchema>;

/** Tool output beyond this many characters is cut, so one large result can't blow up the outbox or the thread. */
const MAX_OUTPUT_CHARS = 50_000;

const TOOL_KINDS = new Map([
  ["read", "read"],
  ["bash", "execute"],
  ["powershell", "execute"],
  ["edit", "edit"],
  ["write", "edit"],
  ["grep", "search"],
  ["find", "search"],
  ["ls", "search"],
]);

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;
}

/** Keep the blocks Delta can show, dropping blank text and anything that isn't text or an image. */
function contentBlocks(content: readonly unknown[]): Static<typeof ContentBlock>[] {
  return content.filter((block) => Value.Check(ContentBlock, block)).filter((block) => block.type !== "text" || block.text.trim());
}

/**
 * Build the one-line title Delta shows for a tool call, in the style of the ACP Claude adapter.
 *
 * Pi's built-in tools get a title from their main argument, such as the shell command or the file path. Any other
 * tool, or a call whose arguments don't match the built-in shapes, is titled with its bare name.
 */
export function toolTitle(name: string, args: unknown): string {
  const { path = "", command = "", pattern = "" } = Value.Check(ToolArguments, args) ? args : {};

  switch (name) {
    case "bash":
    case "powershell":
      return command || name;
    case "read":
      return `Read ${path}`;
    case "edit":
      return `Edit ${path}`;
    case "write":
      return `Write ${path}`;
    case "grep":
      return `grep ${pattern} ${path}`.trim();
    case "find":
      return `find ${pattern}`;
    case "ls":
      return `ls ${path}`.trim();
    default:
      return name;
  }
}

function userUpdate(id: string, content: string | readonly unknown[]): Update[] {
  const blocks = contentBlocks(Array.isArray(content) ? content : [{ type: "text", text: content }]);
  return blocks.length ? [{ sessionUpdate: "user_message", messageId: id, content: blocks }] : [];
}

/**
 * Split an assistant message into Delta updates, in order.
 *
 * Adjacent text blocks become one `agent_message`, thinking becomes `agent_thought`, and each tool call becomes an
 * `in_progress` `tool_call_update` whose result arrives later from the matching tool result message.
 */
function assistantUpdates(id: string, content: readonly unknown[]): Update[] {
  const updates: Update[] = [];
  let text: TextContent[] = [];
  let textStart = 0;

  const flushText = () => {
    if (text.length) updates.push({ sessionUpdate: "agent_message", messageId: `${id}:message:${textStart}`, content: text });
    text = [];
  };

  content.forEach((block, index) => {
    if (!Value.Check(AssistantBlock, block)) return;

    if (block.type === "text") {
      if (!block.text.trim()) return;
      if (!text.length) textStart = index;

      text.push(block);
      return;
    }

    flushText();

    if (block.type === "thinking") {
      const thought = block.redacted ? "[redacted thinking]" : block.thinking;
      if (!thought.trim()) return;

      updates.push({ sessionUpdate: "agent_thought", messageId: `${id}:thought:${index}`, content: [{ type: "text", text: thought }] });
      return;
    }

    updates.push({
      sessionUpdate: "tool_call_update",
      toolCallId: block.id,
      title: toolTitle(block.name, block.arguments),
      kind: TOOL_KINDS.get(block.name) ?? "other",
      status: "in_progress",
      rawInput: block.arguments ?? {},
    });
  });

  flushText();
  return updates;
}

function toolResultUpdate(toolCallId: string, content: readonly unknown[], isError: boolean): Update {
  const text = contentBlocks(content).map((block) => (block.type === "text" ? block.text : "")).filter(Boolean);
  const output = truncate(text.join("\n"), MAX_OUTPUT_CHARS);

  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: isError ? "failed" : "completed",
    rawOutput: { output },
    content: output ? [{ type: "content", content: { type: "text", text: output } }] : [],
  };
}

/**
 * Translate one finalized Pi message into Delta session updates.
 *
 * Message IDs derive from the message's role and timestamp, so translating the same message twice produces the same
 * IDs and Delta treats the second copy as a replacement rather than new content.
 */
export function translateMessage(message: RecordedMessage): Update[] {
  const id = `${message.role}-${message.timestamp}`;

  switch (message.role) {
    case "user":
      return userUpdate(id, message.content);
    case "assistant":
      return assistantUpdates(id, message.content);
    case "toolResult":
      return [toolResultUpdate(message.toolCallId, message.content, message.isError)];
  }
}

/** Narrow an arbitrary Pi `AgentMessage` to the roles Delta records, or return `undefined` for any other message. */
export function asRecordedMessage(message: unknown): RecordedMessage | undefined {
  return Value.Check(RecordedMessageSchema, message) ? message : undefined;
}
