import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let throwOnClientCreation = false;
let suppressionResult: {
  data: { email: string } | null;
  error: { message: string } | null;
} = { data: null, error: null };

const maybeSingle = vi.fn(async () => suppressionResult);
let providerSuppressionResult: {
  data: string | null;
  error: { message: string } | null;
} = { data: null, error: null };
const rpc = vi.fn(async () => providerSuppressionResult);

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => {
    if (throwOnClientCreation) throw new Error("service role unavailable");
    return {
      rpc,
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle }),
        }),
      }),
    };
  },
}));

import {
  complianceFooterHtml,
  isEmailSuppressed,
  transactionalEmailSuppressionReason,
} from "../emailCompliance";

describe("complianceFooterHtml", () => {
  it("labels appointment opt-out as optional-email preferences", () => {
    const html = complianceFooterHtml({
      email: "client@example.com",
      salonName: "Hi-Lite Head Spa",
      salonAddress: "123 Main St",
      lang: "en",
      transactional: true,
    });
    expect(html).toContain("important appointment update");
    expect(html).toContain("Manage optional emails");
    expect(html).toContain("Important appointment updates may still be sent");
    expect(html).not.toContain(">Unsubscribe<");
  });
});

describe("isEmailSuppressed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    throwOnClientCreation = false;
    suppressionResult = { data: null, error: null };
    providerSuppressionResult = { data: null, error: null };
  });

  it("does not query or suppress a blank address", async () => {
    await expect(isEmailSuppressed("  ")).resolves.toBe(false);
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("suppresses an address present in the opt-out table", async () => {
    suppressionResult = {
      data: { email: "client@example.com" },
      error: null,
    };

    await expect(
      isEmailSuppressed(" CLIENT@example.com "),
    ).resolves.toBe(true);
  });

  it("allows optional mail only after a successful negative lookup", async () => {
    await expect(
      isEmailSuppressed("client@example.com"),
    ).resolves.toBe(false);
  });

  it("fails closed when Supabase returns an error", async () => {
    suppressionResult = {
      data: null,
      error: { message: "database unavailable" },
    };

    await expect(
      isEmailSuppressed("client@example.com"),
    ).resolves.toBe(true);
  });

  it("fails closed when the service-role client throws", async () => {
    throwOnClientCreation = true;

    await expect(
      isEmailSuppressed("client@example.com"),
    ).resolves.toBe(true);
  });
});

describe("transactionalEmailSuppressionReason", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    throwOnClientCreation = false;
    providerSuppressionResult = { data: null, error: null };
  });

  it("uses provider delivery truth instead of the marketing opt-out table", async () => {
    await expect(
      transactionalEmailSuppressionReason(
        "11111111-1111-4111-8111-111111111111",
        " CLIENT@example.com ",
      ),
    ).resolves.toBeNull();
    expect(maybeSingle).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "customer_email_delivery_suppression_reason",
      expect.objectContaining({
        p_salon_id: "11111111-1111-4111-8111-111111111111",
        p_recipient_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("blocks a provider-suppressed transactional recipient", async () => {
    providerSuppressionResult = { data: "complained", error: null };
    await expect(
      transactionalEmailSuppressionReason(
        "11111111-1111-4111-8111-111111111111",
        "client@example.com",
      ),
    ).resolves.toBe("complained");
  });

  it("throws when provider suppression truth is unavailable", async () => {
    providerSuppressionResult = {
      data: null,
      error: { message: "database unavailable" },
    };
    await expect(
      transactionalEmailSuppressionReason(
        "11111111-1111-4111-8111-111111111111",
        "client@example.com",
      ),
    ).rejects.toEqual({ message: "database unavailable" });
  });
});
