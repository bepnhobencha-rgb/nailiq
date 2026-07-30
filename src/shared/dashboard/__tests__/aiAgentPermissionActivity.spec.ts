import { describe, expect, it } from "vitest";

import { aiAgentPermissionActivityItem } from "../aiAgentPermissionActivity";

describe("aiAgentPermissionActivityItem", () => {
  it("describes an acknowledged customer-outreach activation", () => {
    expect(
      aiAgentPermissionActivityItem(
        {
          id: "audit-1",
          flag_key: "ai_winback",
          impact: "customer_outreach",
          enabled: true,
          previous_enabled: false,
          impact_acknowledged: true,
          actor_role: "owner",
          actor_kind: "member",
          created_at: "2026-07-30T02:15:24.000Z",
        },
        "Mai",
      ),
    ).toMatchObject({
      id: "ap-audit-1",
      kind: "ai",
      title: "Mai đã bật Người Kéo Về — Win-back",
      subtitle: "Có thể liên hệ trực tiếp với khách",
      actorRole: "owner",
      transcript: expect.stringContaining(
        "Đã xác nhận tác động trước khi bật.",
      ),
    });
  });

  it("makes a disable transition explicit without claiming acknowledgement", () => {
    const item = aiAgentPermissionActivityItem({
      id: "audit-2",
      flag_key: "ai_watchdog",
      impact: "monitoring",
      enabled: false,
      previous_enabled: true,
      impact_acknowledged: false,
      actor_role: "admin",
      actor_kind: "member",
      created_at: "2026-07-30T02:16:24.000Z",
    });

    expect(item.title).toBe("Quản lý đã tắt Người Canh Tiệm — Watchdog");
    expect(item.transcript).toContain("Thay đổi: Bật → Tắt");
    expect(item.transcript).toContain(
      "Tắt quyền không cần xác nhận tác động.",
    );
  });
});
