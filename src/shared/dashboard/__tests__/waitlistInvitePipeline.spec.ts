import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(), service: vi.fn(), rpc: vi.fn(), from: vi.fn(),
  sms: vi.fn(), email: vi.fn(), suppressed: vi.fn(), fetch: vi.fn(),
  filters: [] as Array<[string, unknown]>,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/shared/dashboard/setupActions", () => ({ getDashboardWriteClient: mocks.context }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.service }));
vi.mock("@/shared/lib/twilioSms", () => ({ sendSmsReminder: mocks.sms }));
vi.mock("@/shared/lib/resend", () => ({
  getResendClient: () => ({ emails: { send: mocks.email } }),
  getResendFrom: () => "QA <qa@example.invalid>",
}));
vi.mock("@/shared/lib/emailCompliance", () => ({
  isEmailSuppressed: mocks.suppressed,
  complianceFooterHtml: () => "<footer>QA</footer>",
  listUnsubscribeHeaders: () => ({}),
}));

// Real action -> real promotion -> real delivery -> real safe projection.
// Auth resolution, RPC persistence and provider adapters are in-memory doubles;
// this suite does NOT certify real Auth/RLS, SQL concurrency or provider delivery.
import { inviteWaitlistEntry } from "@/shared/dashboard/receptionistActions";
import { promoteAndDeliverSpecificWaitlistEntry } from "@/shared/noshow/promoteAndDeliverWaitlistOffer";

const salonId = "11111111-1111-4111-8111-111111111111";
const entryId = "22222222-2222-4222-8222-222222222222";
const fixtureCapabilityId = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";
const slug = "e2e-waitlist-pipeline";
const time = "2099-09-24T19:00:00.000Z";
type Channel = "sms" | "email";
type Row = Record<string, unknown>;
let entry: Row | null;
let readError: boolean;
let promotion: Row;
let materialOverride: Row;
let truthError: boolean;
let truthRows: Row[];
let claims: Set<string>;
const ids = {
  sms: "55555555-5555-4555-8555-555555555555",
  email: "66666666-6666-4666-8666-666666666666",
};

function material(channel: Channel) {
  const recipient = channel === "sms" ? "+16045550123" : "qa@example.invalid";
  return {
    ok: true, code: "material_loaded", material_fingerprint: "a".repeat(64),
    recipient_fingerprint: createHash("sha256").update(recipient).digest("hex"),
    snapshot: {
      salon_id: salonId, waitlist_entry_id: entryId, offer_epoch: 2,
      channel, claim_capability_id: fixtureCapabilityId, salon_name: "Synthetic QA",
      salon_slug: slug, salon_timezone: "America/Los_Angeles", salon_logo_url: null,
      salon_phone: null, sms_outbound_enabled: false, email_outbound_enabled: false,
      locale: "en", service_id: otherId, service_name: "Synthetic Service",
      client_name: "Synthetic Guest", recipient, booking_date: "2099-09-24",
      offered_staff_id: null, staff_name: null, offered_start_utc: null,
      offered_end_utc: null, ...materialOverride,
    },
  };
}

function calls(name: string) {
  return mocks.rpc.mock.calls.filter(([rpc]) => rpc === name);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.filters.length = 0;
  entry = { request_kind: "individual", status: "waiting" };
  readError = false; truthError = false; materialOverride = {}; truthRows = [];
  claims = new Set();
  promotion = { ok: true, code: "promoted", salon_id: salonId,
    waitlist_entry_id: entryId, claim_capability_token: fixtureCapabilityId, offer_epoch: 2 };
  vi.stubEnv("DISABLE_OUTBOUND_SMS", "1");
  vi.stubEnv("DISABLE_OUTBOUND_EMAIL", "1");
  vi.stubEnv("DISABLE_OUTBOUND_CALLS", "1");
  vi.stubEnv("NAILIQ_RESEND_QA_WEBHOOK_ONLY", "0");
  mocks.fetch.mockImplementation(() => { throw new Error("NETWORK_FORBIDDEN"); });
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.sms.mockResolvedValue({ ok: true, suppressed: true, suppressionReason: "provider_stop" });
  mocks.email.mockImplementation(() => { throw new Error("EMAIL_ADAPTER_FORBIDDEN"); });
  mocks.suppressed.mockResolvedValue(true);
  mocks.context.mockResolvedValue({ role: "receptionist", kind: "member", salon: { id: salonId, slug } });
  mocks.from.mockImplementation((table: string) => {
    expect(table).toBe("booking_waitlist_entries");
    const query = {
      select: (columns: string) => { expect(columns).toBe("request_kind, status"); return query; },
      eq: (key: string, value: unknown) => { mocks.filters.push([key, value]); return query; },
      maybeSingle: async () => ({ data: entry, error: readError ? { code: "QA_READ_FAILURE" } : null }),
    };
    return query;
  });
  mocks.service.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
  mocks.rpc.mockImplementation(async (name: string, args: Row) => {
    if (name === "promote_waitlist_entry") return { data: promotion, error: null };
    if (name === "load_waitlist_offer_delivery_material") {
      return { data: material(args.p_channel as Channel), error: null };
    }
    if (name === "claim_waitlist_offer_delivery") {
      const channel = args.p_channel as Channel;
      if (claims.has(channel)) return { data: { ok: false, code: "terminal" }, error: null };
      claims.add(channel);
      return { data: { ok: true, code: "claimed", outbox_id: ids[channel], attempt_token: otherId }, error: null };
    }
    if (name === "complete_waitlist_offer_delivery") {
      truthRows.push({ waitlist_entry_id: entryId, offer_epoch: 2,
        channel: args.p_outbox_id === ids.sms ? "sms" : "email",
        status: args.p_status, error_code: args.p_error_code, updated_at: time });
      return { data: { ok: true, code: "completed" }, error: null };
    }
    if (name === "load_waitlist_offer_delivery_truth") {
      return { data: truthRows, error: truthError ? { code: "QA_TRUTH_FAILURE" } : null };
    }
    throw new Error(`Unexpected mocked RPC: ${name}`);
  });
});

