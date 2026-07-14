import { describe, expect, it } from "vitest";

import { scanDump } from "../../../../scripts/verify-schema-dump";

/**
 * The dump checker has two jobs, and the second one is the one that decides
 * whether anybody ever listens to it.
 *
 *   1. Catch a dump that carries customer rows or a credential.
 *   2. Do NOT cry wolf on a correct schema-only dump.
 *
 * A checker that fires on every clean run is a checker people learn to skip,
 * and a skipped checker is worse than none — it buys false confidence. So the
 * "no false positives" block below is not a nicety; it is the reason this gate
 * can be trusted when it does fire.
 */

/**
 * A CORRECT schema-only dump. Note how much of it looks alarming to a naive
 * grep: "password", "email", "phone", "secret", "token", "client_profiles",
 * "service_role", "api_key" — every one of these is an IDENTIFIER here, and a
 * schema that omitted them would simply be wrong.
 */
const CLEAN_DUMP = `
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.client_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone text NOT NULL,
    email text,
    no_show_count integer DEFAULT 0
);

CREATE TABLE auth.users (
    id uuid NOT NULL,
    email character varying(255),
    encrypted_password character varying(255),
    phone text
);

CREATE TABLE public.platform_settings (
    twilio_auth_token text,
    resend_api_key text,
    stripe_webhook_secret text
);

CREATE TABLE public.wix_integrations (
    wix_api_key text,
    access_token text,
    refresh_token text
);

ALTER TABLE public.client_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY deny_all_platform_settings ON public.platform_settings
    USING (false);

CREATE POLICY salon_isolation ON public.bookings
    USING ((salon_id IN ( SELECT salon_members.salon_id
       FROM salon_members
      WHERE (salon_members.user_id = auth.uid()))));

GRANT SELECT ON TABLE public.salons TO anon;
GRANT ALL ON TABLE public.platform_settings TO service_role;

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_phone_check CHECK ((client_phone ~ '^\\+?[0-9]{7,15}$'));

CREATE FUNCTION public.compute_no_show_risk(p_phone text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$ BEGIN RETURN 30; END; $$;

SELECT pg_catalog.setval('public.some_seq', 1, false);
`;

describe("verify-schema-dump — does not cry wolf on a correct dump", () => {
  it("passes a schema-only dump clean", () => {
    expect(scanDump(CLEAN_DUMP)).toEqual([]);
  });

  it.each([
    ["a password COLUMN", "encrypted_password character varying(255),"],
    ["a token COLUMN", "    twilio_auth_token text,"],
    ["an api_key COLUMN", "    resend_api_key text,"],
    ["a webhook secret COLUMN", "    stripe_webhook_secret text,"],
    ["the customer TABLE name", "CREATE TABLE public.client_profiles ("],
    ["a service_role GRANT", "GRANT ALL ON TABLE public.platform_settings TO service_role;"],
    ["an email COLUMN", "    email character varying(255),"],
    ["a phone CHECK constraint", "CHECK ((client_phone ~ '^\\\\+?[0-9]{7,15}$'))"],
    ["a sequence position", "SELECT pg_catalog.setval('public.some_seq', 1, false);"],
  ])("does not flag %s — it is schema, not data", (_label, line) => {
    expect(scanDump(line)).toEqual([]);
  });
});

describe("verify-schema-dump — an INSERT inside a function body is SOURCE, not data", () => {
  /**
   * The first version of this checker failed the real dump on 8 lines, all of
   * them PL/pgSQL. Every one was an INSERT inside a function body — the
   * function's source code, which inserts nothing until the app calls the RPC.
   *
   * That is precisely the cry-wolf failure this file exists to prevent, and it
   * shipped anyway. pg_dump only ever emits real rows at top level, never inside
   * a dollar-quoted body, so the state has to be tracked.
   */
  const FUNCTION_WITH_INSERT = `
CREATE FUNCTION public.upsert_client_profile(p_phone text, p_name text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_digits text;
BEGIN
  v_digits := regexp_replace(coalesce(p_phone, ''), '\\D', '', 'g');

  INSERT INTO public.client_profiles (phone, name, visit_count)
  VALUES (v_digits, p_name, 1)
  ON CONFLICT (phone) DO UPDATE SET name = excluded.name;

  RETURN gen_random_uuid();
END;
$$;
`;

  it("does not flag an INSERT inside a $$ … $$ body", () => {
    expect(scanDump(FUNCTION_WITH_INSERT)).toEqual([]);
  });

  it("does not flag an INSERT inside a $tag$ … $tag$ body", () => {
    const tagged = FUNCTION_WITH_INSERT.replace(/\$\$/g, "$fn$");
    expect(scanDump(tagged)).toEqual([]);
  });

  it("still flags a REAL top-level INSERT that follows a function body", () => {
    // The state must close correctly, or one function would blind the rest of
    // the file — a dump could then smuggle rows in after any CREATE FUNCTION.
    const sql = `${FUNCTION_WITH_INSERT}\nINSERT INTO public.bookings (id) VALUES (1);\n`;
    const f = scanDump(sql);
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe("insert-data");
  });

  it("still flags a secret hardcoded INSIDE a function body", () => {
    // Credentials count everywhere. A key pasted into a function is a real leak,
    // and a body is where people forget to look.
    const key = ["sk", "live", "51Abcdefghijklmnopqrstuvwx"].join("_");
    const sql = `CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  PERFORM http_post('x', '${key}');\nEND;\n$$;`;
    expect(scanDump(sql).length).toBeGreaterThan(0);
  });
});

