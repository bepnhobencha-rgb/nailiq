import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), signature: vi.fn(),
  consent: vi.fn(), after: vi.fn(), log: vi.fn(), audit: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => ({
  ...await original<typeof import("next/server")>(), after: mocks.after,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("@/shared/lib/twilioSignature", () => ({
  getTwilioAuthToken: async () => "synthetic-token", validateTwilioSignature: mocks.signature,
  twilioRequestBaseUrl: () => "https://nailiq.test",
}));
vi.mock("@/shared/reminders/smsConsentSuppression", () => ({ recordInboundSmsConsent: mocks.consent }));
vi.mock("@/shared/lib/notificationLog", () => ({ logNotification: mocks.log }));
vi.mock("@/shared/dashboard/auditLog", () => ({ logBookingEvent: mocks.audit }));
import { POST } from "./route";
const applied = { ok: true, code: "applied", idempotent: false,
  booking_id: "30261001-0000-4000-8000-000000000003", salon_id: "30261001-0000-4000-8000-000000000001" };
function request(overrides: Record<string, string | undefined> = {}, search = "", signature = "") {
  const params = { Body: "YES", From: "+16045550101", To: "+16045550999",
    AccountSid: `AC${"a".repeat(32)}`, MessageSid: `SM${"b".repeat(32)}`, ...overrides };
  return new NextRequest(`https://nailiq.test/api/twilio/inbound${search}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  });
}
describe("atomic signed YES confirmation adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv("NAILIQ_ATOMIC_INBOUND_SMS_CONFIRM", "true");
    mocks.signature.mockReturnValue(true); mocks.rpc.mockResolvedValue({ data: applied, error: null });
    mocks.consent.mockResolvedValue({ ok: true });
    mocks.from.mockImplementation(() => { throw Error("legacy_selector_must_not_run"); });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("requires the signature before invoking the command", async () => {
    mocks.signature.mockReturnValue(false);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("validates the full query URL without reordering or decoding it", async () => {
    const search = "?z=last&a=a%2Bb&a=second";
    expect((await POST(request({}, search))).status).toBe(200);
    expect(mocks.signature.mock.calls[0][0]).toBe(`https://nailiq.test/api/twilio/inbound${search}`);
  });
  it("rejects a query mismatch before any command or consent change", async () => {
    mocks.signature.mockImplementation((url: string) => url === "https://nailiq.test/api/twilio/inbound?fixture=signed");
    expect((await POST(request({ Body: "STOP" }, "?fixture=tampered"))).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.consent).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("passes signed identity and exact body hash to the transaction", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Your reply was recorded for this appointment");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("confirm_booking_from_signed_sms", {
      p_account_sid: `AC${"a".repeat(32)}`, p_message_sid: `SM${"b".repeat(32)}`,
      p_from_phone: "+16045550101", p_to_phone: "+16045550999",
      p_body_sha256: createHash("sha256").update("YES").digest("hex"),
    });
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("replay never invokes the mutable selector or duplicate audit", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: applied, error: null })
      .mockResolvedValueOnce({ data: { ...applied, idempotent: true }, error: null });
    expect((await POST(request())).status).toBe(200);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
  });
  it.each(["ambiguous_salon", "not_found", "already_confirmed", "booking_changed"])("acknowledges %s without a fresh selection", async (code) => {
    mocks.rpc.mockResolvedValue({ data: { ...applied, code }, error: null });
    const response = await POST(request()); expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("Your reply was recorded for this appointment");
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
  });
  it("preserves the old SmsMessageSid alias", async () => {
    await POST(request({ MessageSid: undefined, SmsMessageSid: `SM${"c".repeat(32)}` }));
    expect(mocks.rpc.mock.calls[0][1].p_message_sid).toBe(`SM${"c".repeat(32)}`);
  });
  it("does not fall back after a network rejection", async () => {
    mocks.rpc.mockRejectedValue(Error("synthetic failure"));
    expect((await POST(request())).status).toBe(503); expect(mocks.from).not.toHaveBeenCalled();
  });
  it.each([
    { data: null, error: { code: "42883" } }, { data: null, error: null },
    { data: [applied], error: null }, { data: { ...applied, idempotent: undefined }, error: null },
    { data: { ...applied, booking_id: null }, error: null },
    { data: { ...applied, salon_id: "bad" }, error: null },
    { data: { ...applied, code: "unexpected" }, error: null },
    { data: { ok: false, code: "sender_unverified" }, error: null },
    { data: { ok: false, code: "idempotency_mismatch" }, error: null },
  ])("rejects an unavailable or invalid transaction result: %j", async (result) => {
    mocks.rpc.mockResolvedValue(result); expect((await POST(request())).status).toBe(503);
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
  });
  it.each(["STOP", "CANCEL", "START"])("preserves consent priority for %s", async (Body) => {
    expect((await POST(request({ Body }))).status).toBe(200);
    expect(mocks.consent).toHaveBeenCalledTimes(1); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("signed provider OptOutType overrides a YES body", async () => {
    expect((await POST(request({ OptOutType: "STOP" }))).status).toBe(200);
    expect(mocks.consent).toHaveBeenCalledTimes(1); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([undefined, "false", "1", "TRUE"])("remains OFF without literal true: %s", async (flag) => {
    vi.stubEnv("NAILIQ_ATOMIC_INBOUND_SMS_CONFIRM", flag);
    const list = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), gte: vi.fn(), order: vi.fn(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }) };
    for (const method of ["select", "eq", "in", "gte", "order"] as const) list[method].mockReturnValue(list);
    mocks.from.mockReturnValue(list); expect((await POST(request())).status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("real full-URL HMAC across atomic and legacy adapters", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const actual = await vi.importActual<typeof import("@/shared/lib/twilioSignature")>("@/shared/lib/twilioSignature");
    mocks.signature.mockImplementation(actual.validateTwilioSignature);
    mocks.rpc.mockResolvedValue({ data: applied, error: null });
    mocks.consent.mockResolvedValue({ ok: true });
    const query = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), gte: vi.fn(), order: vi.fn(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }) };
    for (const method of ["select", "eq", "in", "gte", "order"] as const) query[method].mockReturnValue(query);
    mocks.from.mockReturnValue(query);
  });
  afterEach(() => vi.unstubAllEnvs());
  const scenarios = ["true", "false"].flatMap((flag) =>
    ["YES", "NO", "STOP", "START"].map((Body) => ({ flag, Body })));
  function signed(Body: string, search: string, signedSearch = search) {
    const params = { Body, From: "+16045550101", To: "+16045550999",
      AccountSid: `AC${"a".repeat(32)}`, MessageSid: `SM${"b".repeat(32)}` };
    const material = `https://nailiq.test/api/twilio/inbound${signedSearch}` +
      Object.keys(params).sort().map((key) => key + params[key as keyof typeof params]).join("");
    return request({ Body }, search, createHmac("sha1", "synthetic-token").update(material).digest("base64"));
  }
  for (const search of ["", "?z=last&a=a%2Bb&a=second"]) {
    it.each(scenarios)(`accepts actual valid HMAC with query ${search}: %j`, async ({ flag, Body }) => {
      vi.stubEnv("NAILIQ_ATOMIC_INBOUND_SMS_CONFIRM", flag);
      vi.stubEnv("NAILIQ_ATOMIC_INBOUND_SMS_CANCEL", flag);
      expect((await POST(signed(Body, search))).status).toBe(200);
      if (Body === "STOP" || Body === "START") {
        expect(mocks.consent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ optOutType: Body }));
        expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled();
      } else if (flag === "false") {
        expect(mocks.from).toHaveBeenCalledExactlyOnceWith("bookings");
        expect(mocks.rpc).not.toHaveBeenCalled();
      } else {
        expect(mocks.rpc).toHaveBeenCalledOnce(); expect(mocks.from).not.toHaveBeenCalled();
      }
    });
  }
  it.each(scenarios)("rejects tampered URL before consent or booking operations: %j", async ({ flag, Body }) => {
    vi.stubEnv("NAILIQ_ATOMIC_INBOUND_SMS_CONFIRM", flag);
    vi.stubEnv("NAILIQ_ATOMIC_INBOUND_SMS_CANCEL", flag);
    expect((await POST(signed(Body, "?fixture=tampered", "?fixture=signed"))).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.consent).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
  });
});