afterEach(() => {
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.email).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe("waitlist invitation server pipeline (no network)", () => {
  it.each([null, "nail_tech", "unknown"])("rejects missing context or role %s before privileged work", async role => {
    mocks.context.mockResolvedValue(role === null ? null : { role, salon: { id: salonId } });
    expect(await inviteWaitlistEntry(slug, entryId)).toEqual({ ok: false, error: "forbidden" });
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "senior", "receptionist"])("preserves authorized %s and exact salon/entry scope", async role => {
    mocks.context.mockResolvedValue({ role, salon: { id: salonId } });
    expect(await inviteWaitlistEntry(slug, ` ${entryId} `)).toMatchObject({ ok: true,
      delivery: { offerEpoch: 2, sms: { status: "suppressed" }, email: { status: "suppressed" } } });
    expect(mocks.context).toHaveBeenCalledWith(slug);
    expect(mocks.filters).toEqual([["salon_id", salonId], ["id", entryId]]);
    expect(calls("promote_waitlist_entry")[0]?.[1]).toEqual({ p_salon_id: salonId, p_waitlist_entry_id: entryId, p_window_minutes: 20 });
    expect(calls("load_waitlist_offer_delivery_truth")[0]?.[1]).toEqual({ p_salon_id: salonId, p_waitlist_entry_ids: [entryId] });
    expect(mocks.sms).not.toHaveBeenCalled();
  });

  it.each(["", "not-an-id", "../../another-salon"])("rejects invalid entry %s before DB access", async id => {
    expect(await inviteWaitlistEntry(slug, id)).toEqual({ ok: false, error: "not_found" });
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it.each(["missing", "read_error"])("does not promote on %s (including a foreign entry filtered out by salon)", async mode => {
    entry = null; readError = mode === "read_error";
    expect(await inviteWaitlistEntry(slug, otherId)).toEqual({ ok: false, error: "not_found" });
    expect(mocks.filters).toContainEqual(["salon_id", salonId]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["claimed", "expired", "cancelled", "review_required"])("does not promote %s entries", async status => {
    entry = { request_kind: "individual", status };
    expect(await inviteWaitlistEntry(slug, entryId)).toEqual({ ok: false, error: "waitlist_plan_required" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["group", "sequence", "unknown"])("routes %s requests away from individual invitation", async request_kind => {
    entry = { request_kind, status: "waiting" };
    expect(await inviteWaitlistEntry(slug, entryId)).toEqual({ ok: false, error: "waitlist_plan_required" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["no_capacity", "waitlist_plan_required", "expired"])("preserves promotion failure %s without sending", async code => {
    promotion = { ok: false, code };
    expect(await inviteWaitlistEntry(slug, entryId)).toEqual({ ok: false, error: code });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("does not expose raw promotion errors with contact details", async () => {
    promotion = { ok: false, code: "error qa@example.invalid +16045550123" };
    expect(await inviteWaitlistEntry(slug, entryId)).toEqual({ ok: false, error: "waitlist_unavailable" });
  });

  it.each(["salon_id", "waitlist_entry_id"])("rejects a mismatched authoritative %s before material/dispatch", async field => {
    promotion[field] = otherId;
    expect(await inviteWaitlistEntry(slug, entryId)).toEqual({ ok: false, error: "invalid_waitlist_response" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("preserves equivalent UUID casing and whitespace accepted by the input contract", async () => {
    const canonicalSalon = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const canonicalEntry = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    promotion = { ...promotion, salon_id: canonicalSalon, waitlist_entry_id: canonicalEntry };
    materialOverride = { salon_id: canonicalSalon, waitlist_entry_id: canonicalEntry };
    expect(await promoteAndDeliverSpecificWaitlistEntry({
      salonId: ` ${canonicalSalon.toUpperCase()} `,
      waitlistEntryId: ` ${canonicalEntry.toUpperCase()} `,
    })).toMatchObject({ ok: true, code: "promoted", salonId: canonicalSalon,
      offer: { waitlistEntryId: canonicalEntry } });
    expect(calls("load_waitlist_offer_delivery_material")).toHaveLength(2);
    expect(calls("complete_waitlist_offer_delivery")).toHaveLength(2);
  });

  it("fails closed on a promotion RPC error", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "private QA error" } });
    expect(await inviteWaitlistEntry(slug, entryId)).toEqual({ ok: false, error: "waitlist_unavailable" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("does not report an invitation when no waiter was promoted", async () => {
    promotion = { ok: true, code: "no_waiter" };
    expect(await inviteWaitlistEntry(slug, entryId)).toEqual({ ok: false, error: "waitlist_invite_unavailable" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, "2", null])("rejects malformed offer epoch %s before material/dispatch", async epoch => {
    promotion.offer_epoch = epoch;
    expect(await inviteWaitlistEntry(slug, entryId)).toEqual({ ok: false, error: "invalid_waitlist_response" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("keeps opt-out and STOP suppressed across an already-notified retry", async () => {
    entry = { request_kind: "individual", status: "notified" };
    // Only in-memory adapters are enabled; both adapters are replaced above.
    vi.stubEnv("DISABLE_OUTBOUND_EMAIL", "0");
    materialOverride = { sms_outbound_enabled: true, email_outbound_enabled: true };
    for (let i = 0; i < 2; i++) expect(await inviteWaitlistEntry(slug, entryId)).toMatchObject({ ok: true,
      delivery: { sms: { status: "suppressed", reason: "recipient_suppressed" },
        email: { status: "suppressed", reason: "recipient_suppressed" } } });
    expect(mocks.sms).toHaveBeenCalledTimes(1);
    expect(mocks.suppressed).toHaveBeenCalledTimes(1);
    expect(calls("complete_waitlist_offer_delivery")).toHaveLength(2);
  });

  it("concurrent action calls obey one in-memory lease per channel", async () => {
    const results = await Promise.all([inviteWaitlistEntry(slug, entryId), inviteWaitlistEntry(slug, entryId)]);
    expect(results.every(x => x.ok)).toBe(true);
    expect(calls("complete_waitlist_offer_delivery")).toHaveLength(2);
    expect(mocks.sms).not.toHaveBeenCalled();
  });

  it.each([null, "", "   "])("cannot claim or report delivered without contact (%s)", async recipient => {
    materialOverride = { recipient };
    expect(await inviteWaitlistEntry(slug, entryId)).toMatchObject({ ok: true,
      delivery: { sms: { status: "unavailable" }, email: { status: "unavailable" } } });
    expect(calls("claim_waitlist_offer_delivery")).toHaveLength(0);
  });

  it("returns unavailable rather than false sent when the receipt read fails", async () => {
    truthError = true;
    expect(await inviteWaitlistEntry(slug, entryId)).toMatchObject({ ok: true,
      delivery: { sms: { status: "unavailable" }, email: { status: "unavailable" } } });
  });

  it("returns safe current-epoch truth and strips contact, capabilities and provider identifiers", async () => {
    materialOverride = { recipient: null };
    truthRows = [
      { waitlist_entry_id: entryId, offer_epoch: 2, channel: "sms", status: "unknown", error_code: "provider_exception",
        updated_at: time, recipient: "+16045550123", provider_receipt: "private-receipt", claim_token: fixtureCapabilityId },
      { waitlist_entry_id: entryId, offer_epoch: 1, channel: "sms", status: "delivered", updated_at: time },
      { waitlist_entry_id: otherId, offer_epoch: 2, channel: "email", status: "delivered", updated_at: time },
    ];
    const result = await inviteWaitlistEntry(slug, entryId);
    expect(result).toMatchObject({ ok: true, delivery: { offerEpoch: 2,
      sms: { status: "unknown", reason: "outcome_unknown" }, email: { status: "unavailable" } } });
    for (const secret of [fixtureCapabilityId, "+16045550123", "private-receipt"]) expect(JSON.stringify(result)).not.toContain(secret);
  });
});
