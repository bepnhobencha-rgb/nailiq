import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(), from: vi.fn(), rpc: vi.fn(), serviceClient: vi.fn(),
  terminalRpc: vi.fn(), limit: vi.fn(), after: vi.fn(), audit: vi.fn(),
  resourceMode: vi.fn(), outbound: vi.fn(), report: vi.fn(),
  writes: [] as Array<{ table: string; operation: string; patch: Record<string, unknown> }>,
  filters: [] as Array<[string, unknown]>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/shared/dashboard/setupActions", () => ({ getDashboardWriteClient: mocks.context }));
vi.mock("@/shared/booking/assertBookingLimit", () => ({ assertBookingLimitAvailable: mocks.limit }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.serviceClient }));
vi.mock("@/shared/dashboard/auditLog", () => ({ logBookingEvent: mocks.audit }));
vi.mock("@/shared/observability/errorReporter", () => ({ captureEvent: mocks.report, captureException: mocks.report }));
vi.mock("@/shared/booking/resolveResource", () => ({ getResourceMode: mocks.resourceMode, resolveFreeResource: mocks.outbound }));
vi.mock("@/shared/dashboard/sendOwnerBookingNotification", () => ({ sendOwnerBookingNotification: mocks.outbound }));
vi.mock("@/shared/lib/twilioSms", () => ({ sendSmsReminder: mocks.outbound }));
vi.mock("@/shared/lib/sendCustomerLinkEmail", () => ({ sendCustomerLinkEmail: mocks.outbound }));
vi.mock("@/shared/integrations/square/deposits", () => ({ createDepositForBooking: mocks.outbound }));
vi.mock("@/shared/integrations/wix/writeback", () => ({ pushWixCreate: mocks.outbound, pushWixCancel: mocks.outbound, pushWixConfirm: mocks.outbound, pushWixDecline: mocks.outbound }));

import {
  addWalkinToQueue, addWalkinAndAssign, assignWalkinToSlot,
  updateWalkinContact, cancelWaitingWalkin, undoWalkinAssignment,
  markWalkinInProgress, setSoftHold, clearSoftHold,
} from "@/shared/dashboard/receptionistActions";
import { normalizeSalonMemberRole } from "@/shared/lib/salonMemberRole";

const salonId = "11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const staffId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const bookingId = "66666666-6666-4666-8666-666666666666";
const slug = "e2e-walkin-authorization";
const now = "2026-09-14T17:00:00.000Z";
const phone = "+16045550199";
const createInput = { salonId, serviceId, requestId, clientName: "Synthetic Walkin", clientPhone: phone };
const hours = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(day => [day, { open: "09:00", close: "18:00", closed: false }]));
let role: string | null = "nail_tech";
let replay: Record<string, unknown> | null = null;
let activeAction = "";
let autoAssign = false;
let failInsert = false;

const actions = [
  { name: "addWalkinToQueue", run: (target = salonId) => addWalkinToQueue(slug, { ...createInput, salonId: target }) },
  { name: "addWalkinAndAssign", run: (target = salonId) => addWalkinAndAssign(slug, { ...createInput, salonId: target, staffId }) },
  { name: "assignWalkinToSlot", run: (target = salonId) => assignWalkinToSlot(slug, { salonId: target, bookingId, staffId, slotStartUtc: now }) },
  { name: "updateWalkinContact", run: (target = salonId) => updateWalkinContact(slug, { salonId: target, bookingId, clientPhone: phone }) },
  { name: "cancelWaitingWalkin", run: (target = salonId) => cancelWaitingWalkin(slug, { salonId: target, bookingId }) },
  { name: "undoWalkinAssignment", run: (target = salonId) => undoWalkinAssignment(slug, { salonId: target, bookingId }) },
  { name: "markWalkinInProgress", run: (target = salonId) => markWalkinInProgress(slug, { salonId: target, bookingId }) },
  { name: "setSoftHold", run: (target = salonId) => setSoftHold(slug, { salonId: target, bookingId, minutes: 5 }) },
  { name: "clearSoftHold", run: (target = salonId) => clearSoftHold(slug, { salonId: target, bookingId, reason: "expired" }) },
] as const;

