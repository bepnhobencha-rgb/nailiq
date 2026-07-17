/**
 * Local intelligence-eval runner for the AI receptionist — NOT a vitest test.
 *
 *   npx tsx src/shared/voiceai/eval/runLocalEval.ts
 *
 * PROVIDER-AGNOSTIC: it uses whichever API key is PRESENT in the environment
 * (OpenAI preferred, else Anthropic) via src/shared/voiceai/eval/providers.ts.
 * It NEVER prints, echoes, logs, or embeds the key value — only checks existence.
 * With no key it prints a note and exits 0, so it can never break CI. The
 * deterministic fake-LLM gate (harness.spec.ts) is what runs in CI; this paid
 * run is manual and local only.
 *
 * Guards: pre-run cost estimate with a hard US$10 cap (stops BEFORE spending if
 * the estimate exceeds it), ≤8 tool turns/scenario, hard stop at 200 LLM calls,
 * bounded retries + timeouts (in providers.ts), sequential (low concurrency).
 *
 * Data: fixtures only (2 fake salons) — no production data/salon/DB, no real
 * SMS/OTP/calls, no production bookings.
 *
 * Fidelity caveat: production VOICE runs on gpt-realtime; this measures the
 * SHARED system prompt + tool schemas (identical across web/phone/SMS) on a text
 * model — i.e. prompt/tool BEHAVIOUR (intent, tool choice, no-fabrication,
 * confirmation discipline, tenant isolation).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { SCENARIOS } from "./scenarios";
import { runScenario, scoreScenario, summarize, type Scored } from "./harness";
import { selectProvider, availableProviders, estimateCostUsd } from "./providers";

// Convenience: load a local .env.local if present (never prints values). The run
// command may also set the key inline; either way only existence is checked.
loadEnv({ path: process.env.EVAL_ENV_FILE || ".env.local" });

const MAX_TOOL_TURNS = 8;
const MAX_TOTAL_LLM_CALLS = 200;
const BUDGET_USD = 10;
const PROMPT_VERSION = "v0-baseline (pre-PR2, unversioned)";

class BudgetExceeded extends Error {}

function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }

/** Redact phone / email / OTP-like digit runs from any string before output. */
function redact(s: string): string {
  return s
    .replace(/\b\d{6}\b/g, "[code]")
    .replace(/[+]?\d[\d ().-]{7,}\d/g, "[phone]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]");
}

function groupRate(byGroup: Record<string, { total: number; pass: number }>, ...keywords: string[]): { total: number; pass: number } {
  let total = 0, pass = 0;
  for (const [g, v] of Object.entries(byGroup)) {
    if (keywords.some((k) => g.toLowerCase().includes(k))) { total += v.total; pass += v.pass; }
  }
  return { total, pass };
}

