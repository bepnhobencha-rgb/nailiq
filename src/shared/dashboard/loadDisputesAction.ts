"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

// ---------------------------------------------------------------------------
// Exported types — UI agent depends on EXACT field names below
// ---------------------------------------------------------------------------

export type DisputeRow = {
  id: string;
  provider: string;
  providerDisputeId: string;
  status: string | null;
  reason: string | null;
  amountCents: number | null;
  currency: string | null;
  evidenceDueAt: string | null;
  createdAt: string;
  bookingId: string | null;
  clientPhone: string | null;
  clientName: string | null;
};

export type DisputeEvidence = {
  consentAt: string | null;
  charge: {
    amountCents: number | null;
    currency: string | null;
    paymentRef: string | null;
  };
  booking: {
    id: string | null;
    serviceName: string | null;
    staffName: string | null;
    startUtc: string | null;
    status: string | null;
    priceCents: number | null;
  } | null;
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
    visitCount: number;
  } | null;
  noShowAudit: {
    at: string | null;
    actorRole: string | null;
  } | null;
  notifications: {
    type: string;
    channel: string;
    status: string;
    sentAt: string | null;
  }[];
};

// ---------------------------------------------------------------------------
// Statuses considered "needs action" — liberal to catch both Stripe + Square
// ---------------------------------------------------------------------------

const NEEDS_ACTION_STATUSES = new Set([
  // Stripe
  "needs_response",
  "warning_needs_response",
  // Square
  "evidence_required",
  "UNDER_REVIEW",
  "WARNING_UNDER_REVIEW",
  "INQUIRY_UNDER_REVIEW",
  "inquiry_evidence_required",
]);

// ---------------------------------------------------------------------------
// Auth helper — owner or admin only for financial/dispute data
// ---------------------------------------------------------------------------

async function requireOwnerOrAdmin(slug: string) {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return null;
  if (!isOwnerOrAdmin(ctx.role)) return null;
  return ctx;
}

// ---------------------------------------------------------------------------
// Action 1: loadDisputes
// ---------------------------------------------------------------------------

/**
 * Lists all payment disputes for a salon, enriched with the client's display
 * name from client_profiles. Ordered newest-first.
 *
 * Auth: owner or admin only. All reads scoped to ctx.salon.id.
 */
export async function loadDisputes(
  slug: string,
): Promise<
  | { ok: true; disputes: DisputeRow[]; needsResponse: number }
  | { ok: false; error: string }
