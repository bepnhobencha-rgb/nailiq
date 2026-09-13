import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.stubGlobal("React", React);
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/components/booking/PendingBookingCreateResolution", () => ({ PendingBookingCreateResolution: () => null }));
import Card from "@/app/booking/recover-card/page";
import Booking from "@/app/booking/recover-booking/page";
import Group from "@/app/booking/recover-group/page";
describe("recovery before URL fragment is available", () => {
  it.each([Card, Booking, Group])("does not announce expired before the client reads its link", Page => {
    const html = renderToString(React.createElement(Page));
    expect(html).toContain("Loading recovery link");
    expect(html).not.toMatch(/has expired|This link is unavailable|Card saved|protection active/);
  });
});
