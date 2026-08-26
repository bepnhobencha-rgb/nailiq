import { describe, expect, it, vi } from "vitest";

import {
  assertNotProduction,
  FORBIDDEN_MESSAGE,
  isE2EEmail,
  isE2ESlug,
  isLocalSupabaseServiceRoleKey,
  isProductionHost,
  isProductionProjectRef,
  projectRefFromUrl,
} from "./guardProduction";

const PROD_URL = "https://fshmobzyjhmtvndobwsy.supabase.co";
const TEST_URL = "https://abcdefghijklmnopqrst.supabase.co";
const KEY = "service-role-key-placeholder";
const jwt = (payload: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "test-signature",
  ].join(".");
const LOCAL_KEY = jwt({ iss: "supabase-demo", role: "service_role" });
const HOSTED_KEY = jwt({
  iss: "supabase",
  ref: "abcdefghijklmnopqrst",
  role: "service_role",
});

describe("projectRefFromUrl", () => {
  it("extracts the ref from a Supabase project URL", () => {
    expect(projectRefFromUrl(PROD_URL)).toBe("fshmobzyjhmtvndobwsy");
  });

  it("tolerates a trailing slash and mixed case", () => {
    expect(projectRefFromUrl("https://FSHMOBZYJHMTVNDOBWSY.supabase.co/")).toBe(
      "fshmobzyjhmtvndobwsy",
    );
  });

  it("returns null for a non-Supabase or empty URL", () => {
    expect(projectRefFromUrl("http://127.0.0.1:54321")).toBeNull();
    expect(projectRefFromUrl("")).toBeNull();
    expect(projectRefFromUrl(undefined)).toBeNull();
  });
});

describe("isProductionProjectRef", () => {
  it("recognises the production project", () => {
    expect(isProductionProjectRef("fshmobzyjhmtvndobwsy")).toBe(true);
  });
  it("does not flag another project", () => {
    expect(isProductionProjectRef("abcdefghijklmnopqrst")).toBe(false);
    expect(isProductionProjectRef(null)).toBe(false);
  });
});

describe("isProductionHost", () => {
  it("flags the production domain and its subdomains", () => {
    expect(isProductionHost("https://www.nailiq.ca/tech-nails")).toBe(true);
    expect(isProductionHost("https://nailiq.ca")).toBe(true);
  });
  it("does not flag localhost", () => {
    expect(isProductionHost("http://localhost:3000")).toBe(false);
  });
  it("does not flag a lookalike domain", () => {
    expect(isProductionHost("https://nailiq.ca.evil.example")).toBe(false);
  });
});

describe("isLocalSupabaseServiceRoleKey", () => {
  it("recognises only a local CLI service-role identity", () => {
    expect(isLocalSupabaseServiceRoleKey(LOCAL_KEY)).toBe(true);
    expect(isLocalSupabaseServiceRoleKey(HOSTED_KEY)).toBe(false);
    expect(isLocalSupabaseServiceRoleKey(KEY)).toBe(false);
    expect(
      isLocalSupabaseServiceRoleKey(
        jwt({ iss: "supabase-demo", role: "anon" }),
      ),
    ).toBe(false);
  });
});

