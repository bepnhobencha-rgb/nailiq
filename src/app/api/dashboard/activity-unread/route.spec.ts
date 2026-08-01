import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getActivityUnreadCount = vi.hoisted(() => vi.fn());
vi.mock("@/shared/dashboard/loadActivityFeedAction", () => ({
  getActivityUnreadCount,
}));

import { GET } from "@/app/api/dashboard/activity-unread/route";

describe("activity unread API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivityUnreadCount.mockResolvedValue({ ok: true, count: 3 });
  });

  it("rejects an invalid timestamp before querying activity", async () => {
    const response = await GET(
      new NextRequest(
        "https://nailiq.ca/api/dashboard/activity-unread?slug=hoa-hong&since=nope",
      ),
    );
    expect(response.status).toBe(400);
    expect(getActivityUnreadCount).not.toHaveBeenCalled();
  });

  it("delegates the authenticated count without caching it", async () => {
    const since = "2026-07-30T12:00:00.000Z";
    const response = await GET(
      new NextRequest(
        `https://nailiq.ca/api/dashboard/activity-unread?slug=hoa-hong&since=${encodeURIComponent(since)}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(getActivityUnreadCount).toHaveBeenCalledWith("hoa-hong", since);
    await expect(response.json()).resolves.toEqual({ ok: true, count: 3 });
  });
});
