import { describe, expect, it } from "bun:test";
import { translateMessage } from "./translate.ts";

describe("translateMessage", () => {
  it("splits an assistant message into ordered message, thought, and tool call updates", () => {
    const updates = translateMessage({
      role: "assistant",
      timestamp: 7,
      content: [
        { type: "thinking", thinking: "Check the tests" },
        { type: "text", text: "Running them." },
        { type: "text", text: "Now." },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "bun test" } },
      ],
    });

    expect(updates).toEqual([
      { sessionUpdate: "agent_thought", messageId: "assistant-7:thought:0", content: [{ type: "text", text: "Check the tests" }] },
      {
        sessionUpdate: "agent_message",
        messageId: "assistant-7:message:1",
        content: [
          { type: "text", text: "Running them." },
          { type: "text", text: "Now." },
        ],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        title: "bun test",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "bun test" },
      },
    ]);
  });

  it("records a failed tool result with its output", () => {
    const [update] = translateMessage({
      role: "toolResult",
      toolCallId: "call-1",
      isError: true,
      timestamp: 8,
      content: [{ type: "text", text: "exit 1" }],
    });

    expect(update).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "failed",
      rawOutput: { output: "exit 1" },
      content: [{ type: "content", content: { type: "text", text: "exit 1" } }],
    });
  });
});
