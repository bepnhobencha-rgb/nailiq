import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  claimInviteToken,
  createServerClient,
  createServiceRoleClient,
  recordAuthEvent,
  resolveRoleAndSlugForUser,
} = vi.hoisted(() => ({
  claimInviteToken: vi.fn(),
  createServerClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  recordAuthEvent: vi.fn(),
  resolveRoleAndSlugForUser: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient,
}));
vi.mock("@/shared/lib/salonMembership", () => ({
  resolveRoleAndSlugForUser,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient,
}));
vi.mock("@/shared/dashboard/inviteTokenActions", () => ({
  claimInviteToken,
}));
vi.mock("@/shared/dashboard/recordAuthEvent", () => ({
  recordAuthEvent,
}));

import { GET } from "./route";

type CookieToSet = {
  name: string;
  value: string;
  options?: Record<string, unknown>;
};

function installAuthClient(input?: {
  exchangeError?: { code?: string; message: string } | null;
  user?: { id: string; email?: string | null } | null;
}) {
  const exchangeCodeForSession = vi.fn();
  const getUser = vi.fn();

  createServerClient.mockImplementation(
    (
      _url: string,
      _anonKey: string,
      options: {
        cookies: {
          setAll(cookies: CookieToSet[]): void;
        };
      },
    ) => {
      exchangeCodeForSession.mockImplementation(async () => {
        if (!input?.exchangeError) {
          options.cookies.setAll([
            {
              name: "sb-auth-token",
              value: "signed-session",
              options: {
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              },
            },
          ]);
        }
        return { error: input?.exchangeError ?? null };
      });
      getUser.mockResolvedValue({
        data: {
          user:
            input && "user" in input
              ? input.user
              : { id: "user-new", email: "new@example.test" },
        },
      });
      return {
        auth: {
          exchangeCodeForSession,
          getUser,
        },
      };
    },
  );

  return { exchangeCodeForSession, getUser };
}

