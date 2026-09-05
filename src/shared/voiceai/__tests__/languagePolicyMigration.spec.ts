import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260727020207_add_voice_ai_allowed_languages.sql",
  ),
  "utf8",
);
const parity = readFileSync(
  resolve(process.cwd(), "scripts/check-schema-parity.ts"),
  "utf8",
);

describe("Voice AI language policy migration", () => {
  it("requires a non-empty supported allowlist containing the default language", () => {
    expect(migration).toContain("cardinality(voice_ai_allowed_languages) > 0");
    expect(migration).toContain(
      "voice_ai_allowed_languages <@ array['vi', 'en', 'es', 'fr', 'zh']::text[]",
    );
    expect(migration).toContain(
      "voice_ai_default_language = any(voice_ai_allowed_languages)",
    );
  });

  it("advances the blank-database schema parity tripwire", () => {
    expect(parity).toContain("through 20260820105820");
    expect(parity).toContain("columns: 3608");
  });
});
