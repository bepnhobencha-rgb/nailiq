import "server-only";

/**
 * AI Receptionist — SMS transport (Module 4).
 *
 * SMS is text, so it cannot ride the OpenAI Realtime (audio) path the web widget
 * and phone bridge use. But the *brain* is the same: identical system prompt
 * (buildSystemPrompt) and identical tools (the REALTIME_TOOLS schemas, executed
 * by the SAME /api/voice/tool handlers). Only the loop differs — here an
 * Anthropic text tool-use loop instead of a streaming voice session.
 *
 * This module is pure orchestration: the LLM call (`complete`) and the tool
 * executor (`callTool`) are injected, so the whole loop is unit-testable without
 * a network, an API key, or a phone. The route wires the real implementations.
 *
 * Identity: unlike a voice call (carrier caller-ID / SHAKEN-STIR), an inbound
 * SMS `From` is NOT treated as verified — the route deliberately does NOT pass
 * callerVerifiedPhone, so every booking mutation forces an OTP round-trip. That
 * both matches the product intent (no wrong/fake changes) and defends against
 * `From` spoofing: a spoofer who does not hold the SIM never receives the code.
 */

export const SMS_AGENT_MODEL = "claude-haiku-4-5-20251001";
export const SMS_MAX_TOOL_TURNS = 6;
export const SMS_MAX_HISTORY = 20; // persisted plain-text turns (10 exchanges)
export const SMS_MAX_REPLY_TOKENS = 320;

/** A Realtime tool schema, as stored in REALTIME_TOOLS. */
export type RealtimeToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** Anthropic tool schema. */
export type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/** Minimal Anthropic content-block shapes we read/write. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

/** A message in the working transcript (Anthropic format). */
export type AgentMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };

/** A persisted conversation turn — always clean alternating plain text. */
export type StoredTurn = { role: "user" | "assistant"; content: string };

/** Injected LLM call — one Anthropic messages.create round. */
export type LlmComplete = (args: {
  system: string;
  tools: AnthropicTool[];
  messages: AgentMessage[];
}) => Promise<{ stop_reason: string | null; content: ContentBlock[] }>;

/** Injected tool executor — runs one tool and returns its JSON result. */
export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<unknown>;

/** Convert the Realtime tool schemas to Anthropic tool schemas (same shape, renamed field). */
export function toAnthropicTools(tools: readonly RealtimeToolSchema[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/** Join the text blocks of an assistant message into a single string. */
export function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

/**
 * Keep the conversation short and Anthropic-valid: retain the last `max` turns,
 * then drop any leading assistant turn so the stored history always starts with
 * a user message (an assistant-first transcript is rejected on the next call).
 */
export function trimHistory(turns: StoredTurn[], max: number): StoredTurn[] {
  let kept = turns.slice(-max);
  while (kept.length > 0 && kept[0].role === "assistant") kept = kept.slice(1);
  return kept;
}

/**
 * Run one inbound SMS through the agent: seed the working transcript with prior
 * turns + the new user text, then loop the LLM, executing any tool calls against
 * the injected executor, until it answers with text (or the tool budget runs
 * out). Returns the reply to text back plus the two clean turns to persist.
 */
export async function runSmsAgent(opts: {
  system: string;
  tools: AnthropicTool[];
  history: StoredTurn[];
  userText: string;
  complete: LlmComplete;
  callTool: ToolExecutor;
  maxToolTurns?: number;
}): Promise<{ reply: string; turns: StoredTurn[] }> {
  const maxTurns = opts.maxToolTurns ?? SMS_MAX_TOOL_TURNS;
  const working: AgentMessage[] = [
    ...opts.history.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: opts.userText },
  ];

  let reply = "";
  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await opts.complete({ system: opts.system, tools: opts.tools, messages: working });
    working.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        b.type === "tool_use",
    );

    if (resp.stop_reason !== "tool_use" || toolUses.length === 0) {
      reply = extractText(resp.content);
      break;
    }

    const results: ContentBlock[] = [];
    for (const tu of toolUses) {
      let result: unknown;
      try {
        result = await opts.callTool(tu.name, tu.input);
      } catch {
        result = { error: "tool_unavailable" };
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    working.push({ role: "user", content: results });
  }

  if (!reply) {
    // Tool budget exhausted without a final answer — never leave the customer
    // hanging silently. A generic, safe fallback keeps the thread honest.
    reply = "Sorry, I couldn't finish that just now. Please try again, or call the salon directly.";
  }

  const turns: StoredTurn[] = [
    { role: "user", content: opts.userText },
    { role: "assistant", content: reply },
  ];
  return { reply, turns };
}