function canonicalReplay() {
  return { id: bookingId, status: "waiting", source: "walkin", service_id: serviceId,
    client_name: createInput.clientName, client_phone: "16045550199", staff_request_note: null,
    staff_requested_by_client: false, walkin_source: null, walkin_priority: null,
    walkin_request_tags: [], party_size: null, joined_queue_at: now };
}

function query(table: string) {
  let operation = "select";
  let columns = "";
  const response = () => {
    if (operation === "insert" && failInsert) return { data: null, error: { code: "LOCAL_INSERT_FAILURE" } };
    if (operation !== "select") return { data: { id: bookingId }, error: null };
    if (table === "salons") return { data: { walkin_auto_assign: autoAssign }, error: null };
    if (table === "services") return { data: { id: serviceId, price_cents: 3500, duration_minutes: 30 }, error: null };
    if (table === "staff") return { data: { id: staffId }, error: null };
    if (table === "bookings") return { data: activeAction === "assignWalkinToSlot" || columns.includes("services!bookings_service_id_fkey")
      ? { id: bookingId, salon_id: salonId, status: "waiting", source: "walkin", service_id: serviceId, services: { duration_minutes: 30, buffer_minutes: 5 } }
      : replay, error: null };
    throw new Error(`Unexpected mocked table: ${table}`);
  };
  const chain = {
    select: (selected: string) => { columns = selected; return chain; },
    eq: (key: string, value: unknown) => { mocks.filters.push([key, value]); return chain; },
    is: (key: string, value: unknown) => { mocks.filters.push([key, value]); return chain; },
    limit: () => chain,
    in: async () => ({ data: [], error: null }),
    insert: (patch: Record<string, unknown>) => { operation = "insert"; mocks.writes.push({ table, operation, patch }); return chain; },
    update: (patch: Record<string, unknown>) => { operation = "update"; mocks.writes.push({ table, operation, patch }); return chain; },
    maybeSingle: async () => response(),
    then: (resolve: (value: ReturnType<typeof response>) => unknown) => Promise.resolve(response()).then(resolve),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.writes.length = 0; mocks.filters.length = 0;
  role = "nail_tech"; replay = null; activeAction = ""; autoAssign = false; failInsert = false;
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubGlobal("fetch", () => { throw new Error("NETWORK_FORBIDDEN"); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.context.mockImplementation(async () => ({ role, kind: "member", userId,
    salon: { id: salonId, name: "Synthetic Local Only", slug, timezone: "America/Vancouver", opening_hours: hours,
      booking_closed_dates: [], subscription_plan: "pro", plan_override: null, feature_flags: {} },
    supabase: { from: mocks.from, rpc: mocks.rpc } }));
  mocks.from.mockImplementation(query);
  mocks.rpc.mockResolvedValue({ data: false, error: null });
  mocks.limit.mockResolvedValue(undefined);
  mocks.resourceMode.mockResolvedValue({ enabled: false });
  mocks.audit.mockResolvedValue(undefined);
  mocks.outbound.mockImplementation(() => { throw new Error("OUTBOUND_FORBIDDEN"); });
  // This is an in-memory terminal receipt, never a real privileged client/RPC.
  mocks.serviceClient.mockReturnValue({ rpc: mocks.terminalRpc });
  mocks.terminalRpc.mockResolvedValue({ data: { success: true, booking: { id: bookingId, salon_id: salonId, service_id: serviceId, previous_status: "waiting", status: "cancelled" } }, error: null });
});
afterEach(() => {
  expect(mocks.outbound).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks();
});

function expectNoWork() {
  expect(mocks.from).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.serviceClient).not.toHaveBeenCalled();
  expect(mocks.terminalRpc).not.toHaveBeenCalled();
  expect(mocks.limit).not.toHaveBeenCalled();
  expect(mocks.resourceMode).not.toHaveBeenCalled();
  expect(mocks.after).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(mocks.writes).toEqual([]);
}

describe.each(actions)("$name server authorization", (action) => {
  it.each(["nail_tech", "unknown_role", null])("rejects resolved role %s before reads, writes, RPC or side effects", async deniedRole => {
    role = deniedRole; activeAction = action.name;
    expect(await action.run()).toEqual({ ok: false, error: "unauthorized" });
    expectNoWork();
  });
  it("rejects a revoked or absent session before work", async () => {
    mocks.context.mockResolvedValue(null);
    expect(await action.run()).toEqual({ ok: false, error: "unauthorized" });
    expectNoWork();
  });
  it("rejects another tenant even for an owner", async () => {
    role = "owner";
    expect(await action.run(staffId)).toEqual({ ok: false, error: "salon_mismatch" });
    expectNoWork();
  });
  it.each(["owner", "admin", "senior", "receptionist"])("preserves permitted %s operation and target binding", async allowedRole => {
    role = allowedRole; activeAction = action.name;
    const result = await action.run();
    expect(result.ok).toBe(true);
    if (action.name === "cancelWaitingWalkin") {
      expect(mocks.writes).toEqual([]);
      expect(mocks.terminalRpc).toHaveBeenCalledExactlyOnceWith("transition_booking_to_terminal_v1", expect.objectContaining({ p_salon_id: salonId, p_booking_id: bookingId, p_actor_user_id: userId, p_actor_role: allowedRole, p_reason: "walkin_removed", p_notify_sms: false, p_notify_email: false }));
    } else {
      expect(mocks.serviceClient).not.toHaveBeenCalled();
      expect(mocks.writes).toHaveLength(1);
      expect(mocks.writes[0].table).toBe("bookings");
      expect(mocks.filters).toContainEqual(["salon_id", salonId]);
      if (action.name.startsWith("addWalkin")) {
        expect(mocks.writes[0]).toMatchObject({ operation: "insert", patch: { salon_id: salonId, source: "walkin", status: "waiting", idempotency_key: requestId } });
        expect(result).toMatchObject({ bookingId });
      } else {
        expect(mocks.writes[0].operation).toBe("update");
        expect(mocks.filters).toContainEqual(["id", bookingId]);
        if (action.name !== "clearSoftHold") {
          expect(mocks.filters).toContainEqual(["source", "walkin"]);
          expect(mocks.filters).toContainEqual(["status", ["undoWalkinAssignment", "markWalkinInProgress"].includes(action.name) ? "confirmed" : "waiting"]);
        }
        if (action.name === "assignWalkinToSlot") expect(mocks.writes[0].patch).toMatchObject({ status: "confirmed", staff_id: staffId, start_time_utc: now, end_time_utc: "2026-09-14T17:35:00.000Z" });
        if (action.name === "undoWalkinAssignment") expect(mocks.writes[0].patch).toMatchObject({ status: "waiting", staff_id: null, start_time_utc: null, end_time_utc: null });
        if (action.name === "markWalkinInProgress") expect(mocks.writes[0].patch).toMatchObject({ status: "in_progress", started_at: now });
        if (action.name === "clearSoftHold") expect(mocks.writes[0].patch).toEqual({ soft_hold_until: null });
      }
    }
  });
});

describe.each(actions.slice(0, 2))("$name replay/recovery ordering", action => {
  it.each(["owner", "admin", "senior", "receptionist"])("returns the same committed receipt for %s without another insert or cap check", async allowedRole => {
    role = allowedRole; replay = canonicalReplay(); mocks.limit.mockRejectedValue(new Error("monthly_booking_limit_reached"));
    const expected = { ok: true, bookingId, bookingStatus: "waiting", replayed: true };
    expect(await action.run()).toEqual(expected);
    expect(await action.run()).toEqual(expected);
    expect(mocks.writes).toEqual([]); expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("does not disclose an existing receipt to Nail Tech after role revocation", async () => {
    replay = canonicalReplay();
    expect(await action.run()).toEqual({ ok: false, error: "unauthorized" }); expectNoWork();
  });
  it("does not invoke archived recovery for a denied role", async () => {
    const recovery = { sourceBookingId: bookingId, requestId, kind: "no_show_walkin" as const };
    const result = action.name === "addWalkinToQueue"
      ? await addWalkinToQueue(slug, { ...createInput, recovery })
      : await addWalkinAndAssign(slug, { ...createInput, staffId, recovery });
    expect(result).toEqual({ ok: false, error: "unauthorized" }); expectNoWork();
  });
  it("preserves the conflict for mismatched replay details", async () => {
    role = "owner"; replay = { ...canonicalReplay(), service_id: staffId };
    expect(await action.run()).toEqual({ ok: false, error: "idempotency_conflict" });
    expect(mocks.writes).toEqual([]); expect(mocks.limit).not.toHaveBeenCalled();
  });
});

it("fails closed after normalization of legacy null or unknown membership roles", async () => {
  for (const raw of [undefined, null, "legacy-manager"]) {
    role = normalizeSalonMemberRole(raw);
    expect(await addWalkinToQueue(slug, createInput)).toEqual({ ok: false, error: "unauthorized" });
  }
  expectNoWork();
});

it("does not trust a client-supplied owner role", async () => {
  const spoofed = { ...createInput, role: "owner" };
  expect(await addWalkinToQueue(slug, spoofed)).toEqual({ ok: false, error: "unauthorized" }); expectNoWork();
});

it("rechecks membership before create if permission changes after the composite flag read", async () => {
  role = "owner";
  mocks.context.mockImplementationOnce(async () => ({ role, kind: "member", userId, salon: { id: salonId }, supabase: { from: mocks.from } }));
  mocks.context.mockResolvedValueOnce(null);
  expect(await addWalkinAndAssign(slug, { ...createInput, staffId })).toEqual({ ok: false, error: "unauthorized" });
  expect(mocks.writes).toEqual([]); expect(mocks.limit).not.toHaveBeenCalled();
});

it("does not assign after a permitted create fails", async () => {
  role = "owner"; autoAssign = true; failInsert = true;
  expect(await addWalkinAndAssign(slug, { ...createInput, staffId })).toEqual({ ok: false, error: "server_error" });
  expect(mocks.writes).toHaveLength(1); expect(mocks.writes[0].operation).toBe("insert");
  expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
});

it.each(["owner", "admin", "senior", "receptionist"])("keeps fresh immediate assignment working for %s", async allowedRole => {
  role = allowedRole; autoAssign = true;
  expect(await addWalkinAndAssign(slug, { ...createInput, staffId, startAtIso: "2026-09-14T17:05:00.000Z" })).toMatchObject({ ok: true, bookingId, assignmentPending: false });
  expect(mocks.writes).toHaveLength(2);
  expect(mocks.writes[0]).toMatchObject({ operation: "insert", patch: { status: "waiting" } });
  expect(mocks.writes[1]).toMatchObject({ operation: "update", patch: { staff_id: staffId, status: "confirmed" } });
  expect(mocks.filters).toContainEqual(["id", bookingId]);
});

it.each(["confirmed", "in_progress", "completed"])("does not assign a second time when the existing receipt is %s", async status => {
  role = "owner"; autoAssign = true; replay = { ...canonicalReplay(), status };
  const expected = { ok: true, bookingId, bookingStatus: status, replayed: true };
  expect(await addWalkinAndAssign(slug, { ...createInput, staffId })).toEqual(expected);
  expect(await addWalkinAndAssign(slug, { ...createInput, staffId })).toEqual(expected);
  expect(mocks.writes).toEqual([]); expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.limit).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
});
