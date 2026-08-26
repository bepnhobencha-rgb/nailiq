import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  loadSquareCustomerIdentityMap,
  resolveSquareCustomerIdentity,
} from "../customerIdentity";
import type { SquareConfig } from "../client";
import type { LooseDb } from "../looseDb";

const PROFILE_ID = "62000000-0000-4000-8000-000000000001";
const cfg: SquareConfig = {
  salonId: "62000000-0000-4000-8000-000000000002",
  merchantId: "merchant-a",
  locationId: "location-a",
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
};

describe("Square customer identity adapter", () => {
  it("performs a lookup-only replay without accepting consent material", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        code: "replayed",
        client_profile_id: PROFILE_ID,
        name: "Local Client",
        phone: "16045550123",
        created_profile: false,
      },
      error: null,
    });
    const db = { rpc } as unknown as LooseDb;

    await expect(resolveSquareCustomerIdentity(db, cfg, {
      customerId: "square-customer-a",
    })).resolves.toEqual({
      clientProfileId: PROFILE_ID,
      name: "Local Client",
      phone: "16045550123",
      createdProfile: false,
    });
    expect(rpc).toHaveBeenCalledWith("resolve_square_customer_identity", {
      p_salon_id: cfg.salonId,
      p_provider_environment: "sandbox",
      p_provider_merchant_id: "merchant-a",
      p_provider_location_id: "location-a",
      p_square_customer_id: "square-customer-a",
      p_phone: null,
      p_name: null,
      p_email: null,
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("consent");
  });

  it("returns not-found, reports exact creates, and hides database detail", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: {
          code: "not_found",
          client_profile_id: null,
          name: null,
          phone: null,
          created_profile: false,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          code: "created_profile",
          client_profile_id: PROFILE_ID,
          name: "New Client",
          phone: "16045550124",
          created_profile: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: "private row detail" },
      });
    const db = { rpc } as unknown as LooseDb;

    await expect(resolveSquareCustomerIdentity(db, cfg, {
      customerId: "square-customer-new",
    })).resolves.toBeNull();
    await expect(resolveSquareCustomerIdentity(db, cfg, {
      customerId: "square-customer-new",
      phone: "16045550124",
      name: "New Client",
      email: "new@example.test",
    })).resolves.toMatchObject({
      clientProfileId: PROFILE_ID,
      createdProfile: true,
    });
    await expect(resolveSquareCustomerIdentity(db, cfg, {
      customerId: "square-customer-private",
    })).rejects.toThrow("square_sync_customer_identity_unavailable");
  });

  it("fails closed on malformed resolver receipts", async () => {
    const db = {
      rpc: vi.fn().mockResolvedValue({
        data: {
          code: "replayed",
          client_profile_id: "not-a-uuid",
          name: null,
          phone: null,
          created_profile: false,
        },
        error: null,
      }),
    } as unknown as LooseDb;

    await expect(resolveSquareCustomerIdentity(db, cfg, {
      customerId: "square-customer-a",
    })).rejects.toThrow("square_sync_customer_identity_response_invalid");
  });

  it("batch maps only the configured environment and merchant", async () => {
    const filters = new Map<string, unknown>();
    let selected = "";
    const query = {
      select: vi.fn((columns: string) => { selected = columns; return query; }),
      eq: vi.fn((column: string, value: unknown) => { filters.set(column, value); return query; }),
      in: vi.fn(() => query),
      then: <TResult1 = unknown>(onfulfilled?: ((value: {
        data: Array<Record<string, unknown>>;
        error: null;
      }) => TResult1 | PromiseLike<TResult1>) | null) => Promise.resolve({
        data: [{
          square_customer_id: "square-customer-a",
          client_profile_id: PROFILE_ID,
        }],
        error: null,
      }).then(onfulfilled),
    };
    const db = {
      from: vi.fn(() => query),
    } as unknown as LooseDb;

    await expect(loadSquareCustomerIdentityMap(
      db,
      cfg,
      ["square-customer-a", "square-customer-a"],
    )).resolves.toEqual(new Map([["square-customer-a", PROFILE_ID]]));
    expect(selected).toBe("square_customer_id, client_profile_id");
    expect(filters).toEqual(new Map([
      ["provider_environment", "sandbox"],
      ["provider_merchant_id", "merchant-a"],
    ]));
  });

  it("never guesses an account for a legacy unscoped provider id", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "supabase/migrations/20260823110500_add_square_customer_identity_links.sql",
    ), "utf8");
    const beforeResolver = migration.slice(
      0,
      migration.indexOf("CREATE FUNCTION public.resolve_square_customer_identity"),
    );

    expect(beforeResolver).toContain("rebuilt lazily from");
    expect(beforeResolver).not.toContain("INSERT INTO public.square_customer_identities");
    expect(beforeResolver).not.toContain("FROM public.client_profiles cp");
  });
});
