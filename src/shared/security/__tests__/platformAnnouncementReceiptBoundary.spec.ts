import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const migration = source(
  "supabase/migrations/20260901170032_smart_notification_center_receipts.sql",
);
const action = source(
  "src/shared/dashboard/platformAnnouncementReceiptActions.ts",
);

describe("platform announcement receipt boundary", () => {
  it("isolates receipt state to the authenticated user", () => {
    expect(migration).toContain(
      "alter table public.platform_announcement_receipts enable row level security",
    );
    expect(migration).toMatch(/using \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(migration).toMatch(/with check \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(migration).not.toMatch(/grant delete/i);
    expect(migration).toContain("snoozed_until timestamptz");
    expect(migration).toContain(
      "alter table public.platform_notification_preferences enable row level security",
    );
    expect(migration).toMatch(
      /platform_notification_preferences[\s\S]*using \(\(select auth\.uid\(\)\) = user_id\)/,
    );
  });

  it("derives the user from the authenticated salon membership", () => {
    expect(action).toContain("getDashboardWriteClient(normalizedSlug)");
    expect(action).toContain('ctx.kind !== "member"');
    expect(action).toContain("user_id: ctx.userId");
    expect(action).toContain("audienceIncludesMemberRole");
    expect(action).toContain("updatePlatformNotificationPreference");
    expect(action).toContain('ctx.kind !== "member"');
  });

  it("uses one atomic upsert for seen and dismissed state", () => {
    expect(migration).toContain("primary key (announcement_id, user_id)");
    expect(action).toContain(".upsert(receipt as never");
    expect(action).toContain('onConflict: "announcement_id,user_id"');
    expect(action).toContain('onConflict: "user_id"');
  });
});
