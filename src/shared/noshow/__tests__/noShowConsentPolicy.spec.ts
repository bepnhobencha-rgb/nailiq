import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { evaluatePolicyReadiness } from "@/shared/lib/cancellationPolicy";
import {
  buildNoShowConsentPolicy,
  consentMetaMatchesPolicy,
} from "@/shared/noshow/noShowConsentPolicy";

const policy = {
  en: "Cancel at least 24 hours before the appointment. A missed visit may incur the disclosed fee.",
  vi: "Vui lòng huỷ trước giờ hẹn ít nhất 24 giờ. Lịch vắng có thể chịu mức phí đã công bố.",
};

describe("no-show consent policy", () => {
  it("rejects defaults, missing translations, and unresolved placeholders", () => {
    expect(evaluatePolicyReadiness(null).ready).toBe(false);
    expect(evaluatePolicyReadiness({ en: policy.en }).reasons).toContain("missing_vietnamese");
    expect(evaluatePolicyReadiness({ ...policy, vi: `${policy.vi} [X%]` }).reasons)
      .toContain("vietnamese_placeholder");
  });

  it("versions exact terms, amount, currency, and group scope", () => {
    const member = buildNoShowConsentPolicy({
      storedPolicy: policy,
      salonName: "Salon",
      feeCents: 2_000,
      currency: "cad",
      scope: "booking_member",
    });
    const group = buildNoShowConsentPolicy({
      storedPolicy: policy,
      salonName: "Salon",
      feeCents: 2_000,
      currency: "CAD",
      scope: "whole_party",
    });
    expect(member.ready).toBe(true);
    expect(member.version).toMatch(/^nsp_[0-9a-f]{64}$/);
    expect(group.version).not.toBe(member.version);
    expect(consentMetaMatchesPolicy({
      policyVersion: member.version,
      feeCents: 2_000,
      currency: "CAD",
      scope: "booking_member",
    }, member)).toBe(true);
    expect(consentMetaMatchesPolicy({
      policyVersion: member.version,
      feeCents: 2_500,
      currency: "CAD",
      scope: "booking_member",
    }, member)).toBe(false);
  });
});
