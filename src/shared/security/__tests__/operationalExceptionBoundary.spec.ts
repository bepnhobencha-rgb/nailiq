import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260728110610_add_ai_operational_exception_lifecycle.sql",
);
const action = read(
  "src/shared/ai/controlOperationalExceptionAction.ts",
);
const loader = read("src/shared/ai/operationalExceptions.ts");
const page = read("src/app/dashboard/[slug]/ai/page.tsx");

describe("AI operational exception boundary", () => {
  it("keeps the transition RPC service-role-only and invoker scoped", () => {
    expect(migration).toContain("security invoker");
    expect(migration).toContain(
      "revoke all on function public.control_watchdog_alert",
    );
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
    expect(migration).not.toContain("security definer");
  });

  it("locks and scopes every lifecycle transition to the salon", () => {
    expect(migration).toMatch(
      /where id = p_alert_id\s+and salon_id = p_salon_id\s+for update/,
    );
    expect(migration).toContain(
      "p_operation not in ('acknowledge', 'resolve', 'reopen')",
    );
    expect(migration).toContain("'unchanged'::text");
    expect(migration).toContain("'not_found'::text");
  });

  it("requires owner/admin before using the service-role RPC", () => {
    expect(action).toContain("getDashboardWriteClient(input.slug)");
    expect(action).toContain("isOwnerOrAdmin(ctx.role)");
    expect(action).toContain("p_salon_id: ctx.salon.id");
    expect(action).toContain("p_actor_user_id: ctx.userId");
    expect(action).toContain('revalidatePath(`/dashboard/${input.slug}/ai`)');
  });

  it("loads through service role and exposes the inbox in control center", () => {
    expect(loader).toContain("createServiceRoleClient");
    expect(loader).toContain('.eq("salon_id" as never, salonId)');
    expect(page).toContain("getOperationalExceptions(ctx.salon.id, 50)");
    expect(page).toContain(
      "operationalExceptions={operationalExceptionInbox.items}",
    );
  });

  it("writes one PII-free audit event only for a real transition", () => {
    expect(migration).toContain("insert into public.ai_actions_log");
    expect(migration).toContain("'actor_user_id', p_actor_user_id");
    expect(migration).toContain("'has_resolution_note', v_note is not null");
    expect(migration).not.toContain("'resolution_note', v_note");
  });
});
