import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TurnIqStaffPinCard } from "@/components/receptionist/TurnIqStaffPinCard";

const common = {
  slug: "salon-a",
  language: "vi" as const,
  offline: false,
  activePolicyVersionId: "11111111-1111-4111-8111-111111111111",
  staff: [
    { staffId: "staff-1", staffName: "Mai", state: "active" as const },
    {
      staffId: "staff-2",
      staffName: "Linh",
      state: "not_checked_in" as const,
    },
  ],
  canConfigurePin: true,
  onConfigurePin: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onApplyPinShift: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onRefresh: async () => undefined,
};

describe("TurnIQ staff PIN shared-device surface", () => {
  it("explains dual attribution and does not render a plaintext PIN", () => {
    const html = renderToStaticMarkup(
      createElement(TurnIqStaffPinCard, {
        ...common,
        rolloutStage: "supervised",
      }),
    );
    expect(html).toContain("Check-in bằng PIN thợ");
    expect(html).toContain("Tài khoản đang đăng nhập");
    expect(html).toContain("PIN không xuất hiện trong receipt");
    expect(html).toContain('type="password"');
    expect(html).toContain("Bắt đầu nghỉ");
    expect(html).toContain("Rời ca");
    expect(html).toContain("Đặt / đổi PIN");
    expect(html).not.toMatch(/value="\d{4,8}"/);
  });

  it("truthfully disables shift mutation in Shadow", () => {
    const html = renderToStaticMarkup(
      createElement(TurnIqStaffPinCard, {
        ...common,
        rolloutStage: "shadow",
      }),
    );
    expect(html).toContain("Shadow: chỉ quan sát");
    expect(html).toContain("Shadow chỉ quan sát nên không thay đổi ca");
    expect(html).toContain('disabled=""');
  });

  it("truthfully reports offline read-only", () => {
    const html = renderToStaticMarkup(
      createElement(TurnIqStaffPinCard, {
        ...common,
        rolloutStage: "live",
        offline: true,
      }),
    );
    expect(html).toContain("Offline: chỉ xem");
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });
});
