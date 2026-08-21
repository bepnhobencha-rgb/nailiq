import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveGuidedBookingPolicy: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/shared/noshow/guidedBookingPolicyAction", () => ({
  saveGuidedBookingPolicy: mocks.saveGuidedBookingPolicy,
}));

import { GuidedBookingPolicySetup } from "../GuidedBookingPolicySetup";

describe("GuidedBookingPolicySetup policy-only surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders only policy fields and no money, outbound, provider, or operational controls", () => {
    const html = renderToStaticMarkup(
      createElement(GuidedBookingPolicySetup, {
        slug: "qa-salon",
        cancellationPolicyEn: "English policy",
        cancellationPolicyVi: "Chính sách tiếng Việt",
        policySaved: true,
        groupBookingEnabled: true,
        groupPolicySaved: true,
        groupTogetherThresholdMinutes: 15,
        noShowGroupWholeParty: true,
      }),
    );

    expect(html).toContain('data-testid="guided-booking-policy-only"');
    expect(html).toContain('data-testid="guided-policy-en"');
    expect(html).toContain('data-testid="guided-policy-vi"');
    expect(html).toContain('data-testid="guided-group-policy"');
    expect(html).toContain('data-testid="guided-policy-save"');
    expect(html).toContain("Khóa an toàn (không cần thiết lập)");
    expect(html).not.toContain(
      'data-testid="guided-policy-after-hours-status">✓',
    );
    for (const forbidden of [
      "Retry charge",
      "Send pay link",
      "Waive",
      "Automated Reminders",
      "Auto-book waitlist",
      "Square",
      "Stripe",
      "Connect",
      "Sync",
    ]) {
      expect(html).not.toContain(forbidden);
    }
    expect(mocks.saveGuidedBookingPolicy).not.toHaveBeenCalled();
  });

  it("keeps forbidden operational modules outside the policy-only component", () => {
    const componentSource = readFileSync(
      resolve(
        process.cwd(),
        "src/components/dashboard/GuidedBookingPolicySetup.tsx",
      ),
      "utf8",
    );
    const pageSource = readFileSync(
      resolve(
        process.cwd(),
        "src/app/dashboard/[slug]/no-show-protection/page.tsx",
      ),
      "utf8",
    );

    for (const forbidden of [
      "noShowDashboardActions",
      "receptionistActions",
      "stripeConnectActions",
      "chargeNoShowFee",
      "sendNoShowFeeLink",
      "waiveNoShowFee",
      "updateNoShowCardSettings",
      "updateWaitlistAutoBook",
      "updateRemindersEnabled",
      "updateReminderSettings",
      "NoShowProtectionHub",
      "SquareSyncCard",
      "StripeConnectCard",
    ]) {
      expect(componentSource).not.toContain(forbidden);
    }

    expect(pageSource).not.toMatch(/^import .*NoShowProtectionHub/m);
    expect(pageSource).not.toMatch(/^import .*SquareSyncCard/m);
    const guidedBranch = pageSource.indexOf("if (guidedSetupEnabled)");
    const legacyClient = pageSource.indexOf(
      'await import("@/shared/lib/supabase/serviceRole")',
    );
    const legacyLoader = pageSource.indexOf(
      '"@/shared/noshow/noShowDashboardActions"',
    );
    expect(guidedBranch).toBeGreaterThan(-1);
    expect(legacyClient).toBeGreaterThan(guidedBranch);
    expect(legacyLoader).toBeGreaterThan(guidedBranch);
  });
});
