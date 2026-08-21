import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  exchange: vi.fn(),
  signOut: vi.fn(),
  active: vi.fn(),
  role: vi.fn(),
  clearRole: vi.fn(),
  rate: vi.fn(),
  membership: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/shared/auth/requireActiveAuthSession", () => ({
  requireActiveAuthSession: mocks.active,
}));
vi.mock("@/shared/lib/superadmin", () => ({
  getSuperAdminRole: mocks.role,
  clearSuperAdminCache: mocks.clearRole,
}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumePublicRequestRateLimit: mocks.rate,
}));

import { GET } from "./route";
import { issuePasswordRecoveryIntent } from "@/shared/auth/passwordRecoverySecurity";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const accessToken = `e30.${Buffer.from(
  JSON.stringify({ session_id: SESSION_ID }),
).toString("base64url")}.sig`;

function request(input: {
  code: string;
  surface?: "salon" | "superadmin";
  email?: string;
  state?: string;
}) {
  const surface = input.surface ?? "salon";
  const state =
    input.state ??
    issuePasswordRecoveryIntent({
      email: input.email ?? "owner@example.com",
      surface,
    });
  const query = new URLSearchParams({ code: input.code, surface, state });
  return new NextRequest(`https://attacker.invalid/auth/recovery?${query}`);
}

describe("password recovery callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example");
    vi.stubEnv("PASSWORD_RECOVERY_SIGNING_SECRET", "s".repeat(64));
    mocks.rate.mockResolvedValue("allowed");
    mocks.exchange.mockResolvedValue({
      data: {
        user: { id: USER_ID, email: "owner@example.com" },
        session: { access_token: accessToken },
      },
      error: null,
    });
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.active.mockResolvedValue({ ok: true, user: { id: USER_ID } });
    mocks.role.mockResolvedValue(null);
    mocks.membership.mockResolvedValue({ data: { id: "member" }, error: null });
    const builder = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: mocks.membership,
    };
    mocks.createClient.mockResolvedValue({
      auth: { exchangeCodeForSession: mocks.exchange, signOut: mocks.signOut },
      rpc: vi.fn(),
      from: vi.fn(() => builder),
    });
  });

  it("rejects malformed codes before rate, Auth, or tenant reads", async () => {
    const response = await GET(
      request({ code: "\ninject", surface: "superadmin", email: "owner@example.com" }),
    );
    expect(response.headers.get("location")).toBe(
      "https://app.example/superadmin/forgot-password?notice=invalid_or_expired",
    );
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("fails closed before Auth when the durable limiter is unavailable", async () => {
    mocks.rate.mockResolvedValue("unavailable");
    const response = await GET(request({ code: "valid_code_123456" }));
    expect(response.headers.get("location")).toBe(
      "https://app.example/login/forgot-password?notice=temporarily_unavailable",
    );
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("issues an HttpOnly session-bound capability only after active Auth and salon membership", async () => {
    const response = await GET(request({ code: "valid_code_123456" }));
    expect(response.headers.get("location")).toBe(
      "https://app.example/login/reset-password",
    );
    expect(response.headers.get("set-cookie")).toContain("nq-password-recovery=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
  });

  it("returns an expired-link state with no capability on provider replay/error", async () => {
    mocks.exchange.mockResolvedValue({ data: { user: null, session: null }, error: {} });
    const response = await GET(request({ code: "valid_code_123456" }));
    expect(response.headers.get("location")).toBe(
      "https://app.example/login/forgot-password?notice=invalid_or_expired",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("denies membership query errors without issuing a capability", async () => {
    mocks.membership.mockResolvedValue({ data: null, error: { message: "down" } });
    const response = await GET(request({ code: "valid_code_123456" }));
    expect(response.headers.get("location")).toContain(
      "notice=temporarily_unavailable",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("routes an active SuperAdmin without reading salon membership", async () => {
    mocks.role.mockResolvedValue("founder");
    const response = await GET(
      request({
        code: "valid_code_123456",
        surface: "superadmin",
        email: "owner@example.com",
      }),
    );
    expect(response.headers.get("location")).toBe(
      "https://app.example/superadmin/reset-password",
    );
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain("nq-password-recovery=");
  });

  it("does not pivot a SuperAdmin recovery intent into the salon surface", async () => {
    mocks.role.mockResolvedValue(null);
    const response = await GET(
      request({
        code: "valid_code_123456",
        surface: "superadmin",
        email: "owner@example.com",
      }),
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it("rejects a missing/tampered emailed intent before Auth exchange", async () => {
    const response = await GET(
      request({ code: "valid_code_123456", state: "tampered" }),
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("fails closed without Auth exchange when intent verification is unavailable", async () => {
    const state = issuePasswordRecoveryIntent({
      email: "owner@example.com",
      surface: "salon",
    });
    vi.stubEnv("PASSWORD_RECOVERY_SIGNING_SECRET", "");
    const response = await GET(
      request({ code: "valid_code_123456", state }),
    );
    expect(response.headers.get("location")).toContain(
      "notice=temporarily_unavailable",
    );
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("rejects a valid intent bound to a different exchanged email", async () => {
    mocks.exchange.mockResolvedValue({
      data: {
        user: { id: USER_ID, email: "other@example.com" },
        session: { access_token: accessToken },
      },
      error: null,
    });
    const response = await GET(
      request({ code: "valid_code_123456", email: "owner@example.com" }),
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" });
  });
});
