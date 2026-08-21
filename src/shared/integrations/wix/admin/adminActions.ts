"use server";

/**
 * Self-service Wix onboarding — owner-facing server actions.
 *
 * Lets a salon owner connect their own Wix site from Admin Settings by pasting an
 * API key + site ID (no env vars, no deploy):
 *   1. testWixConnection  — verify a pasted key reaches Wix
 *   2. saveWixCredentials — store key + site ID (per-salon, masked in the UI)
 *   3. autoMapWixCatalog  — match/create NailIQ services + staff from Wix
 *   4. importWixBookings  — pull existing Wix bookings into NailIQ
 *   5. setWixEnabled / setWixAutoApprove — toggles
 *
 * All actions are OWNER-ONLY. Secrets are never echoed back (getWixStatus returns
 * booleans / masks, never the raw key).
 */
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { looseServiceClient } from "../looseDb";
import { wixPostWithKey, invalidateWixKeyCache } from "../client";
import { categorizeService } from "../categorize";
import { runForwardSync } from "../sync";
import { resolveWixEnabledOnCredentialSave } from "../credentialDefaults";
import type { WixStatus } from "./types";

const SERVICES_QUERY = "https://www.wixapis.com/bookings/v2/services/query";
const RESOURCES_QUERY = "https://www.wixapis.com/bookings/v1/resources/query";

type Fail = { ok: false; error: string };

interface WixSvc {
  id: string;
  name?: string;
  schedule?: { id?: string };
  schedules?: Array<{ id?: string }>;
  category?: { name?: string };
  payment?: {
    rateType?: string; // "FIXED" | "CUSTOM" | "NO_FEE" | ...
    fixed?: { price?: { value?: string } };
    custom?: { description?: string }; // e.g. "From $35", "$50+"
  };
}

/**
 * Best-effort price (in cents) from a Wix service.
 * - FIXED  → payment.fixed.price.value (e.g. "47" → 4700)
 * - CUSTOM → the first number in the description (e.g. "From $35" → 3500), a
 *   sensible STARTING price so the service never shows $0 (owner can refine).
 * Returns null when no number can be derived.
 */
