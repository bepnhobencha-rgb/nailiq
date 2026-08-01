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
        data: { user: input?.user ?? { id: "user-new", email: "new@example.test" } },
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
      "https://www.nailiq.ca/login?error=Access+denied",
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });
});
