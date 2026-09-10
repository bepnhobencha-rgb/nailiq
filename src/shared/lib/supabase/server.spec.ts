import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    headers: new Headers(),
    getAll: () => [...values].map(([name, value]) => ({ name, value })),
    set: vi.fn((name: string, value: string, options: Record<string, unknown>) => {
      void options;
      values.set(name, value);
    }),
  };
});
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => jar.headers }));
import { createClient } from "./server";

beforeEach(() => {
  jar.set.mockClear();
  jar.values.clear();
  jar.headers = new Headers();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.nailiq.ca");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://auth.example.invalid");
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon");
  const user = { id: "synthetic-user", aud: "authenticated", email: "qa@example.invalid" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/logout")) return new Response(null, { status: 204 });
    if (!url.pathname.endsWith("/token")) throw new Error("Unexpected Auth request");
    return Response.json({
      access_token: "test-access", refresh_token: "test-refresh",
      token_type: "bearer", expires_in: 3600, user,
    });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("real SSR SDK writes through the shared server client", () => {
  it.each([
    ["https://www.nailiq.ca", true, "http"], ["https://localhost:3443", true, "https"],
    ["http://localhost:3000", false, "http"], ["http://localhost:3000", true, "https"],
  ] as const)("preserves cookie policy during sign-in, refresh and removal at %s (Secure=%s, transport=%s)", async (origin, secure, proto) => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
    jar.headers.set("x-forwarded-proto", proto);
    const client = await createClient();
    const signedIn = await client.auth.signInWithPassword({ email: "qa@example.invalid", password: "synthetic-password" });
    expect(signedIn.error).toBeNull();
    expect(jar.set).toHaveBeenCalled();
    for (const [, , options] of jar.set.mock.calls as unknown as [string, string, Record<string, unknown>][]) {
      expect(options).toMatchObject({ secure, sameSite: "lax", path: "/", httpOnly: false });
    }
    jar.set.mockClear();
    expect((await client.auth.refreshSession()).error).toBeNull();
    expect(jar.set).toHaveBeenCalled();
    for (const [, , options] of jar.set.mock.calls as unknown as [string, string, Record<string, unknown>][]) {
      expect(options.secure).toBe(secure);
    }
    jar.set.mockClear();
    expect((await client.auth.signOut({ scope: "local" })).error).toBeNull();
    expect(jar.set).toHaveBeenCalled();
    for (const [, value, options] of jar.set.mock.calls as unknown as [string, string, Record<string, unknown>][]) {
      expect(value).toBe("");
      expect(options).toMatchObject({ secure, maxAge: 0, path: "/" });
    }
  });
});
