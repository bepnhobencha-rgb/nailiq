/**
 * Pure-logic test for computeLatenessTier (no DB / no React).
 * Run: npx tsx scripts/test-lateness.ts
 *
 * Exhaustively covers the tier boundaries for both modes:
 *   - auto ON  (T>0): due < T/3 ≤ late < T-5 ≤ critical ; autoAtIso = start+T
 *   - auto OFF (null/0): due < 10 ≤ late < 20 ≤ critical ; autoAtIso = null
 * plus the exclusions (future / in_progress / completed / NaN).
 */
import { computeLatenessTier, type LatenessTier } from "../src/components/receptionist/lateness";

const NOW = "2026-06-14T20:00:00.000Z";
const nowMs = Date.parse(NOW);
/** ISO string for a booking that started `min` minutes before NOW (negative = future). */
const startAgo = (min: number) => new Date(nowMs - min * 60_000).toISOString();

let pass = 0;
let fail = 0;
const fails: string[] = [];

function check(
  label: string,
  got: { tier: LatenessTier; autoAtIso: string | null },
  wantTier: LatenessTier,
  wantAuto?: string | null,
) {
  const tierOk = got.tier === wantTier;
  const autoOk = wantAuto === undefined ? true : got.autoAtIso === wantAuto;
  if (tierOk && autoOk) {
    pass += 1;
  } else {
    fail += 1;
    fails.push(
      `✗ ${label}: got tier=${got.tier} auto=${got.autoAtIso} — want tier=${wantTier}${wantAuto !== undefined ? ` auto=${wantAuto}` : ""}`,
    );
  }
}

const C = (args: {
  status?: string;
  minLate: number;
  autoNoShowMinutes: number | null;
}) =>
  computeLatenessTier({
    status: args.status ?? "confirmed",
    startTimeUtc: startAgo(args.minLate),
    nowIso: NOW,
    autoNoShowMinutes: args.autoNoShowMinutes,
  });

// ── auto OFF (null) → fixed 10/20 milestones ──────────────────────────────
check("off: 0 late → due", C({ minLate: 0, autoNoShowMinutes: null }), "due", null);
check("off: 9 late → due", C({ minLate: 9, autoNoShowMinutes: null }), "due", null);
check("off: 10 late → late (boundary)", C({ minLate: 10, autoNoShowMinutes: null }), "late", null);
check("off: 19 late → late", C({ minLate: 19, autoNoShowMinutes: null }), "late", null);
check("off: 20 late → critical (boundary)", C({ minLate: 20, autoNoShowMinutes: null }), "critical", null);
check("off: 45 late → critical", C({ minLate: 45, autoNoShowMinutes: null }), "critical", null);
check("off: 0 via autoNoShowMinutes=0 → fixed/due", C({ minLate: 12, autoNoShowMinutes: 0 }), "late", null);

// ── auto ON (T=30) → due<10, late 10..25, critical≥25 ; autoAtIso=start+30 ──
const autoAt = (min: number) => new Date(nowMs - min * 60_000 + 30 * 60_000).toISOString();
check("on30: 5 late → due", C({ minLate: 5, autoNoShowMinutes: 30 }), "due", autoAt(5));
check("on30: 9 late → due", C({ minLate: 9, autoNoShowMinutes: 30 }), "due", autoAt(9));
check("on30: 10 late → late (T/3 boundary)", C({ minLate: 10, autoNoShowMinutes: 30 }), "late", autoAt(10));
check("on30: 24 late → late", C({ minLate: 24, autoNoShowMinutes: 30 }), "late", autoAt(24));
check("on30: 25 late → critical (T-5 boundary)", C({ minLate: 25, autoNoShowMinutes: 30 }), "critical", autoAt(25));
check("on30: 35 late → critical", C({ minLate: 35, autoNoShowMinutes: 30 }), "critical", autoAt(35));

// ── auto ON (T=15, the Hi-Lite value) ─────────────────────────────────────
check("on15: 2 late → due", C({ minLate: 2, autoNoShowMinutes: 15 }), "due");
check("on15: 7 late → late", C({ minLate: 7, autoNoShowMinutes: 15 }), "late");
check("on15: 12 late → critical", C({ minLate: 12, autoNoShowMinutes: 15 }), "critical");

// ── exclusions ────────────────────────────────────────────────────────────
check("future booking → null", C({ minLate: -10, autoNoShowMinutes: 15 }), null, null);
check("in_progress → null", C({ status: "in_progress", minLate: 30, autoNoShowMinutes: 15 }), null, null);
check("completed → null", C({ status: "completed", minLate: 30, autoNoShowMinutes: 15 }), null, null);
check("cancelled → null", C({ status: "cancelled", minLate: 30, autoNoShowMinutes: 15 }), null, null);
check("no_show → null", C({ status: "no_show", minLate: 30, autoNoShowMinutes: 15 }), null, null);
check("pending also escalates → late", C({ status: "pending", minLate: 12, autoNoShowMinutes: null }), "late", null);
check(
  "NaN start → null",
  computeLatenessTier({ status: "confirmed", startTimeUtc: "not-a-date", nowIso: NOW, autoNoShowMinutes: 15 }),
  null,
  null,
);

console.log(fails.join("\n"));
console.log(`\nlateness logic: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
