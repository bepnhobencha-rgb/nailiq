import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUser, redirect } = vi.hoisted(() => ({
  getUser: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser } })),
}));

import RegisterSuccessLayout from "@/app/register/success/layout";

describe("RegisterSuccessLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects a signed-out request before returning success content", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const successContent = createElement("h1", null, "Salon created!");

    await expect(
      RegisterSuccessLayout({ children: successContent }),
    ).rejects.toThrow("NEXT_REDIRECT:/register");

    expect(redirect).toHaveBeenCalledWith("/register");
  });

  it("returns success content for an authenticated registration session", async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { id: "owner-user-id" } },
      error: null,
    });
    const successContent = createElement("h1", null, "Salon created!");

    await expect(
      RegisterSuccessLayout({ children: successContent }),
    ).resolves.toBe(successContent);

    expect(redirect).not.toHaveBeenCalled();
  });
});
