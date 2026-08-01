import { describe, expect, it } from "vitest";

import {
  elapsedSessionSeconds,
  normalizeVoiceSessionSeconds,
} from "@/shared/voiceai/sessionDuration";

// The exact production row: Hi-Lite Studio, status 'abandoned', 2026-07-30.
// duration_seconds was 1785380740 and to_timestamp() of it reproduced ended_at.
const ABANDON_BEFORE_CONNECT_NOW = 1785380740_080;

describe("elapsedSessionSeconds", () => {
  it("reports 0 when the session was abandoned before it ever connected", () => {
    // startTsRef is still at its useRef(0) initial value here. The old
    // expression Math.round((Date.now() - 0) / 1000) produced 1785380740 —
    // about 56 years — and the owner's feed rendered "29756345p40s".
    expect(elapsedSessionSeconds(0, ABANDON_BEFORE_CONNECT_NOW)).toBe(0);
    expect(Math.round((ABANDON_BEFORE_CONNECT_NOW - 0) / 1000)).toBe(
      1785380740,
    );
  });

  it("measures a real session normally", () => {
    const start = 1785380000_000;
    expect(elapsedSessionSeconds(start, start + 134_000)).toBe(134);
  });

  it("rounds to the nearest second", () => {
    const start = 1785380000_000;
    expect(elapsedSessionSeconds(start, start + 1_400)).toBe(1);
    expect(elapsedSessionSeconds(start, start + 1_600)).toBe(2);
  });

  it("never reports a negative duration if the clock moves backwards", () => {
    const start = 1785380000_000;
    expect(elapsedSessionSeconds(start, start - 5_000)).toBe(0);
    expect(elapsedSessionSeconds(start, start)).toBe(0);
  });

  it("rejects non-finite or nonsensical inputs rather than writing them through", () => {
    expect(elapsedSessionSeconds(Number.NaN, Date.now())).toBe(0);
    expect(elapsedSessionSeconds(Number.POSITIVE_INFINITY, Date.now())).toBe(0);
    expect(elapsedSessionSeconds(1785380000_000, Number.NaN)).toBe(0);
    expect(elapsedSessionSeconds(-1, Date.now())).toBe(0);
  });

  it("keeps a long but plausible call intact", () => {
    const start = 1785380000_000;
    // 586s — the longest real elapsed time among the six corrupted rows.
    expect(elapsedSessionSeconds(start, start + 586_000)).toBe(586);
  });

  it("clamps browser elapsed time to the realtime session lifetime", () => {
    const start = 1785380000_000;
    expect(elapsedSessionSeconds(start, start + 31 * 60_000)).toBe(1800);
  });
});

describe("normalizeVoiceSessionSeconds", () => {
  it("accepts and rounds a valid report", () => {
    expect(normalizeVoiceSessionSeconds(134.4)).toBe(134);
    expect(normalizeVoiceSessionSeconds(134.6)).toBe(135);
  });

  it("refuses invalid client input", () => {
    expect(normalizeVoiceSessionSeconds(undefined)).toBe(0);
    expect(normalizeVoiceSessionSeconds("90")).toBe(0);
    expect(normalizeVoiceSessionSeconds(Number.NaN)).toBe(0);
    expect(normalizeVoiceSessionSeconds(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeVoiceSessionSeconds(-1)).toBe(0);
  });

  it("clamps an epoch-sized or otherwise excessive report", () => {
    expect(normalizeVoiceSessionSeconds(1785380740)).toBe(1800);
    expect(normalizeVoiceSessionSeconds(1801)).toBe(1800);
  });
});
