import { describe, expect, it } from "vitest";

import { eligibleVoiceAnyStaff } from "@/shared/voiceai/voiceAnyStaff";

const active = [
  { id: "staff-incapable", name: "First" },
  { id: "staff-capable", name: "Second" },
];

describe("Phone Voice Any-staff capability selection", () => {
  it("skips an incapable first staff and keeps the capable second staff", () => {
    expect(eligibleVoiceAnyStaff(active, [
      { staff_id: "staff-capable", service_id: "service-a" },
    ], "service-a")).toEqual([
      { id: "staff-capable", name: "Second" },
    ]);
  });

  it("uses legacy all-active fallback only when no valid active-staff mapping exists", () => {
    expect(eligibleVoiceAnyStaff(active, [], "service-a")).toEqual(active);
    expect(eligibleVoiceAnyStaff(active, [
      { staff_id: "inactive-staff", service_id: "service-a" },
    ], "service-a")).toEqual(active);
  });

  it("treats any valid mapping as a strict whitelist for the requested service", () => {
    expect(eligibleVoiceAnyStaff(active, [
      { staff_id: "staff-capable", service_id: "different-service" },
    ], "service-a")).toEqual([]);
  });
});
