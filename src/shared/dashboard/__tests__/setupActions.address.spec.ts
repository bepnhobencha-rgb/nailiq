import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  resolveSalonForDashboard: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({
  resolveSalonForDashboard: mocks.resolveSalonForDashboard,
}));
vi.mock("@/shared/lib/demoOtpMode", () => ({
  DEMO_SALON_SLUG: "demo-salon",
  isDemoOtpRuntime: () => false,
  isDemoSlugPinBypassed: () => false,
}));

import { updateAddress } from "../setupActions";

type FakeError = { code: string; message: string };
type FakeResult = {
  data?: unknown;
  error?: FakeError | null;
  count?: number | null;
};

type RecordedUpdate = { table: string; payload: unknown };

class FakeQuery {
  constructor(
    private readonly table: string,
    private readonly result: FakeResult,
    private readonly updates: RecordedUpdate[],
  ) {}

  select(): this {
    return this;
  }

  update(payload: unknown): this {
    this.updates.push({ table: this.table, payload });
    return this;
  }

  eq(): this {
    return this;
  }

  is(): this {
    return this;
  }

  maybeSingle(): Promise<FakeResult> {
    return Promise.resolve(this.result);
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?:
      | ((value: FakeResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onFulfilled, onRejected);
  }
}

function fakeSupabase(results: FakeResult[]) {
  const queue = [...results];
  const updates: RecordedUpdate[] = [];
  const from = vi.fn((table: string) => {
    const result = queue.shift();
    if (!result) throw new Error(`Unexpected query for ${table}`);
    return new FakeQuery(table, result, updates);
  });

  return { client: { from }, from, updates };
}

const VALID_ADDRESS = {
  name: "Guided Resume Test Salon",
  street: "123 QA Main Street",
  city: "Vancouver",
  province: "BC",
  postal: "V6B 1A1",
  country: "Canada",
  salon_phone: "+1 604 555 0198",
  timezone: "America/Vancouver",
};

const UPDATED_SALON = {
  data: { id: "salon-1" },
  error: null,
} satisfies FakeResult;
const SAVED_ADDRESS = {
  data: { address: "123 QA Main Street, Vancouver, BC, V6B 1A1, Canada" },
  error: null,
} satisfies FakeResult;
const ONE_ACTIVE_ROW = {
  data: null,
  count: 1,
  error: null,
} satisfies FakeResult;

describe("updateAddress profile completion refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue({ get: () => undefined });
    mocks.resolveSalonForDashboard.mockResolvedValue({
      kind: "member",
      role: "owner",
      salon: { id: "salon-1", slug: "qa-salon" },
    });
  });

  it("reports success only after data-derived profile_complete is persisted", async () => {
    const db = fakeSupabase([
      UPDATED_SALON,
      SAVED_ADDRESS,
      ONE_ACTIVE_ROW,
      ONE_ACTIVE_ROW,
      UPDATED_SALON,
    ]);
    mocks.createClient.mockResolvedValue(db.client);

    await expect(updateAddress("qa-salon", VALID_ADDRESS)).resolves.toEqual({
      ok: true,
    });

    expect(db.from.mock.calls.map(([table]) => table)).toEqual([
      "salons",
      "salons",
      "services",
      "staff",
      "salons",
    ]);
    expect(db.updates.at(-1)).toEqual({
      table: "salons",
      payload: { profile_complete: true },
    });
  });

  it.each([
    {
      name: "salon address read",
      stage: "salon_read",
      refreshResults: [
        { data: null, error: { code: "42501", message: "read denied" } },
      ],
    },
    {
      name: "service count",
      stage: "service_count",
      refreshResults: [
        SAVED_ADDRESS,
        { count: null, error: { code: "XX000", message: "count failed" } },
      ],
    },
    {
      name: "staff count",
      stage: "staff_count",
      refreshResults: [
        SAVED_ADDRESS,
        ONE_ACTIVE_ROW,
        { count: null, error: { code: "XX000", message: "count failed" } },
      ],
    },
    {
      name: "profile_complete update error",
      stage: "profile_update",
      refreshResults: [
        SAVED_ADDRESS,
        ONE_ACTIVE_ROW,
        ONE_ACTIVE_ROW,
        { data: null, error: { code: "42501", message: "update denied" } },
      ],
    },
    {
      name: "profile_complete zero-row update",
      stage: "profile_update",
      refreshResults: [
        SAVED_ADDRESS,
        ONE_ACTIVE_ROW,
        ONE_ACTIVE_ROW,
        { data: null, error: null },
      ],
    },
  ])("fails closed when the $name fails", async ({ stage, refreshResults }) => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const db = fakeSupabase([UPDATED_SALON, ...refreshResults]);
    mocks.createClient.mockResolvedValue(db.client);

    await expect(updateAddress("qa-salon", VALID_ADDRESS)).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[refreshSalonProfileComplete]",
      expect.objectContaining({ stage }),
    );

    consoleError.mockRestore();
  });

  it("does not report success when the address update matches no salon row", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const db = fakeSupabase([{ data: null, error: null }]);
    mocks.createClient.mockResolvedValue(db.client);

    await expect(updateAddress("qa-salon", VALID_ADDRESS)).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(db.from).toHaveBeenCalledTimes(1);

    consoleError.mockRestore();
  });
});
