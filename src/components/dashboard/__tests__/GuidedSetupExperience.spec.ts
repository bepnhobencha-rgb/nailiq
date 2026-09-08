import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GuidedAdminActionCenter } from "@/components/dashboard/GuidedAdminActionCenter";
import { GuidedSetupHub } from "@/components/dashboard/GuidedSetupHub";
import { CocoSetupUnavailable } from "@/components/dashboard/CocoSetupUnavailable";
import type {
  GoLiveReadiness,
  GoLiveReadinessState,
} from "@/shared/dashboard/goLiveReadiness";
import { deriveSetupCoverageManifest } from "@/shared/dashboard/setupCoverageManifest";

vi.mock("@/shared/lib/useUserLanguage", () => ({
  useUserLanguage: () => ({ language: "vi" as const }),
}));
vi.mock("@/shared/dashboard/skipGuidedSetupIntegrationsAction", () => ({
  skipGuidedSetupIntegrations: vi.fn(),
}));
vi.mock("@/shared/dashboard/saveCocoSetupDecisionAction", () => ({
  saveCocoSetupDecision: vi.fn(),
}));

const setupCoverage = deriveSetupCoverageManifest([]);

const CHECK_IDS = [
  "identity",
  "schedule",
  "hours-confirmation",
  "staff",
  "catalog",
  "booking-policy",
  "fallback-channel",
  "notification-language",
  "otp-policy",
  "optional-integrations",
  "public-booking",
  "human-approval",
  "owner-approval",
] as const;

function readiness(
  states: Partial<Record<(typeof CHECK_IDS)[number], GoLiveReadinessState>>,
): GoLiveReadiness {
  return {
    checks: CHECK_IDS.map((id) => ({
      id,
      state: states[id] ?? "action",
      blocking: id !== "optional-integrations",
      titleEn: id,
      titleVi: id,
      detailEn: `${id} detail`,
      detailVi: `${id} detail`,
    })),
    passedBlocking: 0,
    totalBlocking: 12,
    readyForManualReview: false,
    approvedForGoLive: false,
  };
}

describe("Guided Setup rendered experience", () => {
  it("explains a safe pause instead of silently redirecting to services", () => {
    const html = renderToStaticMarkup(
      createElement(CocoSetupUnavailable, {
        slug: "qa salon",
        salonName: "QA Salon",
      }),
    );

    expect(html).toContain("Coco đang tạm dừng an toàn");
    expect(html).toContain("Coco không thay đổi cài đặt");
    expect(html).toContain('href="/dashboard/qa%20salon/setup/services"');
  });

  it("shows one actionable next step while every other row stays inert", () => {
    const html = renderToStaticMarkup(
      createElement(GuidedSetupHub, {
        slug: "qa salon",
        salonName: "QA Salon",
        readiness: readiness({ identity: "pass" }),
        setupCoverage,
      }),
    );

    expect(html).toContain("Tiến độ được tính lại từ dữ liệu salon đã lưu");
    expect(html).toContain("Chưa Go-Live — salon vẫn ở chế độ thiết lập");
    expect(html).toContain("Booking công khai, thông báo và thanh toán");
    expect(html).toContain("Giờ mở cửa và ngày nghỉ");
    expect(html).toContain('href="/dashboard/qa%20salon/setup/hours"');
    expect(html.match(/data-testid="guided-setup-next"/g)).toHaveLength(1);
    expect(html.match(/data-guided-setup-locked="true"/g)).toHaveLength(9);
    expect(html).toContain("Chưa quyết định — có thể bỏ qua");
  });

  it("routes missing service capability coverage to staff instead of services", () => {
    const value = readiness({
      identity: "pass",
      schedule: "pass",
      staff: "pass",
    });
    const catalog = value.checks.find((check) => check.id === "catalog");
    if (!catalog) throw new Error("catalog fixture missing");
    catalog.href = "/dashboard/qa%20salon/setup/staff";
    catalog.detailVi =
      "Gán mỗi dịch vụ đang hoạt động cho ít nhất một nhân viên đang hoạt động.";

    const html = renderToStaticMarkup(
      createElement(GuidedSetupHub, {
        slug: "qa salon",
        salonName: "QA Salon",
        readiness: value,
        setupCoverage,
      }),
    );

    expect(html).toContain('href="/dashboard/qa%20salon/setup/staff"');
    expect(html).not.toContain(
      'data-testid="guided-setup-next" href="/dashboard/qa%20salon/setup/services"',
    );
  });

  it("offers explicit Review and Skip actions only at the optional step", () => {
    const html = renderToStaticMarkup(
      createElement(GuidedSetupHub, {
        slug: "qa-salon",
        salonName: "QA Salon",
        readiness: readiness({
          identity: "pass",
          schedule: "pass",
          staff: "pass",
          catalog: "pass",
          "booking-policy": "pass",
          "fallback-channel": "pass",
          "notification-language": "pass",
        }),
        setupCoverage,
      }),
    );

    expect(html).toContain("Xem tích hợp");
    expect(html).toContain(
      'href="/dashboard/qa-salon/settings?section=integrations"',
    );
    expect(
      html.match(/data-testid="guided-setup-skip-integrations"/g),
    ).toHaveLength(1);
    expect(html).toContain("Bỏ qua lúc này");
  });

  it("keeps the completed root focused on one primary Front Desk action", () => {
    const html = renderToStaticMarkup(
      createElement(GuidedAdminActionCenter, {
        slug: "qa salon",
        salonName: "QA Salon",
      }),
    );

    expect(html).toContain("Sẵn sàng hoạt động");
    expect(html).toContain("Việc tiếp theo");
    expect(
      html.match(/data-testid="guided-action-open-front-desk"/g),
    ).toHaveLength(1);
    expect(html).toContain('href="/dashboard/qa%20salon/center"');
    expect(html).toContain('href="/qa%20salon"');
    expect(html).toContain('href="/dashboard/qa%20salon/settings"');
  });
});