describe("assertNotProduction", () => {
  it("throws when the Supabase URL is the production project", () => {
    expect(() =>
      assertNotProduction({ supabaseUrl: PROD_URL, serviceRoleKey: KEY }),
    ).toThrow(FORBIDDEN_MESSAGE);
  });

  it("throws when a local public URL is shadowed by a production internal URL", () => {
    expect(() =>
      assertNotProduction({
        supabaseUrl: "http://127.0.0.1:54321",
        internalSupabaseUrl: PROD_URL,
        serviceRoleKey: KEY,
      }),
    ).toThrow(FORBIDDEN_MESSAGE);
  });

  it("throws when the app under test is the production host", () => {
    expect(() =>
      assertNotProduction({
        supabaseUrl: TEST_URL,
        baseUrl: "https://www.nailiq.ca",
        serviceRoleKey: KEY,
      }),
    ).toThrow(FORBIDDEN_MESSAGE);
  });

  it("throws when the resolved ref does not match the pinned ref", () => {
    expect(() =>
      assertNotProduction({
        supabaseUrl: TEST_URL,
        serviceRoleKey: KEY,
        expectedProjectRef: "zzzzzzzzzzzzzzzzzzzz",
      }),
    ).toThrow(FORBIDDEN_MESSAGE);
  });

  it("FAILS CLOSED when a hosted service-role target has no exact ref pin", () => {
    expect(() =>
      assertNotProduction({
        supabaseUrl: TEST_URL,
        serviceRoleKey: KEY,
      }),
    ).toThrow("E2E_EXPECTED_PROJECT_REF");
  });

  it("FAILS CLOSED: a service-role key against an unrecognisable URL is refused", () => {
    expect(() =>
      assertNotProduction({
        supabaseUrl: "https://not-a-supabase-url.example.com",
        serviceRoleKey: KEY,
      }),
    ).toThrow(FORBIDDEN_MESSAGE);
  });

  it("FAILS CLOSED when an internal service-role target is unrecognisable", () => {
    expect(() =>
      assertNotProduction({
        supabaseUrl: "http://127.0.0.1:54321",
        internalSupabaseUrl: "https://db.invalid.example",
        serviceRoleKey: KEY,
      }),
    ).toThrow(FORBIDDEN_MESSAGE);
  });

  it("FAILS CLOSED when a service-role key has no database target", () => {
    expect(() => assertNotProduction({ serviceRoleKey: KEY })).toThrow(
      FORBIDDEN_MESSAGE,
    );
  });

  it("does NOT rely on NODE_ENV — a production build against a test project is allowed", () => {
    // The E2E workflow legitimately runs `next start`, so NODE_ENV is
    // "production" during a perfectly valid run. NODE_ENV describes the build,
    // never the database — keying on it would both miss real leaks and block
    // legitimate runs.
    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      assertNotProduction({
        supabaseUrl: TEST_URL,
        baseUrl: "http://localhost:3000",
        serviceRoleKey: KEY,
        expectedProjectRef: "abcdefghijklmnopqrst",
      }),
    ).not.toThrow();
    vi.unstubAllEnvs();
  });

  it("catches production even when NODE_ENV says 'test'", () => {
    // The inverse, and the one that actually bit us: a "test" run pointed at
    // the live project must still be refused.
    vi.stubEnv("NODE_ENV", "test");
    expect(() =>
      assertNotProduction({ supabaseUrl: PROD_URL, serviceRoleKey: KEY }),
    ).toThrow(FORBIDDEN_MESSAGE);
    vi.unstubAllEnvs();
  });

  it("allows a dedicated test project on localhost", () => {
    expect(() =>
      assertNotProduction({
        supabaseUrl: TEST_URL,
        baseUrl: "http://localhost:3000",
        serviceRoleKey: KEY,
        expectedProjectRef: "abcdefghijklmnopqrst",
      }),
    ).not.toThrow();
  });

  it("allows a local Supabase stack", () => {
    expect(() =>
      assertNotProduction({
        supabaseUrl: "http://127.0.0.1:54321",
        internalSupabaseUrl: "http://127.0.0.1:54321",
        baseUrl: "http://localhost:3000",
        serviceRoleKey: LOCAL_KEY,
      }),
    ).not.toThrow();
  });

  it("FAILS CLOSED when loopback is paired with a hosted service-role key", () => {
    expect(() =>
      assertNotProduction({
        supabaseUrl: "http://127.0.0.1:54321",
        internalSupabaseUrl: "http://127.0.0.1:54321",
        serviceRoleKey: HOSTED_KEY,
      }),
    ).toThrow(/loopback Supabase URL requires a local/);
  });

  it("accepts a modern local key only when exactly pinned to local CLI status", () => {
    expect(() =>
      assertNotProduction({
        supabaseUrl: "http://127.0.0.1:54321",
        serviceRoleKey: "sb_secret_local-example",
        expectedLocalServiceRoleKey: "sb_secret_local-example",
      }),
    ).not.toThrow();
  });

  it("FAILS CLOSED when the independently pinned local key differs", () => {
    expect(() =>
      assertNotProduction({
        supabaseUrl: "http://127.0.0.1:54321",
        serviceRoleKey: LOCAL_KEY,
        expectedLocalServiceRoleKey: `${LOCAL_KEY}-different`,
      }),
    ).toThrow("E2E_EXPECTED_LOCAL_SERVICE_ROLE_KEY");
  });

  it("allows a db-free run (no service-role key, no URL)", () => {
    expect(() => assertNotProduction({})).not.toThrow();
  });
});

describe("cleanup markers — the only rows sweep may delete", () => {
  it("accepts a seeded e2e address", () => {
    expect(isE2EEmail("e2e-superadmin-abc@nailiq.test.invalid")).toBe(true);
  });

  it("rejects every real address, including lookalikes", () => {
    expect(isE2EEmail("john.doe@gmail.com")).toBe(false);
    expect(isE2EEmail("thehuytgvn@gmail.com")).toBe(false);
    // Right domain, missing prefix.
    expect(isE2EEmail("owner@nailiq.test.invalid")).toBe(false);
    // Right prefix, real domain — must NOT be deletable.
    expect(isE2EEmail("e2e-superadmin@gmail.com")).toBe(false);
    // Domain merely *contains* the marker.
    expect(isE2EEmail("e2e-x@nailiq.test.invalid.evil.com")).toBe(false);
    expect(isE2EEmail(null)).toBe(false);
  });

  it("accepts only e2e- salon slugs", () => {
    expect(isE2ESlug("e2e-group-otp")).toBe(true);
    expect(isE2ESlug("tech-nails")).toBe(false);
    expect(isE2ESlug("hilite-anaheim")).toBe(false);
    expect(isE2ESlug(null)).toBe(false);
  });
});