function wixServicePriceCents(svc: WixSvc): number | null {
  const pay = svc.payment;
  if (!pay) return null;
  if (pay.rateType === "FIXED") {
    const v = Number(pay.fixed?.price?.value);
    return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
  }
  if (pay.rateType === "CUSTOM") {
    const m = String(pay.custom?.description ?? "").match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const v = Number(m[1]);
      return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
    }
  }
  return null;
}
interface WixRes {
  id?: string;
  name?: string;
  tags?: string[];
  resource?: { id?: string; name?: string; tags?: string[] };
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const titleCase = (s: string) =>
  s.trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Service";
const stripKey = (s: unknown) => String(s ?? "").replace(/\s+/g, "");
const isMasked = (s: string) => s.includes("•"); // '•' — the UI shows this for an unchanged secret

/** Resolve the owner-scoped context, or null if the caller is not this salon's owner. */
async function ownerCtx(slug: string) {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return null;
  if (ctx.role !== "owner") return null;
  return ctx;
}

// ---------------------------------------------------------------------------
// Status (safe to expose — no raw secrets)
// ---------------------------------------------------------------------------
export async function getWixStatus(slug: string): Promise<{ ok: true; status: WixStatus } | Fail> {
  const ctx = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  const db = looseServiceClient();
  const salonId = ctx.salon.id;

  const { data: integ } = await db
    .from("wix_integrations")
    .select("site_id, enabled, auto_approve, wix_api_key, wix_webhook_public_key, last_run_at, last_error, webhook_last_received_at")
    .eq("salon_id", salonId)
    .maybeSingle();

  const { data: svc } = await db.from("services").select("wix_service_id").eq("salon_id", salonId);
  const { data: stf } = await db.from("staff").select("wix_resource_id").eq("salon_id", salonId);

  const services = (svc ?? []) as Array<{ wix_service_id: string | null }>;
  const staff = (stf ?? []) as Array<{ wix_resource_id: string | null }>;
  const apiKey = stripKey(integ?.wix_api_key) || stripKey(process.env.WIX_API_KEY);
  const siteId = (integ?.site_id as string) ?? null;

  // syncedBookings = total − those with a NULL wix_booking_id (the loose client only
  // exposes IS NULL, so derive the "synced" count by subtraction).
  const { data: allBk } = await db.from("bookings").select("id").eq("salon_id", salonId);
  const { data: unsyncedBk } = await db.from("bookings").select("id").eq("salon_id", salonId).is("wix_booking_id", null);
  const totalBk = ((allBk as Array<unknown> | null) ?? []).length;
  const unsynced = ((unsyncedBk as Array<unknown> | null) ?? []).length;

  return {
    ok: true,
    status: {
      connected: Boolean(siteId && apiKey),
      siteId,
      enabled: Boolean(integ?.enabled ?? false),
      autoApprove: Boolean(integ?.auto_approve ?? true),
      hasApiKey: Boolean(apiKey),
      hasWebhookKey: Boolean(stripKey(integ?.wix_webhook_public_key)),
      lastRunAt: (integ?.last_run_at as string) ?? null,
      lastError: (integ?.last_error as string) ?? null,
      webhookLastReceivedAt: (integ?.webhook_last_received_at as string) ?? null,
      mappedServices: services.filter((s) => s.wix_service_id).length,
      totalServices: services.length,
      mappedStaff: staff.filter((s) => s.wix_resource_id).length,
      totalStaff: staff.length,
      syncedBookings: Math.max(0, totalBk - unsynced),
    },
  };
}

// ---------------------------------------------------------------------------
// Test connection (with a pasted OR saved key)
// ---------------------------------------------------------------------------
export async function testWixConnection(
  slug: string,
  input: { siteId: string; apiKey?: string },
): Promise<{ ok: true; serviceCount: number } | Fail> {
  const ctx = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  const siteId = String(input.siteId ?? "").trim();
  let key = stripKey(input.apiKey);
  if (!key || isMasked(String(input.apiKey ?? ""))) {
    const db = looseServiceClient();
    const { data } = await db.from("wix_integrations").select("wix_api_key").eq("salon_id", ctx.salon.id).maybeSingle();
    key = stripKey(data?.wix_api_key) || stripKey(process.env.WIX_API_KEY);
  }
  if (!siteId || !key) return { ok: false, error: "missing_credentials" };

  try {
    const r = (await wixPostWithKey(siteId, key, SERVICES_QUERY, { query: { paging: { limit: 100 } } })) as {
      services?: WixSvc[];
    };
    return { ok: true, serviceCount: (r.services ?? []).length };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Save credentials (upsert; only overwrites a secret when a fresh value is sent)
// ---------------------------------------------------------------------------
export async function saveWixCredentials(
  slug: string,
  input: { siteId: string; apiKey?: string; webhookPublicKey?: string; enabled?: boolean; autoApprove?: boolean },
): Promise<{ ok: true } | Fail> {
  const ctx = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  const siteId = String(input.siteId ?? "").trim();
  if (!siteId) return { ok: false, error: "missing_site_id" };

  const patch: Record<string, unknown> = {
    salon_id: ctx.salon.id,
    site_id: siteId,
    updated_at: new Date().toISOString(),
  };
  const apiKey = stripKey(input.apiKey);
  if (apiKey && !isMasked(String(input.apiKey ?? ""))) patch.wix_api_key = apiKey;
  const pub = String(input.webhookPublicKey ?? "").trim();
  if (pub && !isMasked(pub)) patch.wix_webhook_public_key = pub;
  if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
  if (typeof input.autoApprove === "boolean") patch.auto_approve = input.autoApprove;

  const db = looseServiceClient();
  const { data: existing, error: existingError } = await db
    .from("wix_integrations")
    .select("enabled")
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (existingError) return { ok: false, error: existingError.message };
  patch.enabled = resolveWixEnabledOnCredentialSave(
    existing?.enabled,
    input.enabled,
  );
  const { error } = await db.from("wix_integrations").upsert(patch, { onConflict: "salon_id" });
  if (error) return { ok: false, error: error.message };
  invalidateWixKeyCache(siteId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Toggles
// ---------------------------------------------------------------------------
export async function setWixEnabled(slug: string, enabled: boolean): Promise<{ ok: true } | Fail> {
  const ctx = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  const db = looseServiceClient();
  const { error } = await db
    .from("wix_integrations")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("salon_id", ctx.salon.id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function setWixAutoApprove(slug: string, autoApprove: boolean): Promise<{ ok: true } | Fail> {
  const ctx = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  const db = looseServiceClient();
  const { error } = await db
    .from("wix_integrations")
    .update({ auto_approve: autoApprove, updated_at: new Date().toISOString() })
    .eq("salon_id", ctx.salon.id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

// ---------------------------------------------------------------------------
// Auto-map Wix catalog → NailIQ services + staff
// ---------------------------------------------------------------------------
export async function autoMapWixCatalog(slug: string): Promise<
  | { ok: true; services: { matched: number; created: number }; staff: { matched: number; created: number } }
  | Fail
> {
  const ctx = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  const db = looseServiceClient();
  const salonId = ctx.salon.id;

  const { data: integ } = await db
    .from("wix_integrations")
    .select("site_id, wix_api_key")
    .eq("salon_id", salonId)
    .maybeSingle();
  const siteId = String(integ?.site_id ?? "");
  const key = stripKey(integ?.wix_api_key) || stripKey(process.env.WIX_API_KEY);
  if (!siteId || !key) return { ok: false, error: "not_connected" };

  // --- Services ---
  let svcMatched = 0;
  let svcCreated = 0;
  try {
    const sres = (await wixPostWithKey(siteId, key, SERVICES_QUERY, { query: { paging: { limit: 100 } } })) as {
      services?: WixSvc[];
    };
    const { data: existing } = await db.from("services").select("id, name, price_cents").eq("salon_id", salonId);
    const existingRows = (existing ?? []) as Array<{ id: string; name: string; price_cents: number | null }>;
    const byName = new Map(existingRows.map((s) => [norm(s.name), s]));

    for (const ws of sres.services ?? []) {
      if (!ws?.id || !ws.name) continue;
      const scheduleId = ws.schedule?.id ?? ws.schedules?.[0]?.id ?? null;
      const priceCents = wixServicePriceCents(ws); // FIXED price or "From $X" minimum
      // Wix CUSTOM ("From $35", "$50+") → a variable 'from' price in NailIQ.
      const priceType = ws.payment?.rateType === "CUSTOM" && priceCents ? "from" : "fixed";
      const match = byName.get(norm(ws.name));
      if (match) {
        const patch: Record<string, unknown> = { wix_service_id: ws.id, wix_schedule_id: scheduleId };
        // Backfill price + type ONLY when the local price is still 0 — never
        // clobber a price the owner has set.
        if ((Number(match.price_cents) || 0) === 0 && priceCents) {
          patch.price_cents = priceCents;
          patch.price_type = priceType;
        }
        await db.from("services").update(patch).eq("id", match.id);
        svcMatched++;
      } else {
        await db.from("services").insert({
          salon_id: salonId,
          name: titleCase(ws.name),
          price_cents: priceCents ?? 0, // 0 only when Wix has no derivable price
          price_type: priceType,
          duration_minutes: 30,
          category: categorizeService(ws.name, ws.category?.name),
          wix_service_id: ws.id,
          wix_schedule_id: scheduleId,
        });
        svcCreated++;
      }
    }
  } catch (e) {
    return { ok: false, error: `services: ${(e as Error).message.slice(0, 160)}` };
  }

  // --- Staff / resources ---
  let stfMatched = 0;
  let stfCreated = 0;
  let firstResourceId: string | null = null;
  try {
    const rres = (await wixPostWithKey(siteId, key, RESOURCES_QUERY, {
      query: { paging: { limit: 100 } },
      includeDeleted: false,
    })) as { resources?: WixRes[] };

    const { data: existing } = await db.from("staff").select("id, name, wix_resource_id").eq("salon_id", salonId);
    const rows = (existing ?? []) as Array<{ id: string; name: string; wix_resource_id: string | null }>;
    const byResource = new Map(rows.filter((s) => s.wix_resource_id).map((s) => [s.wix_resource_id as string, s.id]));
    const byName = new Map(rows.map((s) => [norm(s.name), s.id]));
    let n = rows.length;

    for (const wr of rres.resources ?? []) {
      const id = wr.resource?.id ?? wr.id;
      const name = wr.resource?.name ?? wr.name ?? "";
      const tags = wr.resource?.tags ?? wr.tags ?? [];
      if (!id) continue;
      // Skip the Wix "business" resource (the salon itself, not a person).
      if (norm(name) === "business" || tags.some((t) => norm(t) === "business")) continue;
      if (!firstResourceId) firstResourceId = id;

      if (byResource.has(id)) {
        stfMatched++;
        continue;
      }
      const matchByName = byName.get(norm(name));
      if (matchByName) {
        await db.from("staff").update({ wix_resource_id: id }).eq("id", matchByName);
        stfMatched++;
      } else {
        n++;
        await db.from("staff").insert({
          salon_id: salonId,
          name: name && norm(name) !== "" ? titleCase(name) : `Thợ ${n}`,
          job_role: "nail_tech",
          status: "active",
          wix_resource_id: id,
        });
        stfCreated++;
      }
    }

    // Default resource for create write-back when a tech isn't mapped.
    if (firstResourceId) {
      await db
        .from("wix_integrations")
        .update({ wix_default_resource_id: firstResourceId, updated_at: new Date().toISOString() })
        .eq("salon_id", salonId);
    }
  } catch (e) {
    return { ok: false, error: `staff: ${(e as Error).message.slice(0, 160)}` };
  }

  return { ok: true, services: { matched: svcMatched, created: svcCreated }, staff: { matched: stfMatched, created: stfCreated } };
}

// ---------------------------------------------------------------------------
// Import existing Wix bookings (history backfill via the normal forward sync)
// ---------------------------------------------------------------------------
export async function importWixBookings(
  slug: string,
): Promise<{ ok: true; created: number; updated: number } | Fail> {
  const ctx = await ownerCtx(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  const db = looseServiceClient();
  const { data: integ } = await db
    .from("wix_integrations")
    .select("site_id, auto_approve")
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (!integ?.site_id) return { ok: false, error: "not_connected" };

  try {
    // Pull everything from a far-back watermark; runForwardSync is idempotent
    // (dedupes by wix_booking_id + natural key) and advances the cursor afterwards.
    const res = await runForwardSync(
      ctx.salon.id,
      String(integ.site_id),
      "2018-01-01T00:00:00.000Z",
      Boolean(integ.auto_approve ?? true),
    );
    return { ok: true, created: res.created, updated: res.updated };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}
