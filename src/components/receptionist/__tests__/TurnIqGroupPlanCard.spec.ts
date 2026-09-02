import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TurnIqGroupPlanCard } from "@/components/receptionist/TurnIqGroupPlanCard";
import type { TurnIqGroupQueueView } from "@/shared/turniq/groupReadModels";

function queue(readiness: TurnIqGroupQueueView["groups"][number]["readiness"] = "ready"): TurnIqGroupQueueView {
  return {
    businessDate: "2026-09-02",
    groups: [
      {
        bookingGroupId: "11111111-1111-4111-8111-111111111111",
        partySize: 4,
        requestedStartAt: "2026-09-02T17:00:00.000Z",
        serviceSummary: "Classic Pedicure",
        readiness,
        existingPlanId: null,
        existingPlanStatus: null,
      },
    ],
  };
}

const handlers = {
  onRecommend: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onConfirm: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onLoadPlan: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onCompareTiming: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onRecordTimingPlan: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onConfirmStaggered: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onRefresh: async () => undefined,
};

function render(value: TurnIqGroupQueueView | null, options?: {
  offline?: boolean;
}) {
  return renderToStaticMarkup(
    createElement(TurnIqGroupPlanCard, {
      queue: value,
      errorCode: value ? null : "server_error",
      language: "vi",
      timezone: "America/Vancouver",
      slug: "salon-a",
      canManage: true,
      offline: options?.offline ?? false,
      ...handlers,
    }),
  );
}

describe("TurnIQ Group Plan Card", () => {
  it("makes the party, requested time and one-tap safe-plan action obvious", () => {
    const html = render(queue());
    expect(html).toContain("Xếp cả nhóm, xác nhận một lần");
    expect(html).toContain("4 khách");
    expect(html).toContain("Classic Pedicure");
    expect(html).toContain("10:00");
    expect(html).toContain("Tạo kế hoạch an toàn");
    expect(html).not.toMatch(/clientPhone|revenue|tip|fairnessCost/i);
  });

  it("fails visibly and hides planning when a group is partially assigned", () => {
    const html = render(queue("partially_assigned"));
    expect(html).toContain("Một số khách đã có thợ");
    expect(html).not.toContain("Tạo kế hoạch an toàn");
  });

  it("disables mutation while offline without hiding last-known group truth", () => {
    const html = render(queue(), { offline: true });
    expect(html).toContain("Đang mất kết nối");
    expect(html).toContain("Classic Pedicure");
    expect(html).toContain("disabled");
  });

  it("states explicitly when no owner action is needed", () => {
    const html = render({ businessDate: "2026-09-02", groups: [] });
    expect(html).toContain("Không có nhóm nào cần xếp");
    expect(html).toContain("không cần chủ can thiệp");
  });

  it("never claims an assignment when the trusted queue cannot load", () => {
    const html = render(null);
    expect(html).toContain("Chưa tải được danh sách nhóm");
    expect(html).toContain("chưa tự gán hoặc thay đổi booking nào");
  });
});