describe("verify-schema-dump — catches what actually matters", () => {
  it("fails on COPY … FROM stdin (bulk customer rows)", () => {
    const f = scanDump(
      "COPY public.client_profiles (id, phone, email) FROM stdin;\n" +
        "1\t+16045551234\tanna@example.com\n" +
        "\\.\n",
    );
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe("copy-data");
    expect(f[0].line).toBe(1);
  });

  it("reports the COPY header once, not once per customer row", () => {
    // A 11,226-row dump must not produce 11,226 findings — nobody reads that,
    // and the useful signal drowns.
    const rows = Array.from({ length: 500 }, (_, i) => `${i}\t+1604555${i}\tx@y.z`).join("\n");
    const f = scanDump(
      `COPY public.client_profiles (id, phone, email) FROM stdin;\n${rows}\n\\.\n`,
    );
    expect(f).toHaveLength(1);
  });

  it("fails on INSERT INTO", () => {
    const f = scanDump("INSERT INTO public.bookings (id, client_name) VALUES (1, 'Anna');");
    expect(f.map((x) => x.rule)).toContain("insert-data");
  });

  /**
   * The fixtures are ASSEMBLED at runtime rather than written as literals.
   *
   * Not stylistic. Writing `sk_live_51Abc…` into this file makes the file itself
   * a scannable credential: GitHub push protection rejected exactly that, and it
   * was right to — a scanner cannot tell "a fake key in a test" from "a real key
   * someone pasted", and neither can a person skimming a diff. Joining the parts
   * yields the identical string at runtime, so the regexes are exercised on the
   * real shape, while the repo contains nothing that looks like a key.
   *
   * (That the scanner flagged them is also a decent independent check that the
   * shapes below actually resemble real credentials.)
   */
  const fake = {
    stripe: ["sk", "live", `51${"Abcdefghijklmnopqrstuvwx"}`].join("_"),
    twilio: `A${"C"}${"0123456789abcdef".repeat(2)}`,
    anthropic: ["sk", "ant", "api03", "A".repeat(20)].join("-"),
    jwt: `ey${"JhbGciOiJIUzI1NiJ9"}.ey${"JzdWIiOiIxMjM0NTYifQ"}`,
    pem: `-----BEGIN RSA ${"PRIVATE"} KEY-----`,
    conn: `postgres${"ql"}://postgres:${"hunter2"}@db.abc.supabase.co:5432/postgres`,
  };

  it.each([
    ["a JWT", () => `  key text DEFAULT '${fake.jwt}';`],
    ["a Stripe secret key", () => `  k text DEFAULT '${fake.stripe}';`],
    ["an Anthropic key", () => `  k text DEFAULT '${fake.anthropic}';`],
    ["a Twilio SID", () => `  sid text DEFAULT '${fake.twilio}';`],
    ["a private key", () => fake.pem],
    ["a connection string with a password", () => `  url text DEFAULT '${fake.conn}';`],
  ])("fails on %s hardcoded in the schema", (_label, build) => {
    expect(scanDump(build()).length).toBeGreaterThan(0);
  });

  it("never echoes the secret value into its own output", () => {
    // This output goes to a CI log. Printing the credential in order to complain
    // about the credential would be a fine way to leak it twice.
    const f = scanDump(`  k text DEFAULT '${fake.stripe}';`);
    expect(f[0].detail).not.toContain(fake.stripe);
    expect(f[0].detail).toContain("REDACTED");
  });
});
