import { describe, expect, it } from "vitest";

import { classifyInboundSmsCommand } from "../inboundSmsCommand";

describe("inbound SMS command boundary", () => {
  it("prioritizes provider OptOutType and never treats it as a booking command", () => {
    expect(classifyInboundSmsCommand("YES", "STOP")).toBe("consent_stop");
    expect(classifyInboundSmsCommand("CANCEL", "START")).toBe("consent_start");
    expect(classifyInboundSmsCommand("NO", "HELP")).toBe("consent_help");
    expect(classifyInboundSmsCommand("YES", "unexpected")).toBe("unknown");
  });

  it("tracks exact standard STOP/START words when OptOutType is unavailable", () => {
    for (const word of ["STOP", "StopAll", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]) {
      expect(classifyInboundSmsCommand(word)).toBe("consent_stop");
    }
    expect(classifyInboundSmsCommand("START")).toBe("consent_start");
    expect(classifyInboundSmsCommand("UNSTOP")).toBe("consent_start");
    expect(classifyInboundSmsCommand("STOP please")).toBe("unknown");
  });

  it("keeps booking commands distinct from carrier consent commands", () => {
    expect(classifyInboundSmsCommand("YES")).toBe("booking_confirm");
    expect(classifyInboundSmsCommand("yes please")).toBe("booking_confirm");
    expect(classifyInboundSmsCommand("NO")).toBe("booking_cancel");
    expect(classifyInboundSmsCommand("Hủy")).toBe("booking_cancel");
    expect(classifyInboundSmsCommand("CANCEL")).toBe("consent_stop");
  });
});
