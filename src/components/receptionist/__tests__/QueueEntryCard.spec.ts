import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QueueEntryCard } from "../QueueEntryCard";

describe("QueueEntryCard", () => {
  it("renders the requested-staff clock in the salon timezone", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "UTC";

    try {
      const html = renderToStaticMarkup(
        createElement(QueueEntryCard, {
          position: 1,
          customerName: "Demo guest",
          serviceName: "Gel manicure",
          waitMinutes: 5,
          requestedStaffName: "Lena",
          requestedStaffReadyAtIso: "2026-08-01T18:30:00.000Z",
          timezone: "America/Los_Angeles",
          showWaitTime: false,
          labels: {
            waitHeroSuffix: "waiting",
            priorityHigh: "High",
            priorityMedium: "Medium",
            priorityLow: "Low",
            partySizeLabel: (n) => `Party of ${n}`,
            sourceFallback: "Walk-in",
            vipAria: "VIP",
            readyAroundShort: "Ready ~{time}",
            requestedByClientLine: "Customer requested this staff member",
            softHoldCountdown: (minutes) => `${minutes} minutes left`,
            softHoldLabel: "Held",
          },
        }),
      );

      expect(html).toContain("Ready ~11:30 AM");
      expect(html).not.toContain("Ready ~6:30 PM");
    } finally {
      if (previousTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimezone;
      }
    }
  });

  it("renders an accessible details button and contact-readiness badge", () => {
    const html = renderToStaticMarkup(
      createElement(QueueEntryCard, {
        position: 2,
        customerName: "Walk-in guest",
        serviceName: "Classic manicure",
        waitMinutes: 3,
        timezone: "America/Vancouver",
        onOpenDetails: () => undefined,
        openDetailsLabel: "Open contact details for Walk-in guest",
        contactState: "reachable",
        contactStateLabel: "Reachable",
        labels: {
          waitHeroSuffix: "waiting",
          priorityHigh: "High",
          priorityMedium: "Medium",
          priorityLow: "Low",
          partySizeLabel: (n) => `Party of ${n}`,
          sourceFallback: "Walk-in",
          vipAria: "VIP",
          readyAroundShort: "Ready ~{time}",
          requestedByClientLine: "Customer requested this staff member",
          softHoldCountdown: (minutes) => `${minutes} minutes left`,
          softHoldLabel: "Held",
        },
      }),
    );

    expect(html).toContain("Open contact details for Walk-in guest");
    expect(html).toContain("queue-contact-state");
    expect(html).toContain("Reachable");
  });
});