> {
  const ctx = await requireOwnerOrAdmin(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const salonId = ctx.salon.id;
  const db = createServiceRoleClient();

  // Raw dispute rows scoped to this salon
  const { data, error } = await db
    .from("payment_disputes" as never)
    .select(
      "id, provider, provider_dispute_id, status, reason, amount_cents, currency, evidence_due_at, created_at, booking_id, client_phone",
    )
    .eq("salon_id" as never, salonId)
    .order("created_at" as never, { ascending: false });

  if (error) {
    console.error("[loadDisputes] query error", error);
    return { ok: false, error: "server_error" };
  }

  type RawDisputeRow = {
    id: string;
    provider: string | null;
    provider_dispute_id: string | null;
    status: string | null;
    reason: string | null;
    amount_cents: number | null;
    currency: string | null;
    evidence_due_at: string | null;
    created_at: string;
    booking_id: string | null;
    client_phone: string | null;
  };

  const rows = (data ?? []) as RawDisputeRow[];

  // Gather unique client phones to batch-resolve names
  const phones = [
    ...new Set(rows.map((r) => r.client_phone).filter(Boolean) as string[]),
  ];

  // Batch lookup client names
  const phoneToName = new Map<string, string | null>();
  if (phones.length > 0) {
    const { data: profiles } = await db
      .from("client_profiles")
      .select("phone, name")
      .in("phone", phones);

    type ProfileRow = { phone: string; name: string | null };
    for (const p of (profiles ?? []) as ProfileRow[]) {
      phoneToName.set(p.phone, p.name ?? null);
    }
  }

  let needsResponse = 0;
  const disputes: DisputeRow[] = rows.map((r) => {
    const isOpen = r.status ? NEEDS_ACTION_STATUSES.has(r.status) : false;
    if (isOpen) needsResponse += 1;

    return {
      id: String(r.id),
      provider: String(r.provider ?? ""),
      providerDisputeId: String(r.provider_dispute_id ?? ""),
      status: r.status ?? null,
      reason: r.reason ?? null,
      amountCents: typeof r.amount_cents === "number" ? r.amount_cents : null,
      currency: r.currency ?? null,
      evidenceDueAt: r.evidence_due_at ?? null,
      createdAt: String(r.created_at),
      bookingId: r.booking_id ?? null,
      clientPhone: r.client_phone ?? null,
      clientName: r.client_phone ? (phoneToName.get(r.client_phone) ?? null) : null,
    };
  });

  return { ok: true, disputes, needsResponse };
}

// ---------------------------------------------------------------------------
// Action 2: loadDisputeEvidence
// ---------------------------------------------------------------------------

/**
 * Compiles evidence for a single dispute: consent timestamp, charge details,
 * booking context, customer profile, no-show audit trail, and notifications.
 *
 * Auth: owner or admin only. Dispute row read is scoped to salon_id.
 */
export async function loadDisputeEvidence(
  slug: string,
  disputeId: string,
): Promise<{ ok: true; evidence: DisputeEvidence } | { ok: false; error: string }> {
  const ctx = await requireOwnerOrAdmin(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const salonId = ctx.salon.id;
  const db = createServiceRoleClient();

  // ── 1. Load the dispute row (salon-scoped) ────────────────────────────────
  const { data: disputeData, error: disputeError } = await db
    .from("payment_disputes" as never)
    .select(
      "id, payment_ref, amount_cents, currency, booking_id, client_phone",
    )
    .eq("id" as never, disputeId)
    .eq("salon_id" as never, salonId)
    .maybeSingle();

  if (disputeError) {
    console.error("[loadDisputeEvidence] dispute query error", disputeError);
    return { ok: false, error: "server_error" };
  }
  if (!disputeData) return { ok: false, error: "not_found" };

  type DisputeRaw = {
    id: string;
    payment_ref: string | null;
    amount_cents: number | null;
    currency: string | null;
    booking_id: string | null;
    client_phone: string | null;
  };
  const dRow = disputeData as DisputeRaw;

  const bookingId = dRow.booking_id ?? null;
  const clientPhone = dRow.client_phone ?? null;

  // ── 2. Run independent queries in parallel ────────────────────────────────
  const [bookingRes, customerRes, noShowAuditRes, notificationsRes] =
    await Promise.all([
      // Booking with service name + staff name (use established FK aliases)
      bookingId
        ? db
            .from("bookings")
            .select(
              "id, start_time_utc, status, price_cents, noshow_fee_cents, noshow_consent_at, services!bookings_service_id_fkey ( name ), staff ( name )",
            )
            .eq("id", bookingId)
            .eq("salon_id", salonId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),

      // Customer profile (global, phone-keyed; auth already verified)
      clientPhone
        ? db
            .from("client_profiles")
            .select("name, phone, email")
            .eq("phone", clientPhone)
            .is("deleted_at" as never, null)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),

      // No-show audit: latest booking_status_changed → no_show event
      bookingId
        ? (db
            .from("booking_events" as never)
            .select("created_at, actor_role")
            .eq("booking_id" as never, bookingId)
            .eq("event_type" as never, "booking_status_changed")
            .eq("payload->>to" as never, "no_show")
            .order("created_at" as never, { ascending: false })
            .limit(1)
            .maybeSingle() as unknown as Promise<{
            data: { created_at: string | null; actor_role: string | null } | null;
            error: unknown;
          }>)
        : Promise.resolve({ data: null, error: null }),

      // Notifications for this client at this salon — newest 20
      clientPhone
        ? db
            .from("booking_notifications")
            .select("notification_type, channel, status, sent_at")
            .eq("salon_id", salonId)
            .eq("client_phone", clientPhone)
            .order("created_at", { ascending: false })
            .limit(20)
        : Promise.resolve({ data: [], error: null }),
    ]);

  // ── 3. Visit count — count completed bookings with same phone + salon ──────
  let visitCount = 0;
  if (clientPhone) {
    const { count } = await db
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salonId)
      .eq("client_phone", clientPhone)
      .eq("status", "completed");
    visitCount = typeof count === "number" ? count : 0;
  }

  // ── 4. Resolve booking fields ─────────────────────────────────────────────
  type BookingRow = {
    id: string;
    start_time_utc: string | null;
    status: string | null;
    price_cents: number | null;
    noshow_fee_cents?: number | null;
    noshow_consent_at?: string | null;
    services?:
      | { name?: string | null }
      | Array<{ name?: string | null }>
      | null;
    staff?: { name?: string | null } | Array<{ name?: string | null }> | null;
  } | null;

  const bRow = bookingRes.data as BookingRow;

  function resolveJoinedName(
    raw:
      | { name?: string | null }
      | Array<{ name?: string | null }>
      | null
      | undefined,
  ): string | null {
    const row = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    return (row as { name?: string | null } | null)?.name?.trim() || null;
  }

  const consentAt =
    (bRow as { noshow_consent_at?: string | null } | null)?.noshow_consent_at ?? null;

  const booking: DisputeEvidence["booking"] = bRow
    ? {
        id: String(bRow.id),
        serviceName: resolveJoinedName(bRow.services),
        staffName: resolveJoinedName(bRow.staff),
        startUtc: bRow.start_time_utc ?? null,
        status: bRow.status ?? null,
        priceCents:
          typeof bRow.noshow_fee_cents === "number"
            ? bRow.noshow_fee_cents
            : typeof bRow.price_cents === "number"
              ? bRow.price_cents
              : null,
      }
    : null;

  // ── 5. Resolve customer ───────────────────────────────────────────────────
  type CustomerRow = {
    name: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  const cRow = customerRes.data as CustomerRow;

  const customer: DisputeEvidence["customer"] =
    cRow || clientPhone
      ? {
          name: cRow?.name ?? null,
          phone: cRow?.phone ?? clientPhone,
          email: cRow?.email ?? null,
          visitCount,
        }
      : null;

  // ── 6. No-show audit ──────────────────────────────────────────────────────
  const auditRow = noShowAuditRes.data as {
    created_at: string | null;
    actor_role: string | null;
  } | null;
  const noShowAudit: DisputeEvidence["noShowAudit"] = auditRow
    ? { at: auditRow.created_at ?? null, actorRole: auditRow.actor_role ?? null }
    : null;

  // ── 7. Notifications ──────────────────────────────────────────────────────
  type NotifRow = {
    notification_type?: string | null;
    channel?: string | null;
    status?: string | null;
    sent_at?: string | null;
  };
  const notifications: DisputeEvidence["notifications"] = (
    (notificationsRes.data ?? []) as NotifRow[]
  ).map((n) => ({
    type: String(n.notification_type ?? ""),
    channel: String(n.channel ?? "sms"),
    status: String(n.status ?? ""),
    sentAt: n.sent_at ?? null,
  }));

  // ── Assemble ──────────────────────────────────────────────────────────────
  const evidence: DisputeEvidence = {
    consentAt,
    charge: {
      amountCents:
        typeof dRow.amount_cents === "number" ? dRow.amount_cents : null,
      currency: dRow.currency ?? null,
      paymentRef: dRow.payment_ref ?? null,
    },
    booking,
    customer,
    noShowAudit,
    notifications,
  };

  return { ok: true, evidence };
}
