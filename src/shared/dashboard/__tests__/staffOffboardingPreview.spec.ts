import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  getDashboardWriteClient: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));

import { loadStaffOffboardingPreview } from "../staffOffboardingActions";

type Row = Record<string, unknown>;
type Filter = {
  kind: "eq" | "is" | "in" | "not" | "lt" | "gt";
  column: string;
  value: unknown;
  operator?: string;
};
type FakeResult = { data: Row[] | Row | null; error: null };

class FakeQuery {
  readonly filters: Filter[] = [];
  private returnSingle = false;

  constructor(
    readonly table: string,
    private readonly rows: Row[],
  ) {}

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push({ kind: "is", column, value });
    return this;
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ kind: "in", column, value });
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    this.filters.push({ kind: "not", column, operator, value });
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filters.push({ kind: "lt", column, value });
    return this;
  }

  gt(column: string, value: unknown): this {
    this.filters.push({ kind: "gt", column, value });
    return this;
  }

  order(): this {
    return this;
  }

  single(): this {
    this.returnSingle = true;
    return this;
  }

  maybeSingle(): this {
    this.returnSingle = true;
    return this;
  }

  private result(): FakeResult {
    const data = this.rows.filter((row) =>
      this.filters.every((filter) => {
        const actual = row[filter.column];
        if (filter.kind === "eq") return actual === filter.value;
        if (filter.kind === "is") {
          return filter.value === null ? actual == null : actual === filter.value;
        }
        if (filter.kind === "in") {
          return (filter.value as unknown[]).includes(actual);
        }
        if (filter.kind === "not" && filter.operator === "in") {
          const values = String(filter.value)
            .replace(/[()]/g, "")
            .replaceAll(String.fromCharCode(34), "")
            .split(",");
          return !values.includes(String(actual));
        }
        if (filter.kind === "lt") return String(actual) < String(filter.value);
        if (filter.kind === "gt") return String(actual) > String(filter.value);
        return true;
      }),
    );
    return {
      data: this.returnSingle ? (data[0] ?? null) : data,
      error: null,
    };
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?:
      | ((value: FakeResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result()).then(onFulfilled, onRejected);
  }
}

function fakeServiceClient(rows: Record<string, Row[]>) {
  const queries: FakeQuery[] = [];
  return {
    queries,
    client: {
      from: vi.fn((table: string) => {
        const query = new FakeQuery(table, rows[table] ?? []);
        queries.push(query);
        return query;
      }),
    },
  };
}

const SALON_ID = "d6800000-0000-4000-8000-000000000001";
const TARGET_ID = "d6800000-0000-4000-8000-000000000020";
const CANDIDATE_ID = "d6800000-0000-4000-8000-000000000021";

describe("staff offboarding preview parent scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDashboardWriteClient.mockResolvedValue({
      kind: "member",
      role: "owner",
      userId: "d6800000-0000-4000-8000-000000000030",
      salon: { id: SALON_ID, slug: "preview-test", timezone: "UTC" },
    });
  });

  it.each(["pending", "confirmed"])(
    "excludes a soft-deleted %s single booking so preview matches the atomic RPC",
    async (status) => {
      const db = fakeServiceClient({
        staff: [
          {
            id: TARGET_ID,
            salon_id: SALON_ID,
            name: "Departing",
            status: "active",
            user_id: null,
            deleted_at: null,
          },
          {
            id: CANDIDATE_ID,
            salon_id: SALON_ID,
            name: "Replacement",
            status: "active",
            user_id: null,
            deleted_at: null,
          },
        ],
        salons: [
          {
            id: SALON_ID,
            email_outbound_enabled: false,
            sms_outbound_enabled: false,
          },
        ],
        booking_service_segments: [],
        bookings: [
          {
            id: "d6800000-0000-4000-8000-000000000040",
            salon_id: SALON_ID,
            staff_id: TARGET_ID,
            service_id: "d6800000-0000-4000-8000-000000000010",
            addon_service_id: null,
            client_name: "Soft deleted guest",
            client_phone: "+16045550680",
            client_email: "deleted@example.test",
            start_time_utc: "2026-09-01T17:00:00.000Z",
            end_time_utc: "2026-09-01T17:30:00.000Z",
            status,
            schedule_model: "single",
            deleted_at: "2026-08-22T00:00:00.000Z",
          },
        ],
        services: [
          {
            id: "d6800000-0000-4000-8000-000000000010",
            salon_id: SALON_ID,
            name: "Deleted booking service",
          },
        ],
        staff_services: [],
      });
      mocks.createServiceRoleClient.mockReturnValue(db.client);

      const result = await loadStaffOffboardingPreview("preview-test", TARGET_ID);

      expect(result.ok).toBe(true);
      if (!result.ok || !("preview" in result)) throw new Error("preview missing");
      expect(result.preview.bookings).toEqual([]);
      const targetParentQuery = db.queries.find(
        (query) =>
          query.table === "bookings" &&
          query.filters.some(
            (filter) =>
              filter.kind === "eq" &&
              filter.column === "staff_id" &&
              filter.value === TARGET_ID,
          ),
      );
      expect(targetParentQuery?.filters).toContainEqual({
        kind: "is",
        column: "deleted_at",
        value: null,
      });
    },
  );
});
