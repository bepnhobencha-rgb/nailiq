import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { StatusBadge } from "@/components/dashboard/ActivityFeed";

describe("Activity Feed delivery badges", () => {
  it.each(["sms", "email"] as const)(
    "renders provider acceptance honestly for %s",
    (kind) => {
      const html = renderToStaticMarkup(createElement(StatusBadge, { kind, status: "sent" }));
      expect(html).toContain("Chờ xác nhận giao");
      expect(html).not.toContain("Đã nhận");
      expect(html).not.toContain("Đã giao");
    },
  );

  it("renders provider-reported delivery without claiming the customer read it", () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { kind: "sms", status: "delivered" }));
    expect(html).toContain("Đã giao");
    expect(html).toContain("không xác nhận khách đã đọc");
  });

  it("keeps call status separate from message delivery", () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { kind: "call", status: "completed" }));
    expect(html).toContain("Hoàn tất");
    expect(html).not.toContain("Đã giao");
  });
});
