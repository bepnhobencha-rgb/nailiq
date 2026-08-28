import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");

const migration = read(
  "supabase/migrations/20260724163000_explicit_email_optout_policy.sql",
);
const proof = read("scripts/security/check-email-optout-boundary.sql");
const rollback = read("scripts/security/rehearse-email-optout-rollback.sql");

describe("client_email_optouts boundary", () => {
  it("removes direct API grants while preserving service-role access", () => {
    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON TABLE public.client_email_optouts",
    );
    expect(migration).toContain(
      "GRANT ALL PRIVILEGES ON TABLE public.client_email_optouts TO service_role",
    );
    expect(proof).toContain("has_any_column_privilege");
  });

  it("adds exactly one restrictive false policy", () => {
    expect(migration).toContain("AS RESTRICTIVE FOR ALL");
    expect(migration).toContain("USING (false) WITH CHECK (false)");
    expect(proof).toContain("v_policy_count <> 1");
    expect(proof).toContain("AND NOT polpermissive");
    expect(proof).toContain("cardinality(polroles) = 2");
  });

  it("rehearses the exact legacy ACL then rolls back", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback).toContain(
      "GRANT ALL PRIVILEGES ON TABLE public.client_email_optouts",
    );
    expect(rollback).toContain("\\ir check-email-optout-boundary.sql");
  });

  it("keeps suppression reads and verified writes on service-role clients", () => {
    const compliance = read("src/shared/lib/emailCompliance.ts");
    const route = read("src/app/api/unsubscribe/route.ts");
    const page = read("src/app/unsubscribe/page.tsx");

    expect(compliance).toContain("createServiceRoleClient()");
    expect(compliance).toContain('.from("client_email_optouts" as never)');
    expect(route).toContain("unsubscribeValid(email, sig)");
    expect(route).toContain("createServiceRoleClient()");
    expect(page).toContain("unsubscribeValid(email, sig.trim())");
    expect(page).toContain("createServiceRoleClient()");
  });

  it("fails closed on suppression errors and never reports a failed opt-out as success", () => {
    const compliance = read("src/shared/lib/emailCompliance.ts");
    const route = read("src/app/api/unsubscribe/route.ts");
    const page = read("src/app/unsubscribe/page.tsx");
    const rebook = read("src/shared/winback/agentRebook.ts");
    const firstVisit = read("src/shared/firstvisit/agentFirstVisit.ts");
    const vipCare = read("src/shared/ai/agentVipCare.ts");
    const staffAction = read(
      "src/shared/notifications/deliverStaffActionNotification.ts",
    );

    expect(compliance).toContain("if (error) return true");
    expect(compliance).toContain("catch {\n    return true;");
    expect(route).toContain("if (!suppressed)");
    expect(route).toContain("status: 503");
    expect(page).toContain("We could not update your email preferences");
    expect(rebook).not.toContain("getResendClient");
    expect(rebook).not.toContain(".emails.send");
    expect(firstVisit).toContain("isEmailSuppressed(to).catch(() => true)");
    expect(vipCare).toContain(
      "isEmailSuppressed(client.email).catch(() => true)",
    );
    expect(vipCare).toContain('delivery_mode: "draft_only_human_send_required"');
    expect(vipCare).not.toContain("resend.emails.send");
    expect(staffAction).toContain(
      "isEmailSuppressed(to).catch(() => true)",
    );
  });

  it("updates blank-database parity tripwires", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("policies: 205");
    expect(parity).toContain(
      "const GRANTS = { anon: 56, authenticated: 77, service_role: 176 }",
    );
  });
});
