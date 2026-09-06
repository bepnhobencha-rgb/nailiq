import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260906151425_safe_new_salon_activation_defaults.sql",
);
const registrationAction = read(
  "src/shared/register/completeSalonRegistrationAction.ts",
);
const defaults = read("src/shared/register/registrationDefaults.ts");

describe("new salon activation safety boundary", () => {
  it("keeps public booking and every outbound or provider path off by default", () => {
    for (const column of [
      "profile_complete",
      "sms_outbound_enabled",
      "email_outbound_enabled",
      "email_links_enabled",
      "reminders_enabled",
      "reminder_24h_enabled",
      "reminder_3h_enabled",
      "sms_reminders_enabled",
      "voice_ai_enabled",
      "noshow_protection_enabled",
      "winback_enabled",
    ]) {
      expect(migration).toContain(
        `ALTER COLUMN ${column} SET DEFAULT false`,
      );
      expect(defaults).toContain(`${column}: false`);
    }
    expect(migration).toContain("ALTER COLUMN payment_provider DROP DEFAULT");
    expect(defaults).toContain("payment_provider: null");
  });

  it("applies the safe defaults explicitly on the real registration insert", () => {
    expect(registrationAction).toContain("REGISTRATION_SAFE_SALON_DEFAULTS");
    expect(registrationAction).toMatch(
      /\.insert\(\{[\s\S]*?\.\.\.REGISTRATION_SAFE_SALON_DEFAULTS,[\s\S]*?setup_wizard_completed_at/,
    );
  });

  it("changes future defaults without rewriting existing salon rows", () => {
    expect(migration).not.toMatch(/\bUPDATE\s+public\.salons\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+public\.salons\b/i);
    expect(migration).toContain("existing salons and their live settings are untouched");
  });
});
