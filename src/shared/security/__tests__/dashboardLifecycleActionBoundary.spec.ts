import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const activityBell = readFileSync(
  resolve(process.cwd(), "src/components/layout/ActivityBell.tsx"),
  "utf8",
);
const presenceHeartbeat = readFileSync(
  resolve(process.cwd(), "src/components/layout/PresenceHeartbeat.tsx"),
  "utf8",
);

describe("dashboard lifecycle App Router action boundary", () => {
  it("loads activity count without a lifecycle server action", () => {
    expect(activityBell).toContain("/api/dashboard/activity-unread");
    expect(activityBell).not.toContain("getActivityUnreadCount");
  });

  it("records presence without a lifecycle server action", () => {
    expect(presenceHeartbeat).toContain("/api/dashboard/presence");
    expect(presenceHeartbeat).not.toContain("upsertPresence");
  });
});
