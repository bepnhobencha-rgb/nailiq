import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Auth Send Email Hook deployment boundary", () => {
  const entrypoint = read("supabase/functions/nailiq-auth-email/index.ts");
  const handler = read("supabase/functions/_shared/authEmailHook.ts");
  const config = read("supabase/config.toml");

  it("has one version-controlled handler and no authenticated starter scaffold", () => {
    expect(entrypoint.match(/Deno\.serve\(/g)).toHaveLength(1);
    expect(entrypoint).not.toContain("withSupabase");
    expect(entrypoint).not.toContain('auth: ["publishable", "secret"]');
    expect(entrypoint).toContain("new Webhook(secret).verify(body, headers)");
  });

  it("uses webhook signatures instead of JWTs for the Auth callback", () => {
    expect(config).toMatch(
      /\[functions\.nailiq-auth-email\]\s+verify_jwt = false/,
    );
    expect(handler).toContain("verifySignedPayload(");
    expect(handler.indexOf("verifySignedPayload(")).toBeLessThan(
      handler.indexOf("messagesForPayload({"),
    );
  });

  it("never logs email addresses, tokens, hook bodies, or provider errors", () => {
    expect(entrypoint).not.toContain("console.error(error");
    expect(entrypoint).not.toContain("console.error(result.error");
    expect(entrypoint).not.toContain("JSON.stringify(message)");
    expect(entrypoint).not.toContain("JSON.stringify(request)");
    expect(handler).not.toContain("JSON.stringify(payload)");
    expect(handler).not.toContain("JSON.stringify(body)");
    expect(handler).not.toContain("dependencies.log(email");
    expect(handler).not.toContain("dependencies.log(token");
    expect(entrypoint).toContain('FROM = "NailIQ <noreply@nailiq.ca>"');
    expect(entrypoint).toContain('{ name: "nailiq_email", value: "auth_account_security" }');
    expect(entrypoint).toContain('{ name: "nailiq_audience", value: "security" }');
  });

  it("returns the nested Supabase Auth Hook error contract", () => {
    expect(handler).toContain("{ error: { http_code: status, message: code } }");
  });
});
