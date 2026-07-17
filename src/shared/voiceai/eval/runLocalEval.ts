/**
 * Local baseline runner for the AI-receptionist eval — NOT a vitest test.
 *
 *   npx tsx src/shared/voiceai/eval/runLocalEval.ts
 *
 * Reads ANTHROPIC_API_KEY from the environment. If it is absent this prints a
 * clear note and exits 0, so it can live in a repo without ever breaking CI. If
 * present it builds a REAL LlmComplete over Anthropic (mirroring the wrapper in
 * src/app/api/twilio/sms/route.ts — claude-sonnet-5, max_tokens 320, system +
 * tools + messages), runs every scenario, scores them, and prints the full
 * baseline report: aggregate metrics, a per-group pass table, and the top
 * failure reasons.
 *
 * Budget guards: ≤ ~8 tool turns per scenario and a hard stop after ~200 total
 * LLM calls, so a bad run can't rack up cost.
 *
 * Fidelity caveat: production VOICE runs on gpt-realtime; this measures the
 * SHARED system prompt + tool schemas (identical across web/phone/SMS) on a text
 * model. It evaluates prompt/tool BEHAVIOUR — intent, tool choice, no-fabrication,
 * confirmation discipline, tenant isolation — which is the part that is shared.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  SMS_AGENT_MODEL,
  SMS_MAX_REPLY_TOKENS,
  type LlmComplete,
  type ContentBlock,
} from "../smsAgent";
import { SCENARIOS } from "./scenarios";
import { runScenario, scoreScenario, summarize, type Scored } from "./harness";

const MAX_TOOL_TURNS = 8;
const MAX_TOTAL_LLM_CALLS = 200;

class BudgetExceeded extends Error {}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.log(
      "\nℹ️  ANTHROPIC_API_KEY not set — skipping the live baseline.\n" +
        "   The deterministic gate (npm run test:unit → harness.spec.ts) covers the\n" +
        "   scorer with a scripted fake LLM and needs no key. To run the live baseline:\n" +
        "     ANTHROPIC_API_KEY=sk-... npx tsx src/shared/voiceai/eval/runLocalEval.ts\n",
    );
    process.exit(0);
  }

  const ai = new Anthropic({ apiKey });
  let totalLlmCalls = 0;

  const complete: LlmComplete = async ({ system, tools, messages }) => {
    if (totalLlmCalls >= MAX_TOTAL_LLM_CALLS) throw new BudgetExceeded();
    totalLlmCalls += 1;
    const resp = await ai.messages.create({
      model: SMS_AGENT_MODEL,
      max_tokens: SMS_MAX_REPLY_TOKENS,
      system,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
    });
    return { stop_reason: resp.stop_reason, content: resp.content as unknown as ContentBlock[] };
  };

  console.log(`\n🧪 Live baseline — model ${SMS_AGENT_MODEL}, ${SCENARIOS.length} scenarios`);
  console.log(`   (shared prompt+tools on a text model; voice prod uses gpt-realtime)\n`);

  const results: Scored[] = [];
  let budgetHit = false;

  for (const scenario of SCENARIOS) {
    if (budgetHit) break;
    try {
      const run = await runScenario(scenario, complete, { maxToolTurns: MAX_TOOL_TURNS });
      const score = scoreScenario(scenario, run);
      results.push({ run, score });
      const mark = score.pass ? "✅" : "❌";
      const why = score.pass ? "" : `  — ${score.notes.slice(0, 2).join("; ")}`;
      console.log(`${mark} [${scenario.group}] ${scenario.id}${why}`);
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        budgetHit = true;
        console.log(`\n⏸️  Budget guard hit (${MAX_TOTAL_LLM_CALLS} LLM calls) — stopping early.\n`);
        break;
      }
      console.error(`⚠️  ${scenario.id} errored:`, err);
    }
  }

  const s = summarize(results);

  console.log("\n──────────── BASELINE METRICS ────────────");
  console.log(`Scored scenarios      : ${s.total}${budgetHit ? " (partial — budget guard)" : ""}`);
  console.log(`Pass / Fail           : ${s.pass} / ${s.fail}`);
  console.log(`Task completion rate  : ${pct(s.taskCompletionRate)}`);
  console.log(`Tool accuracy         : ${pct(s.toolAccuracy)}`);
  console.log(`Hallucination rate    : ${pct(s.hallucinationRate)}`);
  console.log(`Repeated-question rate: ${pct(s.repeatedQuestionRate)}`);
  console.log(`False-confirm rate    : ${pct(s.falseConfirmationRate)}`);
  console.log(`Booking success rate  : ${pct(s.bookingSuccessRate)}`);
  console.log(`Avg turns to booking  : ${s.avgTurnsToBooking.toFixed(2)}`);
  console.log(`Total LLM calls used  : ${totalLlmCalls}`);

  console.log("\n──────────── PER-GROUP PASS TABLE ────────────");
  const groups = Object.keys(s.byGroup).sort();
  for (const g of groups) {
    const { total, pass } = s.byGroup[g]!;
    const bar = total ? pct(pass / total) : "n/a";
    console.log(`  ${g.padEnd(14)} ${String(pass).padStart(3)}/${String(total).padEnd(3)}  ${bar}`);
  }

  console.log("\n──────────── TOP FAILURE REASONS ────────────");
  if (s.topFailures.length === 0) {
    console.log("  (none — all asserted checks passed)");
  } else {
    for (const { check, count } of s.topFailures) {
      console.log(`  ${String(count).padStart(3)}×  ${check}`);
    }
  }
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("runLocalEval failed:", err);
  process.exit(1);
});
