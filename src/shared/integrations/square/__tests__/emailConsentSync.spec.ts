import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SquareConfig } from "../client";

const PROFILE_GRANT = "64000000-0000-4000-8000-000000000001";
const PROFILE_REVOKE = "64000000-0000-4000-8000-000000000002";

const mocks = vi.hoisted(() => ({
  getSquareConfig: vi.fn(),
  listAllCustomers: vi.fn(),
  loadSquareCustomerIdentityMap: vi.fn(),
  namespaceError: null as Record<string, unknown> | null,
  grantError: null as Record<string, unknown> | null,
  revokeError: null as Record<string, unknown> | null,
  identityRows: [] as Array<Record<string, unknown>>,
  writes: [] as Array<Record<string, unknown>>,
  profileRows: [] as Array<{
    id: string;
    marketing_email_consent_at: string | null;
  }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("../client", () => ({
  getSquareConfig: mocks.getSquareConfig,
  listAllCustomers: mocks.listAllCustomers,
}));
vi.mock("../customerIdentity", () => ({
  loadSquareCustomerIdentityMap: mocks.loadSquareCustomerIdentityMap,
}));
vi.mock("../looseDb", () => ({
  looseServiceClient: () => ({
    from: (table: string) => {
      let updateValues: Record<string, unknown> | null = null;
      let profileFilter: string[] | null = null;
      let rangeFrom = 0;
      let rangeTo = 499;
      const query = {
        select: () => query,
        update: (values: Record<string, unknown>) => {
          updateValues = values;
          return query;
        },
        in: (column: string, values: string[]) => {
          if (column === "client_profile_id") profileFilter = values;
          return query;
        },
        is: () => query,
        order: () => query,
        range: (from: number, to: number) => {
          rangeFrom = from;
          rangeTo = to;
          return query;
        },
        then: <TResult1 = unknown, TResult2 = never>(
          onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => {
          if (table === "square_customer_identities") {
            const rows = mocks.identityRows.filter((row) => (
              !profileFilter || profileFilter.includes(String(row.client_profile_id ?? ""))
            )).slice(rangeFrom, rangeTo + 1);
            return Promise.resolve({
              data: mocks.namespaceError ? null : structuredClone(rows),
              error: mocks.namespaceError,
            }).then(onfulfilled, onrejected);
          }
          const isRevoke = updateValues?.marketing_email_consent_at === null;
          if (updateValues) mocks.writes.push(structuredClone(updateValues));
          const result = updateValues
            ? { data: null, error: isRevoke ? mocks.revokeError : mocks.grantError }
            : { data: structuredClone(mocks.profileRows), error: null };
          return Promise.resolve(result).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  }),
}));

import { syncSquareEmailConsent } from "../emailConsentSync";

const config = {
  salonId: "64000000-0000-4000-8000-000000000003",
  merchantId: "merchant-local",
  locationId: "location-local",
  accessToken: "fake-local-token",
  applicationId: "fake-local-app",
  environment: "sandbox",
  currency: "CAD",
  sync: {
    pullCreate: true,
    pullUpdate: true,
    pullCancel: true,
    pushCreate: false,
    pushUpdate: false,
    pushCancel: false,
  },
} satisfies SquareConfig;

const otherMerchantConfig = {
  ...config,
  salonId: "64000000-0000-4000-8000-000000000004",
  merchantId: "merchant-other",
} satisfies SquareConfig;

function identityRow(
  id: string,
  profileId: string,
  cfg: SquareConfig = config,
) {
  return {
    id,
    client_profile_id: profileId,
    provider_environment: cfg.environment,
    provider_merchant_id: cfg.merchantId,
  };
}

describe("Square email consent write truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.namespaceError = null;
    mocks.grantError = null;
    mocks.revokeError = null;
    mocks.identityRows = [];
    mocks.writes.length = 0;
    mocks.profileRows = [];
    mocks.getSquareConfig.mockResolvedValue(config);
  });

  it("returns a stable failure when a consent grant write fails", async () => {
    mocks.listAllCustomers.mockResolvedValue([{
      id: "square-grant",
      email_address: "grant@example.test",
      preferences: { email_unsubscribed: false },
    }]);
    mocks.loadSquareCustomerIdentityMap.mockResolvedValue(new Map([
      ["square-grant", PROFILE_GRANT],
    ]));
    mocks.identityRows = [identityRow("identity-grant", PROFILE_GRANT)];
    mocks.profileRows = [{ id: PROFILE_GRANT, marketing_email_consent_at: null }];
    mocks.grantError = { code: "42501", message: "private database detail" };

    await expect(syncSquareEmailConsent(config.salonId)).resolves.toEqual({
      ok: false,
      squareCustomers: 1,
      granted: 0,
      revoked: 0,
      error: "square_email_consent_grant_update_unavailable",
    });
  });

  it("preserves honest partial counts when a later revoke write fails", async () => {
    mocks.listAllCustomers.mockResolvedValue([
      {
        id: "square-grant",
        email_address: "grant@example.test",
        preferences: { email_unsubscribed: false },
      },
      {
        id: "square-revoke",
        email_address: "revoke@example.test",
        preferences: { email_unsubscribed: true },
      },
    ]);
    mocks.loadSquareCustomerIdentityMap.mockResolvedValue(new Map([
      ["square-grant", PROFILE_GRANT],
      ["square-revoke", PROFILE_REVOKE],
    ]));
    mocks.identityRows = [
      identityRow("identity-grant", PROFILE_GRANT),
      identityRow("identity-revoke", PROFILE_REVOKE),
    ];
    mocks.profileRows = [
      { id: PROFILE_GRANT, marketing_email_consent_at: null },
      { id: PROFILE_REVOKE, marketing_email_consent_at: "2026-01-01T00:00:00.000Z" },
    ];
    mocks.revokeError = { code: "57014", message: "private database detail" };

    await expect(syncSquareEmailConsent(config.salonId)).resolves.toEqual({
      ok: false,
      squareCustomers: 2,
      granted: 1,
      revoked: 0,
      error: "square_email_consent_revoke_update_unavailable",
    });
  });

  it("allows an opt-out but never re-grants a profile linked to another merchant", async () => {
    mocks.getSquareConfig
      .mockResolvedValueOnce(config)
      .mockResolvedValueOnce(otherMerchantConfig);
    mocks.listAllCustomers
      .mockResolvedValueOnce([{
        id: "square-opt-out",
        email_address: "shared@example.test",
        preferences: { email_unsubscribed: true },
      }])
      .mockResolvedValueOnce([{
        id: "square-subscribed",
        email_address: "shared@example.test",
        preferences: { email_unsubscribed: false },
      }]);
    mocks.loadSquareCustomerIdentityMap
      .mockResolvedValueOnce(new Map([["square-opt-out", PROFILE_GRANT]]))
      .mockResolvedValueOnce(new Map([["square-subscribed", PROFILE_GRANT]]));
    mocks.identityRows = [
      identityRow("identity-account-a", PROFILE_GRANT, config),
      identityRow("identity-account-b", PROFILE_GRANT, otherMerchantConfig),
    ];
    mocks.profileRows = [{
      id: PROFILE_GRANT,
      marketing_email_consent_at: "2026-01-01T00:00:00.000Z",
    }];

    await expect(syncSquareEmailConsent(config.salonId)).resolves.toMatchObject({
      ok: true,
      granted: 0,
      revoked: 1,
    });
    mocks.profileRows = [{ id: PROFILE_GRANT, marketing_email_consent_at: null }];
    await expect(syncSquareEmailConsent(otherMerchantConfig.salonId)).resolves.toMatchObject({
      ok: true,
      granted: 0,
      revoked: 0,
    });
    expect(mocks.writes).toEqual([{ marketing_email_consent_at: null }]);
  });

  it("fails closed when cross-merchant namespace lookup is unavailable", async () => {
    mocks.listAllCustomers.mockResolvedValue([{
      id: "square-grant",
      email_address: "grant@example.test",
      preferences: { email_unsubscribed: false },
    }]);
    mocks.loadSquareCustomerIdentityMap.mockResolvedValue(new Map([
      ["square-grant", PROFILE_GRANT],
    ]));
    mocks.namespaceError = { code: "57014", message: "private database detail" };

    await expect(syncSquareEmailConsent(config.salonId)).resolves.toEqual({
      ok: false,
      squareCustomers: 1,
      granted: 0,
      revoked: 0,
      error: "square_email_consent_namespace_lookup_unavailable",
    });
    expect(mocks.writes).toHaveLength(0);
  });
});
