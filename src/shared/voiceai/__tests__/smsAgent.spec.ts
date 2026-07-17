import { describe, it, expect } from "vitest";

import {
  toAnthropicTools,
  extractText,
  trimHistory,
  runSmsAgent,
  type RealtimeToolSchema,
  type ContentBlock,
  type LlmComplete,
  type StoredTurn,
} from "../smsAgent";

describe("toAnthropicTools", () => {
  it("renames `parameters` to `input_schema`, keeps name + description", () => {
    const rt: RealtimeToolSchema[] = [
      { type: "function", name: "get_available_slots", description: "d", parameters: { type: "object", properties: {} } },
    ];
    expect(toAnthropicTools(rt)).toEqual([
      { name: "get_available_slots", description: "d", input_schema: { type: "object", properties: {} } },
    ]);
  });
});

describe("extractText", () => {
  it("joins only text blocks, ignoring tool_use", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "Hi" },
      { type: "tool_use", id: "1", name: "x", input: {} },
      { type: "text", text: "there" },
    ];
    expect(extractText(content)).toBe("Hi there");
  });
});

describe("trimHistory", () => {
  it("keeps the last `max` turns", () => {
    const turns: StoredTurn[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: String(i),
    }));
    expect(trimHistory(turns, 20)).toHaveLength(20);
  });

  it("drops a leading assistant turn so history starts with a user message", () => {
    const turns: StoredTurn[] = [
      { role: "assistant", content: "orphan" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(trimHistory(turns, 20)[0].role).toBe("user");
  });
});

describe("runSmsAgent", () => {
  const base = {
    system: "sys",
    tools: [],
    history: [] as StoredTurn[],
    callTool: async () => ({ ok: true }),
  };

  it("returns the text reply and two clean turns when the LLM answers directly", async () => {
    const complete: LlmComplete = async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "We open at 9am." }],
    });
    const res = await runSmsAgent({ ...base, userText: "what time do you open?", complete });
    expect(res.reply).toBe("We open at 9am.");
    expect(res.turns).toEqual([
      { role: "user", content: "what time do you open?" },
      { role: "assistant", content: "We open at 9am." },
    ]);
  });

  it("executes a tool call, feeds the result back, then answers", async () => {
    const calls: string[] = [];
    let step = 0;
    const complete: LlmComplete = async () => {
      step += 1;
      if (step === 1) {
        return {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "t1", name: "get_available_slots", input: { date: "2026-07-20" } }],
        };
      }
      return { stop_reason: "end_turn", content: [{ type: "text", text: "2pm is free." }] };
    };
    const res = await runSmsAgent({
      ...base,
      userText: "any slot monday?",
      complete,
      callTool: async (name) => {
        calls.push(name);
        return { slots: ["14:00"] };
      },
    });
    expect(calls).toEqual(["get_available_slots"]);
    expect(res.reply).toBe("2pm is free.");
  });

  it("surfaces tool_unavailable when the executor throws, without crashing", async () => {
    let step = 0;
    const complete: LlmComplete = async ({ messages }) => {
      step += 1;
      if (step === 1) {
        return {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "t1", name: "cancel_booking", input: {} }],
        };
      }
      // The 2nd call should see the tool_result block we fed back.
      const last = messages[messages.length - 1];
      const block = Array.isArray(last.content) ? last.content[0] : null;
      const sawError = block?.type === "tool_result" && block.content.includes("tool_unavailable");
      return { stop_reason: "end_turn", content: [{ type: "text", text: sawError ? "err-seen" : "no" }] };
    };
    const res = await runSmsAgent({
      ...base,
      userText: "cancel it",
      complete,
      callTool: async () => {
        throw new Error("boom");
      },
    });
    expect(res.reply).toBe("err-seen");
  });

  it("falls back to a safe reply when the tool budget is exhausted", async () => {
    // Always asks for a tool → never answers → hits maxToolTurns.
    const complete: LlmComplete = async () => ({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t", name: "get_available_slots", input: {} }],
    });
    const res = await runSmsAgent({ ...base, userText: "loop", complete, maxToolTurns: 3 });
    expect(res.reply).toMatch(/couldn't finish|call the salon/i);
  });
});
