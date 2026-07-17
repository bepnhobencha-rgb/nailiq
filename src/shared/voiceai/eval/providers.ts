/**
 * Provider-agnostic LLM adapter for the LOCAL intelligence eval.
 *
 * SECURITY (must hold): this module NEVER prints, echoes, logs, or returns an API
 * key value. It only checks whether an env var EXISTS (`!!process.env.X`) to pick
 * a provider, and passes the key straight into an Authorization header of a fetch
 * call. No key ever enters a return value, log line, or the eval report.
 *
 * Two fetch-based backends (no SDK dependency): OpenAI Chat Completions and
 * Anthropic Messages. Both are exposed as the SAME `LlmComplete` the harness /
 * runSmsAgent already speak (Anthropic-shaped content blocks), so the harness is
 * provider-agnostic — swap the provider by which key is present, nothing else.
 *
 * Fake-LLM CI tests never import this file; it is only used by the manual local
 * baseline runner.
 */
import type { LlmComplete, ContentBlock, AnthropicTool, AgentMessage } from "../smsAgent";

export type Usage = { requests: number; inputTokens: number; outputTokens: number };

export type EvalProvider = {
  name: "openai" | "anthropic";
  model: string;
  complete: LlmComplete;
  usage: Usage;
  estCostUsd: () => number;
};

const MAX_TOKENS = 400;
const TEMPERATURE = 0.3;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 5;         // 429s are common on lower tiers — retry patiently
const MIN_CALL_SPACING_MS = 350; // gentle pacing between calls to avoid RPM limits

// USD per 1M tokens (input, output). Rough public list prices; only used to
// estimate spend and enforce the budget cap — not billing-accurate.
const PRICING: Record<string, { in: number; out: number }> = {
  "gpt-4o":                     { in: 2.5, out: 10 },
  "gpt-4o-mini":                { in: 0.15, out: 0.6 },
  "gpt-4.1":                    { in: 2, out: 8 },
  "gpt-4.1-mini":               { in: 0.4, out: 1.6 },
  "claude-sonnet-5":            { in: 3, out: 15 },
  "claude-haiku-4-5-20251001":  { in: 0.8, out: 4 },
};

function costFor(model: string, u: Usage): number {
  const p = PRICING[model] ?? { in: 3, out: 12 }; // conservative default
  return (u.inputTokens / 1e6) * p.in + (u.outputTokens / 1e6) * p.out;
}

/** Pick a provider purely from which key EXISTS — never reads the value. */
export function selectProvider(): EvalProvider | null {
  const model = process.env.EVAL_MODEL?.trim();
  if (process.env.OPENAI_API_KEY) return makeOpenAI(model || "gpt-4o");
  if (process.env.ANTHROPIC_API_KEY) return makeAnthropic(model || "claude-sonnet-5");
  return null;
}

/** Which providers have a key present (existence only) — for a helpful message. */
export function availableProviders(): string[] {
  const out: string[] = [];
  if (process.env.OPENAI_API_KEY) out.push("openai");
  if (process.env.ANTHROPIC_API_KEY) out.push("anthropic");
  return out;
}

let lastCallAt = 0;

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Gentle global pacing so a burst doesn't trip RPM limits.
    const since = Date.now() - lastCallAt;
    if (since < MIN_CALL_SPACING_MS) await sleep(MIN_CALL_SPACING_MS - since);
    lastCallAt = Date.now();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(url, { ...init, signal: ac.signal });
      clearTimeout(timer);
      // Retry on rate-limit (429) and server errors, honouring Retry-After.
      if ((r.status === 429 || r.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(r.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 20_000);
        await sleep(backoff);
        continue;
      }
      return r;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < MAX_RETRIES) { await sleep(Math.min(1000 * 2 ** attempt, 20_000)); continue; }
    }
  }
  throw lastErr ?? new Error("request_failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ── OpenAI Chat Completions adapter ─────────────────────────────────────────

function makeOpenAI(model: string): EvalProvider {
  const usage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const complete: LlmComplete = async ({ system, tools, messages }) => {
    const body = {
      model,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      messages: toOpenAIMessages(system, messages),
      tools: toOpenAITools(tools),
    };
    const r = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`openai_http_${r.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await r.json();
    usage.requests += 1;
    usage.inputTokens += j.usage?.prompt_tokens ?? 0;
    usage.outputTokens += j.usage?.completion_tokens ?? 0;
    return fromOpenAI(j);
  };
  return { name: "openai", model, complete, usage, estCostUsd: () => costFor(model, usage) };
}

function toOpenAITools(tools: AnthropicTool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function toOpenAIMessages(system: string, messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join(" ");
      const toolCalls = m.content
        .filter((b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      // user turn carrying tool_result blocks → one OpenAI "tool" message each
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
        }
      }
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromOpenAI(j: any): { stop_reason: string | null; content: ContentBlock[] } {
  const msg = j.choices?.[0]?.message ?? {};
  const blocks: ContentBlock[] = [];
  if (msg.content) blocks.push({ type: "text", text: String(msg.content) });
  const calls = msg.tool_calls ?? [];
  for (const tc of calls) {
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(tc.function?.arguments ?? "{}"); } catch { input = {}; }
    blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input });
  }
  const stop = calls.length ? "tool_use" : (j.choices?.[0]?.finish_reason ?? "end_turn");
  return { stop_reason: stop, content: blocks };
}

// ── Anthropic Messages adapter ──────────────────────────────────────────────

function makeAnthropic(model: string): EvalProvider {
  const usage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const complete: LlmComplete = async ({ system, tools, messages }) => {
    const r = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, tools, messages }),
    });
    if (!r.ok) throw new Error(`anthropic_http_${r.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await r.json();
    usage.requests += 1;
    usage.inputTokens += j.usage?.input_tokens ?? 0;
    usage.outputTokens += j.usage?.output_tokens ?? 0;
    return { stop_reason: j.stop_reason ?? "end_turn", content: (j.content ?? []) as ContentBlock[] };
  };
  return { name: "anthropic", model, complete, usage, estCostUsd: () => costFor(model, usage) };
}

/** Pre-run cost estimate for a scenario batch, to enforce the budget cap. */
export function estimateCostUsd(model: string, scenarioCount: number, avgTurns = 5): number {
  const inPerTurn = 2700; // system prompt + growing history, rough
  const outPerTurn = 220;
  const u: Usage = {
    requests: scenarioCount * avgTurns,
    inputTokens: scenarioCount * avgTurns * inPerTurn,
    outputTokens: scenarioCount * avgTurns * outPerTurn,
  };
  return costFor(model, u);
}
