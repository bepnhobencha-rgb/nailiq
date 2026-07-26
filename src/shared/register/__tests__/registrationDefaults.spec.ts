import { describe, expect, it } from "vitest";

import { PLAN_LIMITS } from "@/shared/lib/subscriptionPlans";
import { buildRegistrationDefaultServices } from "../registrationDefaults";

describe("buildRegistrationDefaultServices", () => {
  it("never seeds more services than the Free plan permits", () => {
    const services = buildRegistrationDefaultServices("salon-1");

    expect(services).toHaveLength(PLAN_LIMITS.free.maxServices);
    expect(services.every((service) => service.salon_id === "salon-1")).toBe(
      true,
    );
  });
});
