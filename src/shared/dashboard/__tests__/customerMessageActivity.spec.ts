import { describe, expect, it } from "vitest";

import { customerMessageActivityItem } from "../customerMessageActivity";

describe("customerMessageActivityItem", () => {
  it("surfaces a saved receptionist message in the Dashboard AI activity tab", () => {
    const item = customerMessageActivityItem({
      id: "message-1",
      created_at: "2026-07-26T20:52:31.000Z",
      payload: {
        customer_name: "John Tran",
        customer_phone: "+17780000000",
        message: "Please confirm whether Bikini Line is offered to men.",
        urgency: "normal",
      },
    });

    expect(item.id).toBe("msg-message-1");
    expect(item.kind).toBe("ai");
    expect(item.status).toBe("saved");
    expect(item.title).toContain("Lời nhắn khách qua AI Tiếp tân · John Tran");
    expect(item.subtitle).toBe(
      "Please confirm whether Bikini Line is offered to men.",
    );
    expect(item.transcript).toContain("SĐT: +17780000000");
  });

  it("marks urgent messages and tolerates missing customer details", () => {
    const item = customerMessageActivityItem({
      id: "message-2",
      created_at: "2026-07-26T20:53:00.000Z",
      payload: { urgency: "urgent" },
    });

    expect(item.title).toContain("🔴");
    expect(item.title).toContain("khách");
    expect(item.subtitle).toBeNull();
    expect(item.transcript).toContain("(Không có nội dung)");
  });
});
