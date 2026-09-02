import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TurnIqGroupWhatIf } from "@/components/receptionist/TurnIqGroupWhatIf";
import type { TurnIqGroupTimingComparisonView } from "@/shared/turniq/groupReadModels";

const comparison: TurnIqGroupTimingComparisonView = {
  bookingGroupId: "11111111-1111-4111-8111-111111111111",
  snapshotVersion: "snapshot-v1",
  comparedAt: "2026-09-02T17:59:00.000Z",
  windowMinutes: 240,
  finishOffsetMinutes: 120,
  liveStateChanged: false,
  options: [
    {
      simulationId: "11111111-1111-4111-8111-111111111111",
      simulationFingerprint: "1".repeat(64),
      intent: "start_together",
      feasible: true,
      liveStateChanged: false,
      explanation: "Simulation only",
      ownerActionRequired: false,
      eta: {
        earliestStartMinutes: 15,
        allStartedByMinutes: 25,
        confidencePaddingMinutes: 10,
      },
      metrics: {
        waveCount: 1,
        maximumWaitMinutes: 15,
        totalWaitMinutes: 45,
        latestReleaseMinutes: 85,
      },
      assignments: [
        {
          taskId: "guest-a",
          staff: { id: "staff-a", name: "Mai" },
          serviceSummary: "Classic Pedicure",
          resourceNames: ["pedicure-chair"],
          startsAt: "2026-09-02T18:15:00.000Z",
          releasesAt: "2026-09-02T19:15:00.000Z",
          waitMinutes: 15,
          waveNumber: 1,
        },
      ],
    },
    {
      simulationId: "22222222-2222-4222-8222-222222222222",
      simulationFingerprint: "2".repeat(64),
      intent: "finish_together",
      feasible: false,
      liveStateChanged: false,
      explanation: "No complete safe option",
      ownerActionRequired: true,
      eta: null,
      metrics: null,
      assignments: [],
    },
    {
      simulationId: "33333333-3333-4333-8333-333333333333",
      simulationFingerprint: "3".repeat(64),
      intent: "smart_wave",
      feasible: true,
      liveStateChanged: false,
      explanation: "Simulation only",
      ownerActionRequired: false,
      eta: {
        earliestStartMinutes: 0,
        allStartedByMinutes: 80,
        confidencePaddingMinutes: 10,
      },
      metrics: {
        waveCount: 2,
        maximumWaitMinutes: 0,
        totalWaitMinutes: 0,
        latestReleaseMinutes: 70,
      },
      assignments: [
        {
          taskId: "guest-a",
          staff: { id: "staff-a", name: "Mai" },
          serviceSummary: "Classic Pedicure",
          resourceNames: ["pedicure-chair"],
          startsAt: "2026-09-02T18:00:00.000Z",
          releasesAt: "2026-09-02T19:00:00.000Z",
          waitMinutes: 0,
          waveNumber: 1,
        },
      ],
    },
  ],
};

function render(options?: { offline?: boolean; withResults?: boolean }) {
  return renderToStaticMarkup(
    createElement(TurnIqGroupWhatIf, {
      bookingGroupId: comparison.bookingGroupId,
      language: "vi",
      timezone: "America/Vancouver",
      slug: "salon-a",
      offline: options?.offline ?? false,
      initialComparison: options?.withResults ? comparison : null,
      onCompare: async () => ({ ok: true as const, data: comparison }),
      onRecordPlan: async () => ({
        ok: false as const,
        code: "stale_state" as const,
      }),
      onPlanRecorded: async () => undefined,
    }),
  );
}

describe("TurnIQ Group What-if", () => {
  it("makes compare-then-save-then-confirm boundaries explicit", () => {
    const html = render();
    expect(html).toContain("So sánh 3 cách");
    expect(html).toContain("booking chỉ đổi sau bước xác nhận riêng");
    expect(html).toContain("So sánh không ghi booking");
  });

  it("shows all timing intents and highlights only lowest wait", () => {
    const html = render({ withResults: true });
    expect(html).toContain("Đến cùng lúc");
    expect(html).toContain("Về cùng lúc");
    expect(html).toContain("Chia đợt thông minh");
    expect(html).toContain("Chờ ít nhất");
    expect(html).toContain("Mai");
    expect(html).toContain("Chọn kế hoạch này");
    expect(html).toContain("11:00");
    expect(html).toContain("Chưa chứng minh được phương án đầy đủ và an toàn");
    expect(html).not.toMatch(/fairnessTier|revenue|tip|customerPhone/i);
  });

  it("keeps last-known results visible but disables a new offline comparison", () => {
    const html = render({ offline: true, withResults: true });
    expect(html).toContain("Đang offline");
    expect(html).toContain("Mai");
    expect(html).toContain("disabled");
  });
});
