import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const route = fs.readFileSync(
  path.join(root, "src/app/api/voice/session/route.ts"),
  "utf8",
);
const modal = fs.readFileSync(
  path.join(root, "src/components/booking/VoiceBookingModal.tsx"),
  "utf8",
);
const phoneConfig = fs.readFileSync(
  path.join(root, "src/app/api/voice/phone-config/route.ts"),
  "utf8",
);
const twilioVoice = fs.readFileSync(
  path.join(root, "src/app/api/twilio/voice/route.ts"),
  "utf8",
);
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260801132953_release_voice_session_reservation.sql"),
  "utf8",
);
const parity = fs.readFileSync(
  path.join(root, "scripts/check-schema-parity.ts"),
  "utf8",
);

describe("Voice session quota and renewal boundary", () => {
  it("reserves quota atomically before minting an OpenAI secret", () => {
    const reserve = route.indexOf('"increment_voice_session_if_under_limit"');
    const mint = route.indexOf("fetch(OPENAI_CLIENT_SECRETS_URL");
    expect(reserve).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(reserve);
    expect(route).toContain("if (reserved !== true)");
    expect(route).toContain('error: "session_limit_reached"');
  });

  it("rolls back failed initial mints but never charges a renewal", () => {
    expect(route).toContain('"release_voice_session_reservation"');
    expect(route).toContain("if (!quotaReserved) return");
    expect(route).toContain("if (!renewal)");
    expect(migration).toContain("voice_ai_sessions_this_month - 1");
    expect(migration).toMatch(
      /revoke all on function public\.release_voice_session_reservation\(uuid\)[\s\S]*from public, anon, authenticated/i,
    );
    expect(parity).toContain("functions: 422");
    expect(parity).toContain('"release_voice_session_reservation"');
  });

  it("requires the existing capability for renewal and reuses its row", () => {
    expect(route).toContain("verifyVoiceSessionCapability(existingSessionId");
    expect(route).toContain("sessionRow = { id: existingSessionId! }");
    expect(modal).toContain("renewal: true");
    expect(modal).toContain("sessionCapability: sessionCapabilityRef.current");
  });

  it("rate-limits initial mint by IP and salon and renewals by session", () => {
    expect(route).toContain("voice-session:ip:");
    expect(route).toContain("voice-session:salon:");
    expect(route).toContain("voice-renew:");
    expect(route).toContain('error: "rate_limit_unavailable"');
  });

  it("meters phone calls atomically and releases orphaned reservations", () => {
    const reserve = phoneConfig.indexOf('"increment_voice_session_if_under_limit"');
    const insert = phoneConfig.indexOf('.from("voice_ai_sessions")', reserve);
    const release = phoneConfig.indexOf('"release_voice_session_reservation"', insert);
    expect(reserve).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(reserve);
    expect(release).toBeGreaterThan(insert);
    expect(phoneConfig).toContain('error: "session_limit_reached"');
    expect(phoneConfig).toContain('error: "session_record_failed"');
    expect(phoneConfig).not.toContain("Best-effort: a");
  });

  it("gives an unavailable TwiML response before bridging an exhausted salon", () => {
    expect(twilioVoice).toContain("voice_ai_sessions_this_month");
    expect(twilioVoice).toContain("voice_ai_sessions_limit");
    expect(twilioVoice).toMatch(
      /voice_ai_sessions_this_month\s*>=\s*quota\.voice_ai_sessions_limit[\s\S]{0,100}twimlResponse\(sayUnavailable\)/,
    );
  });
});
