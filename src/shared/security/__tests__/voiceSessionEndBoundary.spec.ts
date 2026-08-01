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
  });
});
