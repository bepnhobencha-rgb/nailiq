import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260823021144_extend_cron_worker_allowlist_for_payment_workers.sql",
);
const previousAllowlistMigration = read(
  "supabase/migrations/20260811065733_tenant_pause_controls.sql",
);
const heartbeatSource = read("src/shared/ai/executionHeartbeat.ts");
const paymentReconciliationRoute = read(
  "src/app/api/cron/payment-reconciliation/route.ts",
);
const depositCompensationRoute = read(
  "src/app/api/cron/deposit-compensation/route.ts",
);

const supportedWorkers = [
  "ai_execution",
  "ai_manager",
  "campaign_scheduler",
  "close_stale_in_progress",
  "deposit_compensation",
  "error_triage",
  "minh_learn",
  "nail_tryon_cleanup",
  "noshow_card_nudge",
  "noshow_charge_retry",
  "payment_reconciliation",
  "release_review",
  "reminders",
  "send_pending_notifications",
  "spend_sync",
  "square_email_consent",
  "square_sync",
  "tenant_payment_pause",
  "waitlist_advance",
  "wix_sync",
] as const;

const addedPaymentWorkers = [
  "deposit_compensation",
  "payment_reconciliation",
] as const;

const quotedValues = (source: string): string[] =>
  [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]);

const extractCheckAllowlist = (constraintName: string): string[] => {
  const match = migration.match(
    new RegExp(
      `add constraint ${constraintName}_expanded\\s+check \\(worker_name in \\(\\s*([\\s\\S]*?)\\s*\\)\\) not valid;`,
      "i",
    ),
  );
  expect(
    match,
    `${constraintName} expanded check must be present`,
  ).not.toBeNull();
  return quotedValues(match?.[1] ?? "");
};

const extractFunctionAllowlist = (source: string): string[] => {
  const match = source.match(
    /create or replace function public\.ai_cron_worker_supported\([\s\S]*?select p_worker_name = any \(array\[([\s\S]*?)\]::text\[\]\);/i,
  );
  expect(match, "cron capability allowlist must be present").not.toBeNull();
  return quotedValues(match?.[1] ?? "");
};

const extractCronWorkerUnion = (): string[] => {
  const match = heartbeatSource.match(
    /export type CronWorkerName =([\s\S]*?);/,
  );
  expect(match, "CronWorkerName union must be present").not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
    (value) => value[1],
  );
};

const expectSafeConstraintSwap = (
  tableName: string,
  constraintName: string,
): void => {
  const addExpanded = migration.indexOf(
    `alter table public.${tableName}\n  add constraint ${constraintName}_expanded`,
  );
  const validateExpanded = migration.indexOf(
    `alter table public.${tableName}\n  validate constraint ${constraintName}_expanded`,
  );
  const dropPrevious = migration.indexOf(
    `alter table public.${tableName}\n  drop constraint if exists ${constraintName}`,
  );
  const renameExpanded = migration.indexOf(
    `alter table public.${tableName}\n  rename constraint ${constraintName}_expanded\n  to ${constraintName};`,
  );

  expect(
    addExpanded,
    `${constraintName} replacement must be added`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    validateExpanded,
    `${constraintName} replacement must be validated`,
  ).toBeGreaterThan(addExpanded);
  expect(
    dropPrevious,
    `${constraintName} predecessor must be retired only after validation`,
  ).toBeGreaterThan(validateExpanded);
  expect(
    renameExpanded,
    `${constraintName} replacement must retain the stable name`,
  ).toBeGreaterThan(dropPrevious);
};

describe("payment cron worker allowlist boundary", () => {
  it("uses the exact same fixed superset for state, history, capability, and application checks", () => {
    expect(
      extractCheckAllowlist("ai_execution_worker_state_name_check"),
    ).toEqual(supportedWorkers);
    expect(extractCheckAllowlist("ai_worker_runs_worker_name_check")).toEqual(
      supportedWorkers,
    );
    expect(extractFunctionAllowlist(migration)).toEqual(supportedWorkers);
    expect(extractCronWorkerUnion()).toEqual(supportedWorkers);

    const previousWorkers = extractFunctionAllowlist(previousAllowlistMigration);
    expect(
      supportedWorkers.filter((worker) => previousWorkers.includes(worker)),
    ).toEqual(previousWorkers);
    expect(
      supportedWorkers.filter((worker) => !previousWorkers.includes(worker)),
    ).toEqual(addedPaymentWorkers);
  });

  it("validates each replacement before retiring the narrower constraint", () => {
    expectSafeConstraintSwap(
      "ai_execution_worker_state",
      "ai_execution_worker_state_name_check",
    );
    expectSafeConstraintSwap(
      "ai_worker_runs",
      "ai_worker_runs_worker_name_check",
    );
  });

  it("matches the application union and both tracked cron routes", () => {
    for (const workerName of [
      "deposit_compensation",
      "payment_reconciliation",
    ]) {
      expect(heartbeatSource).toContain(`| "${workerName}"`);
    }
    expect(depositCompensationRoute).toContain(
      'runTrackedCron("deposit_compensation"',
    );
    expect(paymentReconciliationRoute).toContain(
      'runTrackedCron("payment_reconciliation"',
    );
  });

  it("retains a no-write, service-role-only capability", () => {
    expect(migration).toMatch(
      /create or replace function public\.ai_cron_worker_supported\(p_worker_name text\)[\s\S]+language sql[\s\S]+immutable[\s\S]+security invoker[\s\S]+set search_path = ''/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.ai_cron_worker_supported\(text\)[\s\S]+from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.ai_cron_worker_supported\(text\)[\s\S]+to service_role/,
    );
    expect(migration).not.toMatch(
      /\b(create table|create index|create trigger|insert into|update|delete from|truncate|drop table)\b/i,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:all|execute|select|insert|update|delete)[\s\S]{0,160}\bto\s+(?:public|anon|authenticated)\b/i,
    );
  });
});
