import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  V1_INTEGRATION_SCOPE,
  v1AllowsWixCalendarConnection,
} from "../v1IntegrationScope";

describe("NailIQ V1 integration scope", () => {
  it("keeps money provider-owned and moves external sync to Phase 2", () => {
    expect(V1_INTEGRATION_SCOPE).toEqual({
      paymentGatewayIntegration: "phase_2_provider_terminal",
      googleCalendarSync: "phase_2",
      outlookCalendarSync: "phase_2",
      wixCalendarSync: "legacy_existing_only",
      squareLoyaltySync: "phase_2_provider_owned",
      squareGiftCardSync: "phase_2_provider_owned",
    });
  });

  it("blocks new Wix connections while preserving existing live compatibility", () => {
    expect(v1AllowsWixCalendarConnection(false)).toBe(false);
    expect(v1AllowsWixCalendarConnection(true)).toBe(true);
  });

  it("places the V1 guard before Wix provider tests and credential upserts", () => {
    const actions = readFileSync(
      resolve(
        process.cwd(),
        "src/shared/integrations/wix/admin/adminActions.ts",
      ),
      "utf8",
    );
    const settings = readFileSync(
      resolve(process.cwd(), "src/components/dashboard/WixIntegrationSettings.tsx"),
      "utf8",
    );

    expect(actions).toMatch(
      /testWixConnection[\s\S]*phase_2_not_available[\s\S]*wixPostWithKey/u,
    );
    expect(actions).toMatch(
      /saveWixCredentials[\s\S]*phase_2_not_available[\s\S]*\.upsert\(patch/u,
    );
    expect(settings).toContain('data-testid="settings-wix-phase-2"');
    expect(settings).toContain("Legacy compatibility");
  });
});
