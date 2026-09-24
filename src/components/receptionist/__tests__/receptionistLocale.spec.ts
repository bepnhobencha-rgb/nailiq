import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StaffAvatar, type StaffStatus } from "@/components/ui/StaffAvatar";
import { userEn as en } from "@/shared/i18n/user/en";
import { userVi as vi } from "@/shared/i18n/user/vi";
import { formatInSalonTz } from "@/shared/lib/salonTime";
import { QueueEntryCard } from "../QueueEntryCard";
import { DateSwitcher } from "../DateSwitcher";

describe("receptionist locale parity", () => {
  it.each([["vi", vi], ["en", en]] as const)("localizes the day tablist in %s", (_lang, messages) => {
    const html = renderToStaticMarkup(createElement(DateSwitcher, {
      labels: messages.receptionist.dateSwitcher, selectedOffset: 1, onChange: () => {},
    }));
    expect(html).toContain(`aria-label="${messages.receptionist.dateSwitcher.day}"`);
    expect(html).toContain('data-testid="date-switcher-tomorrow" aria-selected="true"');
  });
  for (const showWaitTime of [true, false]) {
    it(`localizes the queue duration with wait hero ${showWaitTime}`, () => {
      const html = renderToStaticMarkup(createElement(QueueEntryCard, {
        position: 1,
        customerName: "Synthetic guest",
        serviceName: "Synthetic service",
        waitMinutes: 7,
        serviceDurationMinutes: 30,
        timezone: "America/Los_Angeles",
        showWaitTime,
        labels: vi.receptionist.queue,
      }));
      expect(html).toContain("30 phút");
      expect(html).not.toContain("30m");
      expect(html).not.toContain(">min<");
    });
  }

  it("preserves the English queue units", () => {
    const html = renderToStaticMarkup(createElement(QueueEntryCard, {
      position: 1,
      customerName: "Synthetic guest",
      serviceName: "Synthetic service",
      waitMinutes: 7,
      serviceDurationMinutes: 30,
      timezone: "America/Los_Angeles",
      labels: en.receptionist.queue,
    }));
    expect(html).toContain("30m");
    expect(html).toContain(">min<");
  });

  const statusCases: [StaffStatus, string, string][] = [
    ["available", "Đang rảnh", "Available"],
    ["busy", "Đang bận", "Busy"],
    ["overbooked", "Trùng lịch", "Overbooked"],
    ["offline", "Ngoại tuyến", "Offline"],
  ];
  for (const [status, viLabel, enLabel] of statusCases) {
    it(`localizes ${status} accessibility without changing default English`, () => {
      const props = { name: "Mai", status, size: "md" as const, workload: 50, showWorkload: true };
      const viHtml = renderToStaticMarkup(createElement(StaffAvatar, { ...props, language: "vi" }));
      const enHtml = renderToStaticMarkup(createElement(StaffAvatar, props));
      expect(viHtml).toContain(`aria-label="${viLabel}"`);
      expect(viHtml).toContain('aria-label="Mức độ bận của Mai: 50%"');
      expect(viHtml).not.toContain(`aria-label="${enLabel}"`);
      expect(enHtml).toContain(`aria-label="${enLabel}"`);
      expect(enHtml).toContain('aria-label="Mai workload 50%"');
    });
  }

  it("localizes drawer dates without shifting the salon day or changing its clock", () => {
    const instant = "2026-09-25T01:30:00.000Z";
    const timezone = "America/Los_Angeles";
    const expectedDate = new Intl.DateTimeFormat("vi-VN", {
      timeZone: timezone, weekday: "short", month: "short", day: "numeric",
    }).format(new Date(instant));
    expect(formatInSalonTz(instant, timezone, "date", "vi-VN")).toBe(expectedDate);
    expect(formatInSalonTz(instant, timezone, "datetime", "vi-VN")).toBe(`${expectedDate} · 6:30 PM`);
    expect(formatInSalonTz(instant, timezone, "date")).toBe("Thu, Sep 24");
    expect(formatInSalonTz(instant, timezone, "datetime")).toBe("Thu, Sep 24 · 6:30 PM");
    expect(formatInSalonTz("", timezone, "date", "vi-VN")).toBe("");
  });
});
