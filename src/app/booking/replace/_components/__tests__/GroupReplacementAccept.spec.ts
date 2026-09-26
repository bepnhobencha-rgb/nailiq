import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/shared/booking/groupSlotRecoveryActions", () => ({
  acceptGroupReplacement: vi.fn(),
}));

import GroupReplacementAccept from "../GroupReplacementAccept";
import { groupRecoveryError, groupRecoveryMessages } from "@/shared/i18n/booking/groupRecovery";

describe.each(["en", "vi"] as const)("replacement preview errors (%s)", (language) => {
  const t = groupRecoveryMessages(language);

  it("missing or malformed capability explains the link, not a phone field", () => {
    for (const token of ["", "not-a-capability"]) {
      const html = renderToStaticMarkup(
        createElement(GroupReplacementAccept, { token, language, preview: { ok: false, code: "invalid_input" } }),
      );
      expect(html).toContain(t.unavailable);
      expect(html).not.toContain(t.invalidPhone);
      expect(html).not.toContain("<form");
    }
  });

  it("expired capability retains the specific expiry explanation", () => {
    const html = renderToStaticMarkup(
      createElement(GroupReplacementAccept, { token: "a".repeat(64), language, preview: { ok: false, code: "request_expired" } }),
    );
    expect(html).toContain(t.expired);
    expect(html).not.toContain(t.invalidPhone);
  });

  it("acceptance validation still asks for corrected form input", () => {
    expect(groupRecoveryError("invalid_input", language)).toBe(t.invalidPhone);
    expect(groupRecoveryError("different_guest_required", language)).toBe(t.differentGuest);
  });
});
