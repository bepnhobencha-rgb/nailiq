import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { readCardSandboxConfig } from "../../../../scripts/qa-square-card-sandbox-guard";
import { createRemovalSandboxGuard, REMOVAL_QA_ORIGIN } from "../../../../scripts/qa-square-removal-sandbox-guard";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/shared/integrations/square/looseDb", () => ({ looseServiceClient: () => db }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: async (salonId: string) => {
  if (!fixture || salonId !== fixture.salonId || !config) throw new Error("sandbox_tenant_denied");
  const { SquareProvider } = await import("@/shared/integrations/payments/square");
  return new SquareProvider({ ...config.square, salonId });
} }));
vi.mock("@/shared/integrations/square/client", async original => ({
  ...await original<typeof import("@/shared/integrations/square/client")>(),
  getSquareConfig: async (_db: unknown, salonId: string) => {
    if (!fixture || salonId !== fixture.salonId || !config) throw new Error("sandbox_tenant_denied");
    return { ...config.square, salonId };
  },
}));
import { reconcileOwnerBookingCardRemoval } from "../reconcileBookingCardRemoval";
import { removeCardWithManagementCapability, saveCardWithManagementCapability } from "../bookingCardManagement";

const enabled = process.env.NAILIQ_REMOVAL_SANDBOX_QA === "1";
const ownerReplacement = enabled && process.env.NAILIQ_OWNER_REMOVAL_REPLACED_LINK_QA === "1";
const ownerStale = ownerReplacement && process.env.NAILIQ_OWNER_REMOVAL_STALE_QA === "1";
const activeCard = ownerReplacement && process.env.NAILIQ_OWNER_REMOVAL_ACTIVE_QA === "1";
let ownerId: string | undefined;
// Existing card guard validates its own local test configuration. Only its
// provider transport is composed here; no requests reach that local database.
const config = enabled ? readCardSandboxConfig(JSON.parse(process.env.NAILIQ_SANDBOX_GUARD_ENV ?? "{}")) : null;
const nativeFetch = globalThis.fetch;
const guard = config ? createRemovalSandboxGuard(config, nativeFetch) : null;
const db = createClient(REMOVAL_QA_ORIGIN, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "unused-opt-in-key", { auth: { persistSession: false, autoRefreshToken: false } });
let fixture: Awaited<ReturnType<typeof import("../../../../e2e/receptionist-center/helpers").seedReceptionistCenterFixture>> | undefined;
let journal: number | undefined;
const completed: { bookingId: string; token: string; requestId: string; fingerprint: string; mode: string }[] = [];
const evidence = process.env.NAILIQ_QA_ARTIFACT_DIR ?? "";
function note(value: Record<string, unknown>) {
  if (journal === undefined) throw new Error("sandbox_journal_required");
  appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n");
}
async function rpc(name: string, args: Record<string, unknown>) {
  const r = await db.rpc(name, args); if (r.error) throw new Error("disposable_qa_rpc_failed"); return r.data;
}
async function bookingState(id: string) {
  const r = await db.from("bookings").select("status,card_protection_status,noshow_card_id,noshow_customer_id,noshow_card_brand,noshow_card_last4,noshow_consent_at,noshow_consent_meta").eq("id", id).eq("salon_id", fixture!.salonId).single();
  expect(r.error).toBeNull(); return r.data!;
}
describe.skipIf(!enabled)("Actual Square Sandbox save then removal delivery", () => {
  beforeAll(async () => {
    if (!guard || !config || !isAbsolute(evidence) || process.env.NEXT_PUBLIC_SUPABASE_URL !== REMOVAL_QA_ORIGIN || process.env.SUPABASE_INTERNAL_URL !== REMOVAL_QA_ORIGIN) throw new Error("disposable_qa_required");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!; const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString());
    if (claims.ref !== "osdqutwunokiielbairj" || claims.role !== "service_role") throw new Error("disposable_qa_key_required");
    if (["DISABLE_OUTBOUND_SMS", "DISABLE_OUTBOUND_EMAIL", "DISABLE_OUTBOUND_CALLS"].some(k => process.env[k] !== "1") || ["PAYMENT_LEDGER_WORKERS_ENABLED", "NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH", "NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH"].some(k => process.env[k] !== "false")) throw new Error("outbound_and_charges_must_be_off");
    journal = openSync(`${evidence}/operations.jsonl`, "wx", 0o600);
    note({ event: "started", notificationMode: config.notificationMode, database: "disposable-hosted-qa", provider: "square-sandbox" });
    await guard.preflight(); note({ event: "identity_location_webhooks_verified" });
    if (ownerReplacement) {
      const owner = await db.auth.admin.createUser({ email: `qa-removal-${randomUUID()}@example.com`, password: `${randomUUID()}Aa1!`, email_confirm: true });
      expect(owner.error).toBeNull(); ownerId = owner.data.user!.id;
      note({ event: "qa_owner_created", userId: ownerId });
    }
    vi.stubGlobal("fetch", guard.fetch);
    const { seedReceptionistCenterFixture } = await import("../../../../e2e/receptionist-center/helpers");
    fixture = await seedReceptionistCenterFixture(`e2e-p003-squareremoval-${randomUUID()}`);
    note({ event: "fixture", salonId: fixture.salonId, slug: fixture.slug });
    writeFileSync(`${evidence}/fixture-history.jsonl`, JSON.stringify({ salons: [{ id: fixture.salonId, slug: fixture.slug }], users: ownerId ? [ownerId] : [] }) + "\n", { flag: "wx", mode: 0o600 });
    if (ownerId) expect((await db.from("salon_members").insert({ salon_id: fixture.salonId, user_id: ownerId, role: "owner" })).error).toBeNull();
    expect((await db.from("salons").update({ payment_provider: "square", currency_code: "CAD", noshow_protection_enabled: true, cancellation_policy: { en: "Cancel with 24 hours notice.", vi: "Báo trước 24 giờ khi hủy." } }).eq("id", fixture.salonId)).error).toBeNull();
  }, 60000);
  afterAll(async () => {
    vi.unstubAllGlobals();
    try {
      if (ownerId) {
        if (fixture) expect((await db.from("salon_members").delete().eq("salon_id", fixture.salonId).eq("user_id", ownerId)).error).toBeNull();
        // Retain the actor referenced by the immutable recovery receipt, but
        // disable its synthetic login and remove all test-salon membership.
        expect((await db.auth.admin.updateUserById(ownerId, { ban_duration: "876000h" })).error).toBeNull();
        note({ event: "qa_owner_disabled", userId: ownerId });
      }
    } finally { if (journal !== undefined) { note({ event: "run_finished", counts: guard?.counts() }); closeSync(journal); } }
  });
  it.each(activeCard ? ["not_dispatched"] as const : ownerStale ? ["db_before"] as const : ownerReplacement ? ["response_loss"] as const : ["success", "response_loss", "db_before", "db_after"] as const)("%s: provider truth and replay without another mutation", async mode => {
    guard!.setMode("success");
    const id = randomUUID(); const start = Date.now() + 14 * 86400000 + completed.length * 7200000;
    note({ event: "booking_planned", bookingId: id, mode });
    const inserted = await db.from("bookings").insert({ id, salon_id: fixture!.salonId, service_id: fixture!.serviceIds[0], staff_id: fixture!.staffIds[0],
      client_name: "Synthetic Sandbox", client_phone: "", client_email: `synthetic-${id}@example.com`,
      status: "confirmed", source: "appointment", price_cents: 5000, noshow_card_required: true, noshow_fee_cents: 1000,
      start_time_utc: new Date(start).toISOString(), end_time_utc: new Date(start + 3600000).toISOString() }); expect(inserted.error).toBeNull();
    const mint = () => rpc("mint_booking_management_capability", { p_salon_id: fixture!.salonId, p_booking_id: id, p_action: "card_manage", p_min_expires_at: new Date(Date.now() + 1500000).toISOString() });
    const saveCap = await mint(); expect(saveCap.ok).toBe(true);
    const save = await saveCardWithManagementCapability({ tokenId: saveCap.token_id, requestId: randomUUID(), provider: "square", sourceToken: "cnon:card-nonce-ok" }); expect(save.ok).toBe(true);
    const saved = await bookingState(id); expect(saved.card_protection_status).toBe("saved"); expect(saved.noshow_consent_at).toBeTruthy(); expect(saved.noshow_consent_meta.policyVersion).toMatch(/^nsp_[a-f0-9]{64}$/);
    const cap = await mint(); expect(cap.ok).toBe(true);
    const material = await db.from("booking_management_capabilities").select("card_state_fingerprint").eq("id", cap.token_id).single(); expect(material.error).toBeNull();
    const input = { tokenId: cap.token_id as string, requestId: randomUUID(), expectedCardFingerprint: material.data!.card_state_fingerprint as string };
    writeFileSync(`${evidence}/${mode}-intent.private.json`, JSON.stringify({ bookingId: id, ...input }), { flag: "wx", mode: 0o600 });
    let interceptedDisableAttempts = 0;
    if (ownerReplacement) {
      let replaced = false;
      vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
        if (!replaced && url.hostname === "connect.squareupsandbox.com" && url.pathname.endsWith("/disable") && init?.method === "POST") {
          replaced = true;
          // Replace after durable preparation, before the actual guarded
          // DisableCard call. No provider response or timing race is mocked here.
          const replacement = await rpc("mint_booking_management_capability", { p_salon_id: fixture!.salonId, p_booking_id: id, p_action: "card_manage", p_min_expires_at: new Date(Date.now() + 1700000).toISOString() });
          expect(replacement.ok).toBe(true); expect(replacement.token_id).not.toBe(input.tokenId);
          note({ event: "link_replaced_before_provider_write", bookingId: id });
        }
        if (activeCard && url.hostname === "connect.squareupsandbox.com" && url.pathname.endsWith("/disable") && init?.method === "POST") {
          // Simulate a transport failure before Square receives the request.
          // Count every attempt so a blind redispatch cannot be hidden by the simulation.
          interceptedDisableAttempts++;
          throw new Error("qa_disable_not_dispatched");
        }
        return guard!.fetch(request, init);
      });
    }
    const before = guard!.counts(); guard!.setMode(mode === "not_dispatched" ? "success" : mode);
    const concurrent = mode === "success"
      ? await Promise.all(Array.from({ length: 3 }, () => removeCardWithManagementCapability(input))) : null;
    if (concurrent) {
      expect(concurrent.some(r => r.ok && r.code === "removed")).toBe(true);
      expect(concurrent.every(r => r.code === "removed" || r.code === "in_flight")).toBe(true);
      note({ event: "concurrent_requests", results: concurrent.map(r => r.code) });
    }
    const first = concurrent?.find(r => r.ok) ?? await removeCardWithManagementCapability(input);
    const operation = await db.from("booking_card_management_operations").select("id,status,error_code").eq("booking_id", id).single(); expect(operation.error).toBeNull();
    note({ event: "first_removal", bookingId: id, operationId: operation.data!.id, mode, result: first.code, status: operation.data!.status, errorCode: operation.data!.error_code, counts: guard!.counts() });
    if (mode === "success") expect(first).toMatchObject({ ok: true, code: "removed" });
    else expect(first.ok).toBe(false);
    if (mode === "response_loss") {
      expect(operation.data!.status).toBe("unknown"); expect((await bookingState(id)).noshow_card_id).toBe(saved.noshow_card_id);
    }
    guard!.setMode("success");
    if (mode === "db_before" && !ownerStale) {
      expect((await removeCardWithManagementCapability(input)).code).toBe("in_flight");
      const binding = await db.from("booking_card_removal_dispatch_bindings").select("prepared_at").eq("operation_id", operation.data!.id).single();
      expect(binding.error).toBeNull();
      await new Promise(resolve => setTimeout(resolve, Math.max(0, new Date(binding.data!.prepared_at).getTime() + 122000 - Date.now())));
    }
    const ownerInput = { salonId: fixture!.salonId, operationId: operation.data!.id as string, actorId: ownerId ?? "" };
    if (ownerReplacement) {
      const beforeDenied = guard!.counts();
      expect((await removeCardWithManagementCapability(input)).code).toBe(ownerStale ? "removal_dispatch_unavailable" : "remove_unknown");
      expect(guard!.counts()).toEqual(beforeDenied);
      const retired = await db.from("booking_management_capabilities").select("revoked_at,revoke_reason").eq("id", input.tokenId).single();
      expect(retired.error).toBeNull(); expect(retired.data?.revoke_reason).toBe("replaced_for_longer_expiry"); expect(retired.data?.revoked_at).toBeTruthy();
    }
    if (ownerStale) {
      expect(await reconcileOwnerBookingCardRemoval(ownerInput)).toEqual({ ok: false, code: "in_flight" });
      const binding = await db.from("booking_card_removal_dispatch_bindings").select("prepared_at").eq("operation_id", operation.data!.id).single();expect(binding.error).toBeNull();
      await new Promise(resolve => setTimeout(resolve, Math.max(0, new Date(binding.data!.prepared_at).getTime() + 122000 - Date.now())));
    }
    if (activeCard) {
      expect(first.code).toBe("remove_unknown"); expect(operation.data!.status).toBe("unknown");
      const previousEvents = await db.from("booking_card_removal_recovery_events").select("id").eq("operation_id",operation.data!.id);
      expect(previousEvents.error).toBeNull();
      const beforeReads = guard!.counts();
      expect(interceptedDisableAttempts).toBe(1); expect(beforeReads.disableCalls).toBe(0);
      const outcomes = await Promise.all([reconcileOwnerBookingCardRemoval(ownerInput), reconcileOwnerBookingCardRemoval(ownerInput)]);
      expect(outcomes).toEqual([{ok:false,code:"remove_unknown"},{ok:false,code:"remove_unknown"}]);
      expect(interceptedDisableAttempts).toBe(1);
      expect(guard!.counts()).toMatchObject({disableCalls:0,removalReads:beforeReads.removalReads+2,cardCreates:beforeReads.cardCreates,customerCreates:beforeReads.customerCreates});
      expect(await bookingState(id)).toEqual(saved);
      const final = await db.from("booking_card_management_operations").select("id,status,error_code").eq("id", operation.data!.id).single();
      expect(final.error).toBeNull(); expect(final.data).toEqual(operation.data);
      const events = await db.from("booking_card_removal_recovery_events").select("code,read_status,retryability").eq("operation_id",operation.data!.id);
      expect(events.error).toBeNull();expect(events.data).toHaveLength(previousEvents.data!.length + 2);
      expect(events.data!.filter(e=>e.code==="reconciliation_card_active" && e.read_status==="completed" && e.retryability==="manual_review")).toHaveLength(2);
      const receipts = await db.from("booking_card_removal_recovery_receipts").select("operation_id").eq("operation_id",operation.data!.id);
      expect(receipts.error).toBeNull();expect(receipts.data).toEqual([]);
      // A replacement link is not authority to retry while the original result is uncertain.
      const replacement = await mint();expect(replacement.ok).toBe(true);
      const beforeReplay = guard!.counts();
      const blocked = await removeCardWithManagementCapability({...input,tokenId:replacement.token_id,requestId:randomUUID()});
      expect(blocked.ok).toBe(false);expect(guard!.counts()).toEqual(beforeReplay);expect(interceptedDisableAttempts).toBe(1);
      expect(await bookingState(id)).toEqual(saved);
      note({event:"active_card_case_passed",bookingId:id,operationId:operation.data!.id,mode,counts:guard!.counts(),interceptedDisableAttempts,replacementResult:blocked.code,providerReceipt:"actual_square_sandbox_active",simulation:"transport_before_dispatch",recoveryReceipts:0});
      return;
    }
    const recovered = ownerReplacement ? await reconcileOwnerBookingCardRemoval(ownerInput) : await removeCardWithManagementCapability(input); expect(recovered).toMatchObject({ ok: true, code: "removed" });
    const after = guard!.counts(); expect(after.disableCalls - before.disableCalls).toBe(1); expect(after.deniedDuplicateDisables).toBe(0);
    expect(after.cardCreates).toBe(before.cardCreates); expect(after.customerCreates).toBe(before.customerCreates);
    const state = await bookingState(id); expect(state.status).toBe("confirmed"); expect(state.noshow_card_id).toBeNull(); expect(state.noshow_customer_id).toBeNull(); expect(state.card_protection_status).toBe("retry_required");
    expect(ownerReplacement ? await reconcileOwnerBookingCardRemoval(ownerInput) : await removeCardWithManagementCapability(input)).toMatchObject({ ok: true, code: "removed", idempotent: true }); expect(guard!.counts()).toEqual(after);
    if (mode === "response_loss") {
      const final = await db.from("booking_card_management_operations").select("id,status,error_code").eq("id", operation.data!.id).single(); expect(final.data).toEqual(operation.data);
      const receipt = await db.from("booking_card_removal_recovery_receipts").select("operation_id").eq("operation_id", operation.data!.id); expect(receipt.data).toHaveLength(1);
    }
    if (ownerStale) {
      const final = await db.from("booking_card_management_operations").select("status,error_code").eq("id", operation.data!.id).single();expect(final.error).toBeNull();expect(final.data).toEqual({status:"unknown",error_code:"removal_dispatch_outcome_uncertain"});
    }
    completed.push({ bookingId: id, token: input.tokenId, requestId: input.requestId, fingerprint: input.expectedCardFingerprint, mode });
    writeFileSync(`${evidence}/completed.private.json`, JSON.stringify(completed), { mode: 0o600 });
    note({ event: "case_passed", mode, counts: after, providerReceipt: "actual_square_sandbox", simulation: mode !== "success" });
  }, 180000);
});
