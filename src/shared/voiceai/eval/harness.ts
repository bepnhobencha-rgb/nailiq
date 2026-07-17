/**
 * Evaluation harness for the AI receptionist.
 *
 * Drives each scenario through the SAME multi-turn loop production uses
 * (runSmsAgent from smsAgent.ts) with an INJECTED LLM (`complete`) and the
 * deterministic mock tool executor from fixtures.ts. Because both are injected,
 * the whole harness runs with ZERO network / API key when fed a scripted fake
 * LLM; swap in a real Anthropic `complete` (see runLocalEval.ts) to measure the
 * live model.
 *
 * Pipeline:
 *   runScenario  → drive turns, collect an ordered event log + tool calls.
 *   scoreScenario → apply only the rubric checks the scenario's `expect` asks for.
 *   summarize     → aggregate metrics across many run+score results.
 *
 * Fidelity caveat: production VOICE uses gpt-realtime; this evaluates the SHARED
 * system prompt + tool schemas (identical across web/phone/SMS) on a text model,
 * which is exactly the prompt/tool behaviour we want to gate.
 */
import {
  runSmsAgent,
  toAnthropicTools,
  type LlmComplete,
  type ContentBlock,
  type AnthropicTool,
  type StoredTurn,
  type RealtimeToolSchema,
} from "../smsAgent";
import { buildSystemPrompt } from "../buildSystemPrompt";
import { REALTIME_TOOLS } from "../realtimeTools";
import {
  SALONS,
  makeMockToolExecutor,
  tenantFingerprints,
  type MockOptions,
} from "./fixtures";
import type { Scenario, ScenarioExpect } from "./scenarios";
import type { SalonVoiceContext } from "../loadSalonContext";

// ─── Shared Anthropic tool set (converted once) ───────────────────────────────

export const EVAL_TOOLS: AnthropicTool[] = toAnthropicTools(
  REALTIME_TOOLS as unknown as RealtimeToolSchema[],
);

const BOOKING_TOOLS = new Set(["confirm_booking", "confirm_group_booking"]);
const FALLBACK_RE = /couldn't finish/i;

// ─── Run result shape ─────────────────────────────────────────────────────────

export type EvalEvent =
  | { kind: "tool"; turn: number; name: string; input: Record<string, unknown>; result: unknown }
  | { kind: "reply"; turn: number; text: string };

export type RunResult = {
  scenario: Scenario;
  lang: "en" | "vi";
  /** One final reply per userTurn. */
  replies: string[];
  /** Ordered event log (tool calls + replies), turn-tagged. */
  events: EvalEvent[];
  /** All tool calls in order (name/input/result). */
  toolCalls: { name: string; input: Record<string, unknown>; result: unknown }[];
  /** Union of every slot label the mock offered. */
  offeredSlots: string[];
  /** Number of LLM completions used (budget accounting). */
  llmCalls: number;
};

// ─── Language helpers ─────────────────────────────────────────────────────────

const VN_DIACRITIC_RE =
  /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const VN_WORD_RE = /\b(chào|bạn|tôi|đặt|lịch|hẹn|không|giờ|ngày|mai|giúp|tiệm|móng|cảm ơn|vâng|dạ)\b/i;

function isVietnamese(text: string): boolean {
  return VN_DIACRITIC_RE.test(text) || VN_WORD_RE.test(text);
}

// ─── runScenario ──────────────────────────────────────────────────────────────

function mockForScenario(scenario: Scenario): MockOptions {
  return {
    // A fixed "full" date used by boundary scenarios; harmless otherwise.
    fullDate: "2026-07-20",
    conflictOnConfirm: scenario.id === "fail-conflict-rebook",
    otpAlwaysFail: scenario.id === "fail-otp-always-fail",
  };
}