async function main(): Promise<void> {
  const provider = selectProvider();
  if (!provider) {
    console.log(
      "\nℹ️  No LLM API key present (checked OPENAI_API_KEY, ANTHROPIC_API_KEY) — skipping the live baseline.\n" +
        "   CI uses the keyless deterministic gate (npm run test:unit → harness.spec.ts).\n" +
        "   To run locally, export a key (never committed), e.g.:\n" +
        "     OPENAI_API_KEY=… npx tsx src/shared/voiceai/eval/runLocalEval.ts\n",
    );
    process.exit(0);
  }

  // Pre-run budget gate — stop BEFORE spending if the estimate exceeds the cap.
  const estimate = estimateCostUsd(provider.model, SCENARIOS.length);
  console.log(`\n🧪 Local baseline — provider=${provider.name} model=${provider.model}, ${SCENARIOS.length} scenarios`);
  console.log(`   Prompt version: ${PROMPT_VERSION}`);
  console.log(`   Estimated cost ≈ $${estimate.toFixed(2)} (cap $${BUDGET_USD})`);
  if (availableProviders().length > 1) console.log(`   (keys present: ${availableProviders().join(", ")} — set EVAL_MODEL to override)`);
  if (estimate > BUDGET_USD) {
    console.log(`\n⛔ Estimated cost $${estimate.toFixed(2)} exceeds the $${BUDGET_USD} cap — stopping before any spend.`);
    console.log(`   Lower cost: set EVAL_MODEL to a cheaper model, or reduce scenarios.\n`);
    process.exit(0);
  }
  console.log("");

  let totalLlmCalls = 0;
  const complete = async (args: Parameters<typeof provider.complete>[0]) => {
    if (totalLlmCalls >= MAX_TOTAL_LLM_CALLS) throw new BudgetExceeded();
    totalLlmCalls += 1;
    return provider.complete(args);
  };

  const results: Scored[] = [];
  let budgetHit = false;
  for (const scenario of SCENARIOS) {
    if (budgetHit) break;
    try {
      const run = await runScenario(scenario, complete, { maxToolTurns: MAX_TOOL_TURNS });
      const score = scoreScenario(scenario, run);
      results.push({ run, score });
      const mark = score.pass ? "✅" : "❌";
      const why = score.pass ? "" : `  — ${redact(score.notes.slice(0, 2).join("; "))}`;
      console.log(`${mark} [${scenario.group}] ${scenario.id}${why}`);
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        budgetHit = true;
        console.log(`\n⏸️  Budget guard hit (${MAX_TOTAL_LLM_CALLS} LLM calls) — stopping early.\n`);
        break;
      }
      console.error(`⚠️  ${scenario.id} errored:`, err instanceof Error ? err.message : err);
    }
  }

  const s = summarize(results);
  const bilingual = groupRate(s.byGroup, "bilingual", "mixed", "language");
  const safety = groupRate(s.byGroup, "safety", "hallucinat");
  const isolation = groupRate(s.byGroup, "isolation", "tenant", "safety");
  const fabAvail = s.topFailures.find((f) => /unoffered|availab|fabric/i.test(f.check))?.count ?? 0;
  const fabPrice = s.topFailures.find((f) => /price|fabric/i.test(f.check))?.count ?? 0;
  const cost = provider.estCostUsd();

  const lines: string[] = [];
  const P = (l: string) => { lines.push(l); console.log(l); };

  P("\n════════════ AI RECEPTIONIST — BASELINE REPORT ════════════");
  P(`Date (UTC)            : ${new Date().toISOString()}`);
  P(`Provider / model      : ${provider.name} / ${provider.model}`);
  P(`Prompt version        : ${PROMPT_VERSION}`);
  P(`Scored scenarios      : ${s.total}${budgetHit ? " (PARTIAL — budget guard)" : ""}`);
  P(`Pass / Fail           : ${s.pass} / ${s.fail}`);
  P(`Task completion rate  : ${pct(s.taskCompletionRate)}`);
  P(`Tool-call accuracy    : ${pct(s.toolAccuracy)}`);
  P(`Hallucination rate    : ${pct(s.hallucinationRate)}`);
  P(`Fabricated availability: ${fabAvail} scenario(s)`);
  P(`Fabricated prices     : ${fabPrice} scenario(s)`);
  P(`Repeated-question rate: ${pct(s.repeatedQuestionRate)}`);
  P(`False-confirm rate    : ${pct(s.falseConfirmationRate)}`);
  P(`Booking success rate  : ${pct(s.bookingSuccessRate)}`);
  P(`Average turns/booking : ${s.avgTurnsToBooking.toFixed(2)}`);
  P(`Bilingual pass rate   : ${bilingual.total ? pct(bilingual.pass / bilingual.total) : "n/a"} (${bilingual.pass}/${bilingual.total})`);
  P(`Safety pass rate      : ${safety.total ? pct(safety.pass / safety.total) : "n/a"} (${safety.pass}/${safety.total})`);
  P(`Tenant-isolation pass : ${isolation.total ? pct(isolation.pass / isolation.total) : "n/a"} (${isolation.pass}/${isolation.total})`);
  P(`Total LLM requests    : ${provider.usage.requests}`);
  P(`Token usage (in/out)  : ${provider.usage.inputTokens} / ${provider.usage.outputTokens}`);
  P(`Estimated cost        : $${cost.toFixed(3)}`);

  P("\n──────────── PER-GROUP PASS TABLE ────────────");
  for (const g of Object.keys(s.byGroup).sort()) {
    const { total, pass } = s.byGroup[g]!;
    P(`  ${g.padEnd(16)} ${String(pass).padStart(3)}/${String(total).padEnd(3)}  ${total ? pct(pass / total) : "n/a"}`);
  }

  P("\n──────────── TOP 10 FAILURE ROOT CAUSES ────────────");
  if (s.topFailures.length === 0) P("  (none — all asserted checks passed)");
  else for (const { check, count } of s.topFailures.slice(0, 10)) P(`  ${String(count).padStart(3)}×  ${check}`);
  P("");

  // Persist a PII-redacted report to the audit folder.
  try {
    mkdirSync("docs/ai-receptionist", { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const path = `docs/ai-receptionist/EVAL-BASELINE-${stamp}.md`;
    writeFileSync(path, "# AI Receptionist — Baseline Eval (PII-redacted)\n\n```\n" + redact(lines.join("\n")).trim() + "\n```\n");
    console.log(`📝 Saved PII-redacted report → ${path}\n`);
  } catch (e) {
    console.warn("Could not write report file:", e instanceof Error ? e.message : e);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("runLocalEval failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
