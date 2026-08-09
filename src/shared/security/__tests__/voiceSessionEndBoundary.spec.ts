import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("Voice session end authorization boundary", () => {
  it("requires either the trusted bridge or a session-bound capability", () => {
    const route = source("src/app/api/voice/session/end/route.ts");

    expect(route).toContain('req.headers.get("x-voice-bridge-secret")');
    expect(route).toContain('req.headers.get("x-voice-session-token")');
    expect(route).toContain(
      "!fromBridge && !verifyVoiceSessionCapability(sessionId, browserCapability)",
    );
    expect(route).toMatch(/error: "unauthorized"[\s\S]{0,40}status: 401/);
  });

  it("mints the capability server-side and threads it through the browser", () => {
    const mintRoute = source("src/app/api/voice/session/route.ts");
    const modal = source("src/components/booking/VoiceBookingModal.tsx");

    expect(mintRoute).toContain("createVoiceSessionCapability(sessionRow.id)");
    expect(mintRoute).toContain("sessionCapability,");
    expect(modal).toContain('"x-voice-session-token": sessionCapabilityRef.current');
    expect(modal).toContain("keepalive,");
    expect(modal).toContain('endSessionRef.current("abandoned", true)');
  });

  it("prices bounded Realtime usage on the server for both transports", () => {
    const route = source("src/app/api/voice/session/end/route.ts");
    const browser = source("src/components/booking/VoiceBookingModal.tsx");
    const bridge = source("services/voice-bridge/src/server.ts");
    const usage = source("src/shared/voiceai/realtimeUsage.ts");
    const migration = source(
      "supabase/migrations/20260801150439_add_voice_realtime_usage_telemetry.sql",
    );

    expect(route).toContain("normalizeRealtimeUsage(realtimeUsage)");
    expect(route).toContain("estimateRealtimeCostUsd(");
    expect(route).not.toMatch(/estimatedCostUsd\s*[:=]\s*body/);
    expect(browser).toContain("realtimeUsage:   realtimeUsageRef.current");
    expect(bridge).toContain("realtimeUsage,");
    expect(usage).toContain('"gpt-realtime-2.1"');
    expect(usage).toContain('asOf: "2026-08-01"');
    expect(migration).toContain("add column if not exists realtime_usage jsonb");
    expect(migration).toContain("numeric(12, 6)");
  });

  it("persists only allowlisted client failures and closes browser errors immediately", () => {
    const route = source("src/app/api/voice/session/end/route.ts");
    const mintRoute = source("src/app/api/voice/session/route.ts");
    const browser = source("src/components/booking/VoiceBookingModal.tsx");
    const diagnostics = source("src/shared/voiceai/clientDiagnostics.ts");

    expect(route).toContain("normalizeVoiceFailureCode(failureCode)");
    expect(route).toContain("normalizeVoiceClientDiagnostics(clientDiagnostics)");
    expect(route).toContain("error_message: normalizedFailureCode");
    expect(route).toContain("clientDiagnostics: normalizedClientDiagnostics");
    expect(mintRoute).toContain("normalizeVoiceSessionChannel(channel)");
    expect(mintRoute).toContain('type: "session_start"');
    expect(browser).toContain('endSessionRef.current("failed", false, "ws_connect_failed")');
    expect(browser).toContain('endSessionRef.current("failed", false, "realtime_error")');
    expect(browser).toContain("sessionFinalizedRef.current");
    expect(diagnostics).not.toContain("deviceId:");
    expect(diagnostics).not.toContain("userAgent:");
  });
});
