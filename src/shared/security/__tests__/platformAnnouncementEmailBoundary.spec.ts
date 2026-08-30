import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const migration = read(
  "supabase/migrations/20260811183000_role_localized_platform_notice_email.sql",
);
const delivery = read(
  "src/shared/superadmin/platformAnnouncementEmail.ts",
);
const action = read("src/shared/superadmin/announcementsActions.ts");
const parity = read("scripts/check-schema-parity.ts");

describe("role-localized platform email boundary", () => {
  it("keeps queue data service-role-only", () => {
    expect(migration).toContain(
      "alter table public.platform_announcement_deliveries enable row level security",
    );
    expect(migration).toMatch(
      /revoke all privileges on table public\.platform_announcement_deliveries\s+from public, anon, authenticated/,
    );
    expect(migration).toContain("as restrictive for all to anon, authenticated");
    expect(migration).toMatch(
      /revoke all on function public\.queue_platform_announcement_deliveries\(uuid\)\s+from public, anon, authenticated/,
    );
  });

  it("requires important mode, manual email intent, and an active salon", () => {
    expect(migration).toContain("a.email_requested = true");
    expect(migration).toContain("a.notification_mode = 'important'");
    expect(migration).toContain("s.archived_at is null");
    expect(action).toContain("input.emailRequested && input.notificationMode !== \"important\"");
  });

  it("deduplicates users, limits retries, and uses provider idempotency", () => {
    expect(migration).toContain("unique (announcement_id, user_id)");
    expect(delivery).toContain("const MAX_ATTEMPTS = 3");
    expect(delivery).toContain("nailiq-platform-notice-${row.announcement_id}-${row.user_id}");
    expect(delivery).not.toContain("listUsers");
  });

  it("keeps the production-shape tripwire current", () => {
    expect(parity).toContain("through 20260820105820");
    expect(parity).toContain('"platform_announcement_deliveries"');
    expect(parity).toContain('"queue_platform_announcement_deliveries"');
    expect(parity).toContain("tables: 187");
    expect(parity).toContain("columns: 2811");
    expect(parity).toContain("policies: 207");
    expect(parity).toContain("functions: 419");
    expect(parity).toContain("indexes: 692");
    expect(parity).toContain("service_role: 179");
  });
});