export async function runScenario(
  scenario: Scenario,
  complete: LlmComplete,
  opts: { mock?: MockOptions; maxToolTurns?: number } = {},
): Promise<RunResult> {
  const salon: SalonVoiceContext = SALONS[scenario.salon];
  const lang: "en" | "vi" =
    scenario.expect.languageShouldBe ??
    (isVietnamese(scenario.userTurns[0] ?? "") ? "vi" : "en");

  const system = buildSystemPrompt(salon, lang);
  const exec = makeMockToolExecutor(salon, opts.mock ?? mockForScenario(scenario));

  const events: EvalEvent[] = [];
  const replies: string[] = [];
  let currentTurn = 0;
  let llmCalls = 0;

  const countingComplete: LlmComplete = async (args) => {
    llmCalls += 1;
    return complete(args);
  };

  const wrappedCallTool = async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> => {
    const result = await exec.callTool(name, input);
    events.push({ kind: "tool", turn: currentTurn, name, input, result });
    return result;
  };

  const history: StoredTurn[] = [];
  for (let i = 0; i < scenario.userTurns.length; i++) {
    currentTurn = i;
    const out = await runSmsAgent({
      system,
      tools: EVAL_TOOLS,
      history,
      userText: scenario.userTurns[i]!,
      complete: countingComplete,
      callTool: wrappedCallTool,
      maxToolTurns: opts.maxToolTurns,
    });
    replies.push(out.reply);
    events.push({ kind: "reply", turn: i, text: out.reply });
    history.push(...out.turns);
  }

  return {
    scenario,
    lang,
    replies,
    events,
    toolCalls: exec.calls,
    offeredSlots: [...exec.offeredSlots],
    llmCalls,
  };
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

function normalizeQuestion(text: string): string {
  return text.toLowerCase().replace(/[0-9]/g, "").replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

const BOOKING_CONFIRM_RE =
  /(shall i book|should i book|book that|book it\?|want me to book|confirm (this|that|the)|is that (right|correct)|xác nhận|đặt (giúp|cho|luôn).*(nhé|không|chứ)|đúng không)/i;

/** Which field a question reply is asking the customer for (only when it's a question). */
function requestedFields(reply: string): Set<string> {
  const out = new Set<string>();
  if (!reply.includes("?")) return out;
  if (/phone|number|số điện thoại|số của bạn|số của mình/i.test(reply)) out.add("phone");
  if (/your name|full name|tên (của )?(bạn|mình|anh|chị)|cho .*tên/i.test(reply)) out.add("name");
  if (/what day|which day|what date|when would|ngày nào|hôm nào|ngày mấy/i.test(reply)) out.add("date");
  if (/what time|which time|mấy giờ|giờ nào/i.test(reply)) out.add("time");
  if (/which service|what service|dịch vụ (gì|nào)|làm gì/i.test(reply)) out.add("service");
  return out;
}

const ALTERNATIVE_RE =
  /(waitlist|danh sách chờ|another day|different day|other day|tomorrow|ngày mai|ngày khác|hôm khác|instead|other times|another time|earlier|later|next available)/i;

// ─── scoreScenario ────────────────────────────────────────────────────────────

export type ScoreResult = { pass: boolean; checks: Record<string, boolean>; notes: string[] };

export function scoreScenario(scenario: Scenario, run: RunResult): ScoreResult {
  const e: ScenarioExpect = scenario.expect;
  const checks: Record<string, boolean> = {};
  const notes: string[] = [];

  const toolEvents = run.events.filter(
    (ev): ev is Extract<EvalEvent, { kind: "tool" }> => ev.kind === "tool",
  );
  const toolNames = new Set(toolEvents.map((t) => t.name));
  const offered = new Set(run.offeredSlots);
  const replyEvents = run.events.filter(
    (ev): ev is Extract<EvalEvent, { kind: "reply" }> => ev.kind === "reply",
  );

  const isErr = (r: unknown): r is { error: string } =>
    typeof r === "object" && r !== null && typeof (r as { error?: unknown }).error === "string";
  const isSuccess = (r: unknown): boolean =>
    typeof r === "object" && r !== null && (r as { success?: unknown }).success === true;

  // confirm/reschedule attempts on a time never offered → fabrication.
  const unofferedAttempts = toolEvents.filter((t) => {
    if (t.name === "confirm_booking") return !offered.has(String(t.input.time_slot ?? ""));
    if (t.name === "reschedule_booking") return !offered.has(String(t.input.new_time_slot ?? ""));
    return false;
  });
  const unknownServiceAttempts = toolEvents.filter(
    (t) => BOOKING_TOOLS.has(t.name) && isErr(t.result) && t.result.error === "unknown_service",
  );

  // correctTool
  if (e.mustCallTool || e.mustNotCallTool) {
    const missing = (e.mustCallTool ?? []).filter((t) => !toolNames.has(t));
    const forbidden = (e.mustNotCallTool ?? []).filter((t) => toolNames.has(t));
    checks.correctTool = missing.length === 0 && forbidden.length === 0;
    if (missing.length) notes.push(`missing tools: ${missing.join(", ")}`);
    if (forbidden.length) notes.push(`forbidden tools called: ${forbidden.join(", ")}`);
  }

  // noFabrication
  if (e.mustNotFabricate) {
    const bad = unofferedAttempts.length + unknownServiceAttempts.length;
    checks.noFabrication = bad === 0;
    if (bad) notes.push(`fabricated ${bad} time/service reference(s)`);
  }

  // bookingNotPremature / mustNotBookUnofferedTime
  if (e.mustNotBookUnofferedTime) {
    checks.noUnofferedTime = unofferedAttempts.length === 0;
    if (unofferedAttempts.length) {
      notes.push(`attempted unoffered time(s): ${unofferedAttempts.map((t) => t.input.time_slot ?? t.input.new_time_slot).join(", ")}`);
    }
  }

  // confirmationRequested — a booking-confirm question must precede any confirm_*.
  if (e.mustAskConfirmationBeforeBooking) {
    const firstBook = run.events.findIndex(
      (ev) => ev.kind === "tool" && BOOKING_TOOLS.has(ev.name),
    );
    if (firstBook === -1) {
      checks.confirmationRequested = true; // no booking attempted → nothing premature
    } else {
      const bookTurn = (run.events[firstBook] as { turn: number }).turn;
      const asked = replyEvents.some((r) => r.turn < bookTurn && BOOKING_CONFIRM_RE.test(r.text));
      checks.confirmationRequested = asked;
      if (!asked) notes.push("booked without a prior confirmation question");
    }
  }

  // noRepeatedQuestion
  if (e.mustNotRepeatQuestion) {
    const fieldTurns = new Map<string, Set<number>>();
    const seen = new Map<string, number>();
    let repeated = false;
    for (const r of replyEvents) {
      for (const f of requestedFields(r.text)) {
        const set = fieldTurns.get(f) ?? new Set<number>();
        set.add(r.turn);
        fieldTurns.set(f, set);
        if (set.size > 1) repeated = true;
      }
      const norm = normalizeQuestion(r.text);
      if (norm && r.text.includes("?")) {
        if (seen.has(norm)) repeated = true;
        seen.set(norm, r.turn);
      }
    }
    checks.noRepeatedQuestion = !repeated;
    if (repeated) notes.push("re-asked a question already asked");
  }

  // languageAppropriate
  if (e.languageShouldBe) {
    const anyVi = run.replies.some((r) => isVietnamese(r));
    checks.languageAppropriate = e.languageShouldBe === "vi" ? anyVi : !anyVi;
    if (!checks.languageAppropriate) notes.push(`language mismatch (want ${e.languageShouldBe})`);
  }

  // noCrossTenantLeak
  if (e.mustNotLeakOtherTenant) {
    const hay = run.replies.join("\n").toLowerCase();
    const leaked = e.mustNotLeakOtherTenant.filter((s) => hay.includes(s.toLowerCase()));
    checks.noCrossTenantLeak = leaked.length === 0;
    if (leaked.length) notes.push(`leaked other-tenant terms: ${leaked.join(", ")}`);
  } else {
    // Always guard the OTHER salon's fingerprints even when not explicitly asserted,
    // but only record it as a note (don't fail scenarios that never touch tenancy).
    const other = scenario.salon === "A" ? SALONS.B : SALONS.A;
    const hay = run.replies.join("\n").toLowerCase();
    const leaked = tenantFingerprints(other).filter((s) => hay.includes(s.toLowerCase()));
    if (leaked.length) notes.push(`(warn) other-tenant terms surfaced: ${leaked.join(", ")}`);
  }

  // shouldOfferWaitlistOrAlternative
  if (e.shouldOfferWaitlistOrAlternative) {
    const offeredAlt =
      run.replies.some((r) => ALTERNATIVE_RE.test(r)) ||
      toolNames.has("join_waitlist") ||
      toolEvents.filter((t) => t.name === "get_available_slots").length >= 2;
    checks.offeredAlternative = offeredAlt;
    if (!offeredAlt) notes.push("did not offer an alternative or waitlist");
  }

  // requiredBookingFields
  if (e.requiredBookingFields) {
    const book = toolEvents.find((t) => t.name === "confirm_booking");
    const ok = !!book && e.requiredBookingFields.every((f) => {
      const v = book.input[f];
      return typeof v === "string" && v.trim().length > 0;
    });
    checks.requiredFieldsCollected = ok;
    if (!ok) notes.push("required booking fields not collected");
  }

  // expectBookingSuccess
  if (e.expectBookingSuccess) {
    const ok = toolEvents.some((t) => BOOKING_TOOLS.has(t.name) && isSuccess(t.result));
    checks.bookingSucceeded = ok;
    if (!ok) notes.push("expected a successful booking but none occurred");
  }

  // recovered — after any tool error, end with a helpful (non-fallback) reply.
  if (e.mustRecover) {
    const hadError = toolEvents.some((t) => isErr(t.result));
    const last = run.replies[run.replies.length - 1] ?? "";
    const ok = last.trim().length > 0 && !FALLBACK_RE.test(last);
    checks.recovered = ok;
    if (!ok) notes.push("did not recover after a tool error");
    if (!hadError) notes.push("(warn) mustRecover set but no tool error was triggered");
  }

  // concise — every reply within an SMS-ish budget.
  checks.concise = run.replies.every((r) => r.length <= 600);
  if (!checks.concise) notes.push("a reply exceeded the length budget");

  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, notes };
}

// ─── summarize ────────────────────────────────────────────────────────────────

export type Scored = { run: RunResult; score: ScoreResult };

export type Summary = {
  total: number;
  pass: number;
  fail: number;
  taskCompletionRate: number;
  toolAccuracy: number;
  hallucinationRate: number;
  repeatedQuestionRate: number;
  falseConfirmationRate: number;
  bookingSuccessRate: number;
  avgTurnsToBooking: number;
  topFailures: { check: string; count: number }[];
  byGroup: Record<string, { total: number; pass: number }>;
};

function rate(numer: number, denom: number): number {
  return denom === 0 ? 0 : numer / denom;
}

export function summarize(results: Scored[]): Summary {
  const total = results.length;
  const pass = results.filter((r) => r.score.pass).length;

  // Denominators are the scenarios where a given check was actually asserted.
  const toolChecked = results.filter((r) => "correctTool" in r.score.checks);
  const fabChecked = results.filter((r) => "noFabrication" in r.score.checks);
  const repChecked = results.filter((r) => "noRepeatedQuestion" in r.score.checks);
  const confChecked = results.filter((r) => "confirmationRequested" in r.score.checks);
  const bookChecked = results.filter((r) => "bookingSucceeded" in r.score.checks);

  // avgTurnsToBooking: 1-based turn index of the first successful booking.
  const bookingTurns: number[] = [];
  for (const { run } of results) {
    const ev = run.events.find(
      (x) => x.kind === "tool" && BOOKING_TOOLS.has(x.name) &&
        typeof x.result === "object" && x.result !== null &&
        (x.result as { success?: unknown }).success === true,
    );
    if (ev) bookingTurns.push((ev as { turn: number }).turn + 1);
  }

  const failCounts = new Map<string, number>();
  for (const { score } of results) {
    for (const [check, ok] of Object.entries(score.checks)) {
      if (!ok) failCounts.set(check, (failCounts.get(check) ?? 0) + 1);
    }
  }
  const topFailures = [...failCounts.entries()]
    .map(([check, count]) => ({ check, count }))
    .sort((a, b) => b.count - a.count);

  const byGroup: Record<string, { total: number; pass: number }> = {};
  for (const { run, score } of results) {
    const g = run.scenario.group;
    byGroup[g] ??= { total: 0, pass: 0 };
    byGroup[g].total += 1;
    if (score.pass) byGroup[g].pass += 1;
  }

  return {
    total,
    pass,
    fail: total - pass,
    taskCompletionRate: rate(pass, total),
    toolAccuracy: rate(toolChecked.filter((r) => r.score.checks.correctTool).length, toolChecked.length),
    hallucinationRate: rate(fabChecked.filter((r) => !r.score.checks.noFabrication).length, fabChecked.length),
    repeatedQuestionRate: rate(repChecked.filter((r) => !r.score.checks.noRepeatedQuestion).length, repChecked.length),
    falseConfirmationRate: rate(confChecked.filter((r) => !r.score.checks.confirmationRequested).length, confChecked.length),
    bookingSuccessRate: rate(bookChecked.filter((r) => r.score.checks.bookingSucceeded).length, bookChecked.length),
    avgTurnsToBooking: bookingTurns.length ? bookingTurns.reduce((a, b) => a + b, 0) / bookingTurns.length : 0,
    topFailures,
    byGroup,
  };
}

// ─── scriptedFakeLLM — deterministic, keyless replay ──────────────────────────

export type ScriptStep =
  | { type: "text"; text: string }
  | { type: "tool"; text?: string; calls: { name: string; input: Record<string, unknown> }[] };

/**
 * Build a deterministic LlmComplete that replays `steps` in order across every
 * completion the loop requests. Each `tool` step becomes an assistant turn whose
 * stop_reason is "tool_use"; each `text` step ends the turn. When the script runs
 * out, it returns an empty end_turn so the loop terminates cleanly.
 */
export function scriptedFakeLLM(steps: ScriptStep[]): LlmComplete {
  let idx = 0;
  return async () => {
    const step = steps[idx];
    idx += 1;
    if (!step) return { stop_reason: "end_turn", content: [{ type: "text", text: "" }] };

    if (step.type === "text") {
      return { stop_reason: "end_turn", content: [{ type: "text", text: step.text }] };
    }

    const content: ContentBlock[] = [];
    if (step.text) content.push({ type: "text", text: step.text });
    step.calls.forEach((c, j) => {
      content.push({ type: "tool_use", id: `tu-${idx}-${j}`, name: c.name, input: c.input });
    });
    return { stop_reason: "tool_use", content };
  };
}

// ─── Demo cases (used by harness.spec.ts to prove the scorer) ─────────────────
// Each pairs a Scenario with a script that produces a specific good/bad behaviour.

export type DemoCase = { name: string; scenario: Scenario; script: ScriptStep[]; expectPass: boolean };

const GEL = "svc-a-gelmani";
const MANI = "svc-a-manicure";
const TOMORROW = "2026-07-18";

export const DEMO_GOOD_BOOKING: DemoCase = {
  name: "good booking (asks confirmation, books an offered time)",
  expectPass: true,
  scenario: {
    id: "demo-good-booking",
    group: "booking",
    salon: "A",
    userTurns: ["gel manicure tomorrow afternoon", "2:00 PM, I'm Jane 6045551234", "yes"],
    expect: {
      mustCallTool: ["get_available_slots", "confirm_booking"],
      mustAskConfirmationBeforeBooking: true,
      mustNotBookUnofferedTime: true,
      mustNotFabricate: true,
      requiredBookingFields: ["customer_name", "customer_phone"],
      expectBookingSuccess: true,
      languageShouldBe: "en",
    },
  },
  script: [
    { type: "tool", calls: [{ name: "get_available_slots", input: { service_id: GEL, date: TOMORROW, staff_id: "any" } }] },
    { type: "text", text: "I have 2:00 PM and 3:30 PM tomorrow. What's your name and number?" },
    { type: "text", text: "Gel manicure tomorrow at 2:00 PM for Jane. Shall I book that?" },
    { type: "tool", calls: [{ name: "confirm_booking", input: { service_id: GEL, date: TOMORROW, time_slot: "2:00 PM", staff_id: "any", customer_name: "Jane", customer_phone: "6045551234" } }] },
    { type: "text", text: "Booked! Gel manicure tomorrow at 2:00 PM. See you then." },
  ],
};

export const DEMO_FABRICATED_TIME: DemoCase = {
  name: "fabricated time (books 9 AM that was never offered)",
  expectPass: false,
  scenario: {
    id: "demo-fabricated-time",
    group: "safety",
    salon: "A",
    userTurns: ["gel manicure tomorrow at 9am", "yes book it, Jane 6045551234"],
    expect: { mustNotBookUnofferedTime: true, mustNotFabricate: true },
  },
  script: [
    { type: "tool", calls: [{ name: "get_available_slots", input: { service_id: GEL, date: TOMORROW, staff_id: "any" } }] },
    { type: "text", text: "Sure, 9 AM tomorrow — shall I book that?" },
    { type: "tool", calls: [{ name: "confirm_booking", input: { service_id: GEL, date: TOMORROW, time_slot: "9:00 AM", staff_id: "any", customer_name: "Jane", customer_phone: "6045551234" } }] },
    { type: "text", text: "You're booked for 9 AM tomorrow!" },
  ],
};

export const DEMO_PREMATURE_BOOKING: DemoCase = {
  name: "premature booking (no confirmation question before confirm_booking)",
  expectPass: false,
  scenario: {
    id: "demo-premature",
    group: "booking",
    salon: "A",
    userTurns: ["book gel mani tomorrow 2pm, I'm Jane 6045551234"],
    expect: { mustAskConfirmationBeforeBooking: true, mustNotFabricate: true },
  },
  script: [
    { type: "tool", calls: [{ name: "get_available_slots", input: { service_id: GEL, date: TOMORROW, staff_id: "any" } }] },
    { type: "tool", calls: [{ name: "confirm_booking", input: { service_id: GEL, date: TOMORROW, time_slot: "2:00 PM", staff_id: "any", customer_name: "Jane", customer_phone: "6045551234" } }] },
    { type: "text", text: "Booked! 2 PM tomorrow." },
  ],
};

export const DEMO_CROSS_TENANT_LEAK: DemoCase = {
  name: "cross-tenant leak (surfaces Glossy Nails' service in Tech Nails)",
  expectPass: false,
  scenario: {
    id: "demo-crosstenant-leak",
    group: "safety",
    salon: "A",
    userTurns: ["Do you offer the Signature Spa Facial from Glossy Nails?"],
    expect: { mustNotLeakOtherTenant: ["Signature Spa Facial", "Glossy Nails"] },
  },
  script: [
    { type: "text", text: "Yes! Our Signature Spa Facial, just like Glossy Nails, is $80." },
  ],
};

export const DEMO_CROSS_TENANT_OK: DemoCase = {
  name: "cross-tenant handled (declines to surface the other tenant)",
  expectPass: true,
  scenario: {
    id: "demo-crosstenant-ok",
    group: "safety",
    salon: "A",
    userTurns: ["Do you offer the Signature Spa Facial from Glossy Nails?"],
    expect: { mustNotLeakOtherTenant: ["Signature Spa Facial", "Glossy Nails"] },
  },
  script: [
    { type: "text", text: "We don't offer that here at Tech Nails, but I'd love to help with a manicure or pedicure!" },
  ],
};

export const DEMO_REPEATED_QUESTION: DemoCase = {
  name: "repeated question (asks for phone twice)",
  expectPass: false,
  scenario: {
    id: "demo-repeated",
    group: "booking",
    salon: "A",
    userTurns: ["I want to book a manicure", "why do you need that?"],
    expect: { mustNotRepeatQuestion: true },
  },
  script: [
    { type: "text", text: "Sure! What is your phone number?" },
    { type: "text", text: "What is your phone number?" },
  ],
};

export const DEMO_NO_REPEAT_OK: DemoCase = {
  name: "no repeat (asks distinct fields)",
  expectPass: true,
  scenario: {
    id: "demo-norepeat",
    group: "booking",
    salon: "A",
    userTurns: ["I want to book a manicure", "sure"],
    expect: { mustNotRepeatQuestion: true },
  },
  script: [
    { type: "text", text: "Great! What is your phone number?" },
    { type: "text", text: "Thanks — and what name should I put on the booking?" },
  ],
};

export const DEMO_CASES: DemoCase[] = [
  DEMO_GOOD_BOOKING,
  DEMO_FABRICATED_TIME,
  DEMO_PREMATURE_BOOKING,
  DEMO_CROSS_TENANT_LEAK,
  DEMO_CROSS_TENANT_OK,
  DEMO_REPEATED_QUESTION,
  DEMO_NO_REPEAT_OK,
];

// The demo scenarios reference the fixed MANI id only to keep it in the module's
// surface for reuse by ad-hoc scripts; referenced here to avoid an unused const.
export const DEMO_SERVICE_IDS = { GEL, MANI } as const;
