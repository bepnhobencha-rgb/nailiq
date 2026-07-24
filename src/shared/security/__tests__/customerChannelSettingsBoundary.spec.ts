import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const actions = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/customerChannelActions.ts"),
  "utf8",
);

function actionSource(name: string): string {
  const start = actions.indexOf(`export async function ${name}(`);
  const next = actions.indexOf("\nexport async function ", start + 1);
  return actions.slice(start, next < 0 ? undefined : next);
}

describe("customer channel settings authorization boundary", () => {
  it("guards settings reads before accessing outbound-channel configuration", () => {
    const action = actionSource("getCustomerChannelSettings");
    const roleGuard = action.indexOf("if (!isOwnerOrAdmin(ctx.role))");
    const settingsRead = action.indexOf("sms_outbound_enabled");

    expect(actions).toContain('from "@/shared/lib/salonMemberRole"');
    expect(roleGuard).toBeGreaterThan(-1);
    expect(settingsRead).toBeGreaterThan(roleGuard);
  });

  it("guards settings writes before validating or mutating", () => {
    const action = actionSource("saveCustomerChannelSettings");
    const roleGuard = action.indexOf("if (!isOwnerOrAdmin(ctx.role))");
    const validation = action.indexOf("CustomerChannelSettingsInput.safeParse");
    const mutation = action.indexOf(".update(");

    expect(roleGuard).toBeGreaterThan(-1);
    expect(validation).toBeGreaterThan(roleGuard);
    expect(mutation).toBeGreaterThan(validation);
    expect(action).toContain('error: "forbidden"');
  });

  it("accepts only the four supported channel modes and strict booleans", () => {
    expect(actions).toContain("smsOutboundEnabled: z.boolean()");
    expect(actions).toContain("emailOutboundEnabled: z.boolean()");
    expect(actions).toContain(
      'z.enum(["smart", "sms_only", "email_only", "sms_and_email"])',
    );
    expect(actionSource("saveCustomerChannelSettings")).toContain(
      'error: "invalid_input"',
    );
  });

  it("restricts direct salon-row updates to owner/admin with USING and WITH CHECK", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260724004500_restrict_salon_settings_updates.sql",
      ),
      "utf8",
    );

    expect(migration).toContain('drop policy if exists "owner update own salon"');
    expect(migration).toContain('create policy "owner update own salon"');
    expect(migration).toContain("for update");
    expect(migration).toContain("with check");
    expect(migration.match(/sm\.role in \('owner', 'admin'\)/g)).toHaveLength(2);
  });
});