describe("OAuth and email-link callback session boundary", () => {
  beforeEach(() => {
    claimInviteToken.mockReset();
    createServerClient.mockReset();
    createServiceRoleClient.mockReset();
    recordAuthEvent.mockReset();
    resolveRoleAndSlugForUser.mockReset();
  });

  it("attaches exchanged session cookies to the redirect for a new owner", async () => {
    const { exchangeCodeForSession } = installAuthClient();
    resolveRoleAndSlugForUser.mockResolvedValue(null);

    const response = await GET(
      new NextRequest("https://www.nailiq.ca/auth/callback?code=oauth-code"),
    );

    expect(exchangeCodeForSession).toHaveBeenCalledWith("oauth-code");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://www.nailiq.ca/register/setup",
    );
    expect(response.cookies.get("sb-auth-token")).toMatchObject({
      name: "sb-auth-token",
      value: "signed-session",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
  });

  it("sends an existing owner to the role-correct dashboard and audits login", async () => {
    installAuthClient({
      user: { id: "owner-1", email: "owner@example.test" },
    });
    resolveRoleAndSlugForUser.mockResolvedValue({
      slug: "tech-nails",
      role: "owner",
      needsPicker: false,
    });
    recordAuthEvent.mockResolvedValue(undefined);

    const response = await GET(
      new NextRequest("https://www.nailiq.ca/auth/callback?code=email-code", {
        headers: {
          "user-agent": "Vitest Browser",
          "x-forwarded-for": "203.0.113.8, 10.0.0.1",
        },
      }),
    );

    expect(response.headers.get("location")).toBe(
      "https://www.nailiq.ca/dashboard/tech-nails",
    );
    expect(recordAuthEvent).toHaveBeenCalledWith({
      event: "login",
      userId: "owner-1",
      slug: "tech-nails",
      role: "owner",
      ip: "203.0.113.8",
      userAgent: "Vitest Browser",
    });
    expect(response.cookies.get("sb-auth-token")?.value).toBe("signed-session");
  });

  it.each([false, true])("returns an authenticated member to the exact fee page (picker=%s)", async (needsPicker) => {
    installAuthClient();
    resolveRoleAndSlugForUser.mockResolvedValue({ slug: "another-salon", role: "owner", needsPicker });
    const next = "/dashboard/test-salon/cancellation-fee/4378c3c6-f485-4ab4-9cb2-2011e82f5d66";
    const response = await GET(new NextRequest(`https://www.nailiq.ca/auth/callback?code=code&next=${encodeURIComponent(next)}`));
    expect(response.headers.get("location")).toBe(`https://www.nailiq.ca${next}`);
    expect(response.cookies.get("sb-auth-token")?.value).toBe("signed-session");
  });

  it("does not use a fee navigation hint as membership authorization", async () => {
    installAuthClient();
    resolveRoleAndSlugForUser.mockResolvedValue(null);
    createServiceRoleClient.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: 0 }) });
    const next = "/dashboard/test-salon/cancellation-fee/4378c3c6-f485-4ab4-9cb2-2011e82f5d66";
    const response = await GET(new NextRequest(`https://www.nailiq.ca/auth/callback?code=code&next=${encodeURIComponent(next)}`));
    expect(response.headers.get("location")).toBe("https://www.nailiq.ca/register/setup");
  });

  it.each(["//evil.example", "https://evil.example", "/api/booking/cancel-action", "/dashboard/test-salon?charge=1"])("rejects callback open redirect %s", async (next) => {
    installAuthClient();
    resolveRoleAndSlugForUser.mockResolvedValue({ slug: "test-salon", role: "owner", needsPicker: false });
    const response = await GET(new NextRequest(`https://www.nailiq.ca/auth/callback?code=code&next=${encodeURIComponent(next)}`));
    expect(response.headers.get("location")).toBe("https://www.nailiq.ca/dashboard/test-salon");
  });

  it("preserves a safe destination after a PKCE error without granting a session", async () => {
    installAuthClient({ exchangeError: { code: "pkce_code_verifier_not_found", message: "missing" } });
    const next = "/dashboard/test-salon/cancellation-fee/4378c3c6-f485-4ab4-9cb2-2011e82f5d66";
    const response = await GET(new NextRequest(`https://www.nailiq.ca/auth/callback?code=code&next=${encodeURIComponent(next)}`));
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(next);
    expect(location.searchParams.get("error")).toBe("pkce_restart");
    expect(response.cookies.getAll()).toHaveLength(0);
  });

  it("fails visibly and does not set a session cookie when PKCE state is missing", async () => {
    const { getUser } = installAuthClient({
      exchangeError: {
        code: "pkce_code_verifier_not_found",
        message: "PKCE verifier missing",
      },
    });

    const response = await GET(
      new NextRequest("https://www.nailiq.ca/auth/callback?code=stale-code"),
    );

    expect(response.headers.get("location")).toBe(
      "https://www.nailiq.ca/login?error=pkce_restart",
    );
    expect(response.cookies.getAll()).toHaveLength(0);
    expect(getUser).not.toHaveBeenCalled();
  });

  it("surfaces provider errors without attempting a code exchange", async () => {
    const { exchangeCodeForSession } = installAuthClient();

    const response = await GET(
      new NextRequest(
        "https://www.nailiq.ca/auth/callback?error_description=Access%20denied",
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://www.nailiq.ca/login?error=session",
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it.each([
    ["flow_state_expired", "link_session_expired"],
    ["flow_state_not_found", "link_session_expired"],
    ["unexpected_error", "session"],
    [undefined, "session"],
  ])("handles exchange error %s without granting a session", async (code, expected) => {
    const { getUser } = installAuthClient({
      exchangeError: { code, message: "private@example.test token=never-reflect" },
    });
    const response = await GET(
      new NextRequest("https://www.nailiq.ca/auth/callback?code=stale-code&invite=unclaimed"),
    );
    expect(response.headers.get("location")).toBe(
      `https://www.nailiq.ca/login?error=${expected}`,
    );
    expect(response.cookies.getAll()).toHaveLength(0);
    expect(getUser).not.toHaveBeenCalled();
    expect(resolveRoleAndSlugForUser).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(claimInviteToken).not.toHaveBeenCalled();
    expect(recordAuthEvent).not.toHaveBeenCalled();
  });
});

describe("Callback failures remain visible without reflecting provider text", () => {
  it.each([
    "?error=access_denied",
    "?error_description=Email%20link%20is%20invalid%20or%20has%20expired",
    "?error=access_denied&error_description=",
    "?error=flow_state_expired&error_description=private%40example.test",
    "",
  ])("returns a recognized login error for %s", async (query) => {
    createServerClient.mockClear();
    const response = await GET(
      new NextRequest(`https://www.nailiq.ca/auth/callback${query}`),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://www.nailiq.ca/login?error=session",
    );
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("shows an error if the exchanged session has no verified user", async () => {
    installAuthClient({ user: null });
    resolveRoleAndSlugForUser.mockClear();
    const response = await GET(
      new NextRequest("https://www.nailiq.ca/auth/callback?code=invalid-user"),
    );
    expect(response.headers.get("location")).toBe(
      "https://www.nailiq.ca/login?error=session",
    );
    expect(response.cookies.getAll()).toHaveLength(0);
    expect(resolveRoleAndSlugForUser).not.toHaveBeenCalled();
  });
});
