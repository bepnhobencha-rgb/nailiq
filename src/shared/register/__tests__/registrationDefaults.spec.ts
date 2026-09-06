import { describe, expect, it } from "vitest";

import { PLAN_LIMITS } from "@/shared/lib/subscriptionPlans";
import {
  buildRegistrationDefaultServices,
  REGISTRATION_SAFE_SALON_DEFAULTS,
} from "../registrationDefaults";

describe("buildRegistrationDefaultServices", () => {
  it("never seeds more services than the Free plan permits", () => {
    const services = buildRegistrationDefaultServices("salon-1");

    expect(services).toHaveLength(PLAN_LIMITS.free.maxServices);
    expect(services.every((service) => service.salon_id === "salon-1")).toBe(
      true,
    );
  });
});

describe("REGISTRATION_SAFE_SALON_DEFAULTS", () => {
  it("keeps a new workspace private and provider-free until Owner approval", () => {
    expect(REGISTRATION_SAFE_SALON_DEFAULTS).toEqual({
      profile_complete: false,
      sms_outbound_enabled: false,
      email_outbound_enabled: false,
      email_links_enabled: false,
      reminders_enabled: false,
      reminder_24h_enabled: false,
      reminder_3h_enabled: false,
      sms_reminders_enabled: false,
      voice_ai_enabled: false,
      noshow_protection_enabled: false,
      winback_enabled: false,
      payment_provider: null,
    });
  });
});
