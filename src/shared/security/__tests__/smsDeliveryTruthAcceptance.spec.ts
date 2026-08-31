import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function sourceFiles(directory: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      results.push(...sourceFiles(full));
    } else if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.(?:spec|test)\./u.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function callsIn(text: string): string[] {
  const calls: string[] = [];
  const needle = "sendSmsReminder(";
  let cursor = 0;
  while ((cursor = text.indexOf(needle, cursor)) >= 0) {
    let depth = 1;
    let quote = "";
    let escaped = false;
    let index = cursor + needle.length;
    for (; index < text.length && depth > 0; index++) {
      const char = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    calls.push(text.slice(cursor, index));
    cursor = index;
  }
  return calls;
}

describe("Phase D SMS delivery truth acceptance", () => {
  it("labels every application send path for the universal attempt ledger", () => {
    const unlabeled: string[] = [];
    let count = 0;
    for (const file of sourceFiles(path.join(root, "src"))) {
      if (file.endsWith("/shared/lib/twilioSms.ts")) continue;
      for (const call of callsIn(fs.readFileSync(file, "utf8"))) {
        count++;
        if (!call.includes("notificationType:")) {
          unlabeled.push(path.relative(root, file));
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(18);
    expect(unlabeled).toEqual([]);
  });

  it("claims durably before fetch and always binds a status callback", () => {
    const dispatcher = source("src/shared/lib/twilioSms.ts");
    const claim = dispatcher.indexOf("await claimSmsDeliveryAttempt(");
    const callback = dispatcher.indexOf("bindSmsAttemptToStatusCallback(");
    const provider = dispatcher.indexOf("await fetch(url", callback);
    expect(claim).toBeGreaterThan(0);
    expect(callback).toBeGreaterThan(claim);
    expect(provider).toBeGreaterThan(callback);
    expect(dispatcher).toContain("error: \"sms_delivery_truth_unavailable\"");
    expect(dispatcher).toContain("outcome: \"suppressed\"");
    expect(dispatcher).not.toMatch(/SUPPRESSED_\$\{/u);
  });

  it("ships a service-role-only state machine with callback-race handling", () => {
    const migration = source(
      "supabase/migrations/20260831052212_add_sms_delivery_attempt_truth.sql",
    );
    expect(migration).toContain("create table if not exists public.sms_delivery_attempts");
    expect(migration).toContain("alter table public.sms_delivery_attempts enable row level security");
    expect(migration).toContain("create or replace function public.claim_sms_delivery_attempt");
    expect(migration).toContain("create or replace function public.complete_sms_delivery_attempt");
    expect(migration).toContain("create or replace function public.record_sms_delivery_attempt_receipt");
    expect(migration).toContain("if v_row.status in ('delivered', 'undelivered', 'failed')");
    expect(migration).toMatch(/revoke execute[\s\S]+from public, anon, authenticated/iu);
    expect(migration).toMatch(/grant execute[\s\S]+to service_role/iu);
  });
});
