import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const migration = source(
  "supabase/migrations/20260724013000_protect_salon_control_plane_columns.sql",
);

describe("salon control-plane column boundary", () => {
  it("hardens the existing audit function without adding schema objects", () => {
    expect(migration).toContain(
      "create or replace function public.log_system_audit()",
    );
    expect(migration).not.toContain("create trigger");
    expect(migration).not.toContain(
      "function public.enforce_salon_control_plane_columns()",
    );
  });

  it("preserves authorization errors instead of swallowing the write rejection", () => {
    expect(migration).toContain("when insufficient_privilege then");
    expect(migration).toMatch(/when insufficient_privilege then\s+raise;/);
    expect(migration).toContain("when others then");
  });

  it.each([
    "subscription_plan",
    "subscription_status",
    "plan_override",
    "stripe_customer_id",
    "stripe_connect_account_id",
    "voice_ai_sessions_limit",
    "sms_a2p_registered",
    "trial_started_at",
    "superadmin_locked_at",
  ])("keeps %s service-role controlled", (column) => {
    expect(migration).toContain(`'${column}'`);
  });

  it("allows invalidation but reserves positive email verification for trusted code", () => {
    expect(migration).toContain(
      "new.email_verified is distinct from old.email_verified",
    );
    expect(migration).toContain("and new.email_verified is true");
    expect(migration).toContain(
      "email verification requires service-role authorization",
    );
  });

  it.each(["vertical", "archived_at", "payment_provider"])(
    "requires an owner membership to change %s",
    (column) => {
      expect(migration).toContain(`'${column}'`);
      expect(migration).toContain("membership_role is distinct from 'owner'");
    },
  );

  it("moves Stripe Connect mirrors behind the service-role client after owner authorization", () => {
    const actions = source("src/shared/dashboard/stripeConnectActions.ts");
    const ownerChecks = actions.match(/if \(!isOwner\(ctx\.role\)\)/g) ?? [];
    const serviceWrites =
      actions.match(/createServiceRoleClient\(\)\s*\n\s*\.from\("salons"\)/g) ?? [];

    expect(actions).toContain(
      'import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole"',
    );
    expect(ownerChecks).toHaveLength(2);
    expect(serviceWrites).toHaveLength(4);
  });

  it("keeps payment-provider selection owner-only at the server action", () => {
    const actions = source("src/shared/noshow/noShowDashboardActions.ts");
    const start = actions.indexOf(
      "export async function updateNoShowCardSettings(",
    );
    const next = actions.indexOf("\nexport async function ", start + 1);
    const action = actions.slice(start, next < 0 ? undefined : next);

    expect(start).toBeGreaterThan(-1);
    expect(action).toContain(
      "const ctx = await resolveNoShowManagementContext(slug)",
    );
    expect(action).toContain('if (!ctx) return { ok: false, error: "unauthorized" }');
    expect(action).toContain(
      "settings.payment_provider !== undefined && !isOwner(ctx.role)",
    );
    expect(action.indexOf("settings.payment_provider !== undefined")).toBeLessThan(
      action.indexOf("patch.payment_provider"),
    );
  });
});
