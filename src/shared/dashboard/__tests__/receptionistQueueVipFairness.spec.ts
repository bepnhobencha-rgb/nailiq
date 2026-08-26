import { describe, expect, it } from "vitest";

import { sortQueueByPriority } from "@/shared/dashboard/receptionistQueuePriority";

const NOW = Date.parse("2026-08-22T20:00:00.000Z");

function item(
  id: string,
  joined: string,
  isVip: boolean,
  readyAt: string | null = null,
) {
  return {
    id,
    is_vip: isVip,
    joined_queue_at: joined,
    requested_staff_name: readyAt ? "Requested Tech" : null,
    requested_staff_ready_at_iso: readyAt,
  };
}

describe("MQA-0176 receptionist VIP fairness", () => {
  it("keeps an older non-VIP ahead of a newer VIP", () => {
    const queue = [
      item("new-vip", "2026-08-22T19:55:00.000Z", true),
      item("older-customer", "2026-08-22T19:50:00.000Z", false),
    ];

    expect(sortQueueByPriority(queue, NOW).map((row) => row.id)).toEqual([
      "older-customer",
      "new-vip",
    ]);
  });

  it("uses wait-risk and staff readiness without consulting VIP status", () => {
    const queue = [
      item("vip-normal", "2026-08-22T19:58:00.000Z", true),
      item("staff-ready", "2026-08-22T19:57:00.000Z", false, "2026-08-22T19:59:00.000Z"),
      item("long-wait", "2026-08-22T19:35:00.000Z", false),
    ];

    expect(sortQueueByPriority(queue, NOW).map((row) => row.id)).toEqual([
      "long-wait",
      "staff-ready",
      "vip-normal",
    ]);
  });
});
