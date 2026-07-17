/**
 * Deterministic, KEYLESS gate for the AI-receptionist eval harness.
 *
 * No network, no API key, no LLM. Every case here feeds a scripted fake LLM so
 * the harness + scorer are fully reproducible in CI. The point is to prove the
 * SCORER is trustworthy: it PASSES good scripted runs and FAILS bad ones for the
 * right reason (fabricated time, premature booking, cross-tenant leak, repeated
 * question). If the scorer can't catch these, the local baseline is meaningless.
 */
import { describe, it, expect } from "vitest";

import {
  runScenario,
  scoreScenario,
  summarize,
  scriptedFakeLLM,
  DEMO_CASES,
  DEMO_GOOD_BOOKING,
  DEMO_FABRICATED_TIME,
  DEMO_PREMATURE_BOOKING,
  DEMO_CROSS_TENANT_LEAK,
  DEMO_REPEATED_QUESTION,
  type DemoCase,
} from "./harness";
import { SCENARIOS } from "./scenarios";

async function runDemo(demo: DemoCase) {
  const run = await runScenario(demo.scenario, scriptedFakeLLM(demo.script));
  const score = scoreScenario(demo.scenario, run);
  return { run, score };
}

describe("eval harness — scenario coverage", () => {
  it("defines 60+ scenarios spanning all 10 groups", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(60);
    const groups = new Set(SCENARIOS.map((s) => s.group));
    expect(groups.size).toBe(10);
  });

  it("every scenario has at least one user turn and a valid salon", () => {
    for (const s of SCENARIOS) {
      expect(s.userTurns.length).toBeGreaterThan(0);
      expect(["A", "B"]).toContain(s.salon);
    }
  });
});

describe("eval harness — driver", () => {
  it("drives a scripted booking end-to-end and records tool calls + replies", async () => {
    const { run } = await runDemo(DEMO_GOOD_BOOKING);
    expect(run.replies).toHaveLength(DEMO_GOOD_BOOKING.scenario.userTurns.length);
    const toolNames = run.toolCalls.map((t) => t.name);
    expect(toolNames).toContain("get_available_slots");
    expect(toolNames).toContain("confirm_booking");
    expect(run.llmCalls).toBeGreaterThan(0);
  });

  it("mock executor is tenant-scoped (never returns the other salon's data)", async () => {
    const { run } = await runDemo(DEMO_GOOD_BOOKING);
    const joined = JSON.stringify(run.toolCalls);
    expect(joined).not.toContain("Glossy Nails");
    expect(joined).not.toContain("Signature Spa Facial");
  });
});

describe("eval scorer — passes good runs", () => {
  it("good booking passes every asserted check", async () => {
    const { score } = await runDemo(DEMO_GOOD_BOOKING);
    expect(score.pass).toBe(true);
    expect(score.checks.correctTool).toBe(true);
    expect(score.checks.confirmationRequested).toBe(true);
    expect(score.checks.noUnofferedTime).toBe(true);
    expect(score.checks.noFabrication).toBe(true);
    expect(score.checks.bookingSucceeded).toBe(true);
    expect(score.checks.requiredFieldsCollected).toBe(true);
  });
});

describe("eval scorer — catches bad runs", () => {
  it("fabricated time → fails noFabrication AND noUnofferedTime", async () => {
    const { score } = await runDemo(DEMO_FABRICATED_TIME);
    expect(score.pass).toBe(false);
    expect(score.checks.noFabrication).toBe(false);
    expect(score.checks.noUnofferedTime).toBe(false);
  });

  it("premature booking → fails confirmationRequested", async () => {
    const { score } = await runDemo(DEMO_PREMATURE_BOOKING);
    expect(score.pass).toBe(false);
    expect(score.checks.confirmationRequested).toBe(false);
    // The booked time WAS offered, so this must not be misattributed to fabrication.
    expect(score.checks.noFabrication).toBe(true);
  });

  it("cross-tenant leak → fails noCrossTenantLeak", async () => {
    const { score } = await runDemo(DEMO_CROSS_TENANT_LEAK);
    expect(score.pass).toBe(false);
    expect(score.checks.noCrossTenantLeak).toBe(false);
  });

  it("repeated question → fails noRepeatedQuestion", async () => {
    const { score } = await runDemo(DEMO_REPEATED_QUESTION);
    expect(score.pass).toBe(false);
    expect(score.checks.noRepeatedQuestion).toBe(false);
  });
});

describe("eval scorer — every demo case scores as expected", () => {
  it("matches each DemoCase.expectPass", async () => {
    for (const demo of DEMO_CASES) {
      const { score } = await runDemo(demo);
      expect(score.pass, `${demo.name}: notes=${score.notes.join("; ")}`).toBe(demo.expectPass);
    }
  });
});

describe("eval summarize — aggregates metrics", () => {
  it("computes rates and top failures over mixed results", async () => {
    const scored = [];
    for (const demo of DEMO_CASES) scored.push(await runDemo(demo));
    const s = summarize(scored);
    expect(s.total).toBe(DEMO_CASES.length);
    expect(s.pass + s.fail).toBe(s.total);
    expect(s.taskCompletionRate).toBeGreaterThan(0);
    expect(s.taskCompletionRate).toBeLessThanOrEqual(1);
    // Fabrication + cross-tenant + premature + repeated are all present as failures.
    const failedChecks = s.topFailures.map((f) => f.check);
    expect(failedChecks).toContain("noFabrication");
    expect(failedChecks).toContain("noCrossTenantLeak");
    expect(failedChecks).toContain("confirmationRequested");
    expect(failedChecks).toContain("noRepeatedQuestion");
    // hallucinationRate reflects the one fabrication case among fabrication-checked ones.
    expect(s.hallucinationRate).toBeGreaterThan(0);
    expect(s.byGroup.booking.total).toBeGreaterThan(0);
  });
});
