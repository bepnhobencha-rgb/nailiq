import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compareBookingStartInstants } from "@/shared/dashboard/bookingStartComparison";
import {
  ownerNotificationActorLabel,
  ownerNotificationChangesLabel,
  ownerRescheduleTimeLabels,
} from "@/shared/dashboard/ownerBookingNotificationCopy";

describe("booking reschedule notification boundaries", () => {
  it("treats equivalent UTC serializations as the same appointment instant", () => {
    expect(
      compareBookingStartInstants(
        "2026-08-11T20:00:00+00:00",
        "2026-08-11T20:00:00.000Z",
      ),
    ).toMatchObject({ ok: true, changed: false });
  });

  it("detects a real time move and rejects invalid timestamps", () => {
    expect(
      compareBookingStartInstants(
        "2026-08-09T22:30:00.000Z",
        "2026-08-09T23:30:00.000Z",
      ),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      compareBookingStartInstants("not-a-time", "2026-08-09T23:30:00.000Z"),
    ).toEqual({ ok: false });
  });

  it("builds explicit before and after copy in the salon timezone", () => {
    expect(
      ownerRescheduleTimeLabels({
        previousStartUtc: "2026-08-09T22:30:00.000Z",
        nextStartUtc: "2026-08-09T23:30:00.000Z",
        timezone: "America/Los_Angeles",
        durationMin: 85,
      }),
    ).toEqual({
      before: "Sun, Aug 9 3:30 PM",
      afterDate: "Sun, Aug 9",
      afterTime: "4:30 PM · 85 min",
    });
  });

  it("describes who changed the booking and what changed", () => {
    expect(ownerNotificationActorLabel("receptionist")).toBe(
      "Receptionist · Lễ tân",
    );
    expect(ownerNotificationChangesLabel(["time", "staff", "time"])).toBe(
      "Time · Giờ hẹn, Staff · Nhân viên",
    );
  });

  it("keeps the desk path on instant comparison and the email sender guarded", () => {
    const editSource = readFileSync(
      new URL("../editBookingCore.ts", import.meta.url),
      "utf8",
    );
    const emailSource = readFileSync(
      new URL("../sendOwnerBookingNotification.ts", import.meta.url),
      "utf8",
    );

    expect(editSource).not.toContain("slotStartUtc !== st");
    expect(editSource).toContain("if (startChanged)");
    expect(emailSource).toContain('error: "same_start_instant"');
    expect(emailSource).toContain("Before · Trước khi đổi");
    expect(emailSource).toContain("After · Sau khi đổi");
    expect(emailSource).toContain(
      "Original booking source · Nguồn đặt ban đầu",
    );
  });
});
