"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

// ---------------------------------------------------------------------------
// Exported types — UI agent depends on EXACT field names below
// ---------------------------------------------------------------------------

export type C360Booking = {
  id: string;
  startUtc: string;
  endUtc: string | null;
  serviceName: string;
  staffName: string | null;
  priceCents: number | null;
  status: string;
  channel: string | null;
};

export type ClientProfile360 = {
  profile: {
    id: string | null;
    name: string | null;
    phone: string;
    email: string | null;
    isVip: boolean;
    birthday: string | null;
    createdAt: string | null;
    noShowCount: number;
    squareCustomerId: string | null;
    preferredStaffName: string | null;
  };
  stats: {
    lifetimeSpentCents: number;
    visitCount: number;
    avgTicketCents: number;
    firstVisitAt: string | null;
    lastVisitAt: string | null;
    upcomingCount: number;
  };
  reliability: {
    completed: number;
    noShow: number;
    cancelled: number;
    total: number;
    noShowRatePct: number;
  };
  favorites: {
    topServiceName: string | null;
    topStaffName: string | null;
  };
  timeline: C360Booking[];
  upcoming: C360Booking[];
  preferences: {
    allergies: string | null;
    favoriteColors: string | null;
    favoriteStyles: string | null;
    language: string | null;
    commChannel: string | null;
    smsWindow: string | null;
    consents: { sms: boolean; email: boolean; ai: boolean };
  } | null;
  pattern: {
    recurringWeekday: number | null;
    recurringHour: number | null;
    recurrenceDays: number | null;
    nextPredictedAt: string | null;
    usualServiceName: string | null;
    usualStaffName: string | null;
    usualTotalCents: number | null;
    confidence: number | null;
  } | null;
  loyalty: {
    stampsCurrent: number;
    stampsLifetime: number;
    rewardsEarned: number;
    rewardsRedeemed: number;
  } | null;
  vouchers: {
    code: string;
    kind: string;
    label: string;
    expiresAt: string | null;
  }[];
  reviews: {
    rating: number;
    message: string | null;
    submittedAt: string | null;
    staffName: string | null;
  }[];
  notifications: {
    type: string;
    channel: string;
    status: string;
    sentAt: string | null;
  }[];
  ai: {
    chatCount: number;
    voiceCount: number;
    lastInteractionAt: string | null;
  };
  aiSummary: {
    text: string;
    nextAction: string;
    computedAt: string;
  } | null;
};

// ---------------------------------------------------------------------------
// Result union
// ---------------------------------------------------------------------------

export type LoadClientProfile360Result =
  | { ok: true; data: ClientProfile360 }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

export type GenerateClient360SummaryResult =
  | { ok: true; text: string; nextAction: string; computedAt: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Auth helper — shared by both actions
// ---------------------------------------------------------------------------

async function requireDeskRole(slug: string) {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return null;
  if (
    ctx.role !== "owner" &&
    ctx.role !== "senior" &&
    ctx.role !== "admin" &&
    ctx.role !== "receptionist"
  ) {
    return null;
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Action 1: loadClientProfile360
// ---------------------------------------------------------------------------

/**
 * Aggregates all known data about a single client (identified by phone)
 * across every data surface: profile, bookings, preferences, patterns,
 * loyalty, vouchers, reviews, notifications, and AI interactions.
 *
 * Auth: owner / senior / admin / receptionist. nail_tech is explicitly denied.
 * All salon-specific queries are scoped with `.eq("salon_id", ctx.salon.id)`.
 */
export async function loadClientProfile360(
  slug: string,
  clientPhone: string,
): Promise<LoadClientProfile360Result> {
  // Auth gate — nail_tech returns null → forbidden
  const ctx = await requireDeskRole(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const salonId = ctx.salon.id;
  const supabase = createServiceRoleClient();

  // ── 1. Run independent queries in parallel ────────────────────────────────
  const [
    profileRes,
    bookingsRes,
    loyaltyRes,
    vouchersRes,
    reviewsRes,
    notificationsRes,
  ] = await Promise.all([
    // client_profiles is global (phone-keyed); no salon_id filter.
    // Auth was verified above — salon membership is confirmed before this read.
    supabase
      .from("client_profiles")
      .select(
        "id, name, phone, email, is_vip, notes, created_at, no_show_count, square_customer_id, preferred_staff_id, birthday",
      )
      .eq("phone", clientPhone)
      .is("deleted_at" as never, null)
      .maybeSingle(),

    // All bookings for this client in THIS salon, with nested service + staff names.
    supabase
      .from("bookings")
      .select(
        "id, start_time_utc, end_time_utc, price_cents, status, booking_channel, services ( name ), staff ( name )",
      )
      .eq("salon_id", salonId)
      .eq("client_phone", clientPhone)
      .order("start_time_utc", { ascending: false })
      .limit(300),

    // loyalty_cards — salon-scoped via salon_id + client_phone
    supabase
      .from("loyalty_cards")
      .select("stamps_current, stamps_lifetime, rewards_earned, rewards_redeemed")
      .eq("salon_id", salonId)
      .eq("client_phone", clientPhone)
      .maybeSingle(),

    // vouchers — salon-scoped; only active (not revoked, not exhausted)
    supabase
      .from("vouchers" as never)
      .select(
        "code, kind, amount_off_cents, percent_off, gift_card_value_cents, expires_at, used_count, max_uses, revoked_at",
      )
      .eq("salon_id", salonId)
      .eq("client_phone", clientPhone)
      .is("revoked_at", null),

    // reviews — salon-scoped, submitted only, with staff name
    supabase
      .from("reviews")
      .select("rating, message, submitted_at, staff ( name )")
      .eq("salon_id", salonId)
      .eq("client_phone", clientPhone)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .limit(20),

    // booking_notifications — salon-scoped, newest first, cap 10
    supabase
      .from("booking_notifications")
      .select("notification_type, channel, status, sent_at")
      .eq("salon_id", salonId)
      .eq("client_phone", clientPhone)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (bookingsRes.error) {
    console.error("[loadClientProfile360] bookings query", bookingsRes.error);
    return { ok: false, error: "server_error" };
  }

  // ── 2. Resolve profile + preferredStaffName ───────────────────────────────
  type ProfileRow = {
    id?: string | null;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    is_vip?: boolean | null;
    no_show_count?: number | null;
    square_customer_id?: string | null;
    preferred_staff_id?: string | null;
    birthday?: string | null;
    created_at?: string | null;
  };
  const profileRow = profileRes.data as ProfileRow | null;

  let preferredStaffName: string | null = null;
  const preferredStaffId = profileRow?.preferred_staff_id?.trim() || null;
  if (preferredStaffId) {
    const { data: stfRow } = await supabase
      .from("staff")
      .select("name")
      .eq("id", preferredStaffId)
      .maybeSingle();
    preferredStaffName =
      (stfRow as { name?: string | null } | null)?.name?.trim() ?? null;
  }

  const profile: ClientProfile360["profile"] = {
    id: profileRow?.id?.trim() ?? null,
    name: profileRow?.name?.trim() ?? null,
    phone: clientPhone,
    email: profileRow?.email?.trim() ?? null,
    isVip: profileRow?.is_vip === true,
    birthday: profileRow?.birthday?.trim() ?? null,
    createdAt: profileRow?.created_at ?? null,
    noShowCount: Number(profileRow?.no_show_count ?? 0),
    squareCustomerId: profileRow?.square_customer_id?.trim() ?? null,
    preferredStaffName,
  };

  // ── 3. Process bookings ───────────────────────────────────────────────────
  type BookingRow = {
    id: string;
    start_time_utc: string;
    end_time_utc?: string | null;
    price_cents?: number | null;
    status: string;
    booking_channel?: string | null;
    services?: { name?: string | null } | Array<{ name?: string | null }> | null;
    staff?: { name?: string | null } | Array<{ name?: string | null }> | null;
  };

  const bookingRows = (bookingsRes.data ?? []) as BookingRow[];
  const now = new Date().toISOString();

  function resolveJoinedName(
    raw: { name?: string | null } | Array<{ name?: string | null }> | null | undefined,
  ): string | null {
    const row = Array.isArray(raw) ? raw[0] ?? null : raw ?? null;
    return (row as { name?: string | null } | null)?.name?.trim() || null;
  }

  // Stats accumulators
  let lifetimeSpentCents = 0;
  let completedCount = 0;
  let noShowCount = 0;
  let cancelledCount = 0;
  let firstVisitAt: string | null = null;
  let lastVisitAt: string | null = null;
  const serviceCounts = new Map<string, number>();
  const staffCounts = new Map<string, number>();
  const allTimeline: C360Booking[] = [];
  const upcoming: C360Booking[] = [];

  for (const b of bookingRows) {
    const svcName = resolveJoinedName(b.services) ?? "(unknown service)";
    const staffName = resolveJoinedName(b.staff);
    const entry: C360Booking = {
      id: String(b.id),
      startUtc: b.start_time_utc,
      endUtc: b.end_time_utc ?? null,
      serviceName: svcName,
      staffName,
      priceCents:
        typeof b.price_cents === "number" ? b.price_cents : null,
      status: b.status,
      channel: b.booking_channel ?? null,
    };

    allTimeline.push(entry);

    const status = String(b.status);

    // Upcoming: confirmed/pending future bookings
    if (
      (status === "confirmed" || status === "pending") &&
      b.start_time_utc > now
    ) {
      upcoming.push(entry);
    }

    // Stats
    if (status === "completed") {
      completedCount += 1;
      lifetimeSpentCents += typeof b.price_cents === "number" ? b.price_cents : 0;
      const ts = b.start_time_utc;
      if (!firstVisitAt || ts < firstVisitAt) firstVisitAt = ts;
      if (!lastVisitAt || ts > lastVisitAt) lastVisitAt = ts;
    }
    if (status === "no_show") noShowCount += 1;
    if (status === "cancelled") cancelledCount += 1;

    // Favorites (count by name, excluding cancelled)
    if (status !== "cancelled") {
      if (svcName && svcName !== "(unknown service)") {
        serviceCounts.set(svcName, (serviceCounts.get(svcName) ?? 0) + 1);
      }
      if (staffName) {
        staffCounts.set(staffName, (staffCounts.get(staffName) ?? 0) + 1);
      }
    }
  }

  // Sort upcoming ascending (soonest first)
  upcoming.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  // Timeline already newest-first (from DB order), cap at 50
  const timeline = allTimeline.slice(0, 50);

  const totalForRate = completedCount + noShowCount + cancelledCount;
  const noShowRatePct =
    totalForRate > 0 ? Math.round((noShowCount / totalForRate) * 100) : 0;

  const visitCount = completedCount;
  const avgTicketCents =
    visitCount > 0 ? Math.round(lifetimeSpentCents / visitCount) : 0;

  function topName(map: Map<string, number>): string | null {
    let best: string | null = null;
    let bestCount = 0;
    for (const [name, count] of map) {
      if (count > bestCount) {
        best = name;
        bestCount = count;
      }
    }
    return best;
  }

  const stats: ClientProfile360["stats"] = {
    lifetimeSpentCents,
    visitCount,
    avgTicketCents,
    firstVisitAt,
    lastVisitAt,
    upcomingCount: upcoming.length,
  };

  const reliability: ClientProfile360["reliability"] = {
    completed: completedCount,
    noShow: noShowCount,
    cancelled: cancelledCount,
    total: bookingRows.length,
    noShowRatePct,
  };

  const favorites: ClientProfile360["favorites"] = {
    topServiceName: topName(serviceCounts),
    topStaffName: topName(staffCounts),
  };

  // ── 4. Preferences — requires client_profile_id + salon_id ───────────────
  let preferences: ClientProfile360["preferences"] = null;
  const clientProfileId = profileRow?.id ?? null;
  if (clientProfileId) {
    const { data: prefData } = await supabase
      .from("customer_preferences")
      .select(
        "allergies, favorite_colors, favorite_styles, preferred_language, preferred_communication_channel, preferred_sms_time_window, consent_marketing_sms, consent_marketing_email, consent_ai_personalization",
      )
      .eq("client_profile_id", clientProfileId)
      .eq("salon_id", salonId)
      .maybeSingle();

    if (prefData) {
      type PrefRow = {
        allergies?: string | null;
        favorite_colors?: string | null;
        favorite_styles?: string | null;
        preferred_language?: string | null;
        preferred_communication_channel?: string | null;
        preferred_sms_time_window?: string | null;
        consent_marketing_sms?: boolean | null;
        consent_marketing_email?: boolean | null;
        consent_ai_personalization?: boolean | null;
      };
      const p = prefData as PrefRow;
      preferences = {
        allergies: p.allergies ?? null,
        favoriteColors: p.favorite_colors ?? null,
        favoriteStyles: p.favorite_styles ?? null,
        language: p.preferred_language ?? null,
        commChannel: p.preferred_communication_channel ?? null,
        smsWindow: p.preferred_sms_time_window ?? null,
        consents: {
          sms: p.consent_marketing_sms === true,
          email: p.consent_marketing_email === true,
          ai: p.consent_ai_personalization === true,
        },
      };
    }
  }

  // ── 5. Booking pattern — salon-scoped via salon_id + client_phone ─────────
  let pattern: ClientProfile360["pattern"] = null;
  {
    const { data: patternData } = await supabase
      .from("customer_booking_patterns")
      .select(
        "recurring_weekday, recurring_hour, recurrence_frequency_days, next_predicted_at, usual_service_ids, usual_staff_id, usual_total_cents, pattern_confidence",
      )
      .eq("salon_id", salonId)
      .eq("client_phone", clientPhone)
      .maybeSingle();

    if (patternData) {
      type PatternRow = {
        recurring_weekday?: number | null;
        recurring_hour?: number | null;
        recurrence_frequency_days?: number | null;
        next_predicted_at?: string | null;
        usual_service_ids?: string[] | null;
        usual_staff_id?: string | null;
        usual_total_cents?: number | null;
        pattern_confidence?: number | null;
      };
      const pt = patternData as PatternRow;

      // Resolve usual service name (first in array)
      let usualServiceName: string | null = null;
      const usualServiceId =
        Array.isArray(pt.usual_service_ids) && pt.usual_service_ids.length > 0
          ? pt.usual_service_ids[0]
          : null;
      if (usualServiceId) {
        const { data: svcRow } = await supabase
          .from("services")
          .select("name")
          .eq("id", usualServiceId)
          .eq("salon_id", salonId)
          .maybeSingle();
        usualServiceName =
          (svcRow as { name?: string | null } | null)?.name?.trim() ?? null;
      }

      // Resolve usual staff name
      let usualStaffName: string | null = null;
      if (pt.usual_staff_id) {
        const { data: stfRow } = await supabase
          .from("staff")
          .select("name")
          .eq("id", pt.usual_staff_id)
          .eq("salon_id", salonId)
          .maybeSingle();
        usualStaffName =
          (stfRow as { name?: string | null } | null)?.name?.trim() ?? null;
      }

      pattern = {
        recurringWeekday: pt.recurring_weekday ?? null,
        recurringHour: pt.recurring_hour ?? null,
        recurrenceDays: pt.recurrence_frequency_days ?? null,
        nextPredictedAt: pt.next_predicted_at ?? null,
        usualServiceName,
        usualStaffName,
        usualTotalCents: pt.usual_total_cents ?? null,
        confidence: pt.pattern_confidence ?? null,
      };
    }
  }

  // ── 6. Loyalty ────────────────────────────────────────────────────────────
  let loyalty: ClientProfile360["loyalty"] = null;
  if (loyaltyRes.data) {
    type LoyaltyRow = {
      stamps_current?: number | null;
      stamps_lifetime?: number | null;
      rewards_earned?: number | null;
      rewards_redeemed?: number | null;
    };
    const lc = loyaltyRes.data as LoyaltyRow;
    loyalty = {
      stampsCurrent: Number(lc.stamps_current ?? 0),
      stampsLifetime: Number(lc.stamps_lifetime ?? 0),
      rewardsEarned: Number(lc.rewards_earned ?? 0),
      rewardsRedeemed: Number(lc.rewards_redeemed ?? 0),
    };
  }

  // ── 7. Vouchers — filter active rows in JS (revoked_at already filtered) ──
  type VoucherRow = {
    code?: string | null;
    kind?: string | null;
    amount_off_cents?: number | null;
    percent_off?: number | null;
    gift_card_value_cents?: number | null;
    expires_at?: string | null;
    used_count?: number | null;
    max_uses?: number | null;
    revoked_at?: string | null;
  };

  // Compute a human-readable label from the voucher's value columns.
  function voucherLabel(v: VoucherRow): string {
    if (typeof v.percent_off === "number" && v.percent_off > 0) {
      return `${v.percent_off}% off`;
    }
    if (typeof v.amount_off_cents === "number" && v.amount_off_cents > 0) {
      return `$${(v.amount_off_cents / 100).toFixed(2).replace(/\.00$/, "")} off`;
    }
    if (
      typeof v.gift_card_value_cents === "number" &&
      v.gift_card_value_cents > 0
    ) {
      return `Gift card $${(v.gift_card_value_cents / 100)
        .toFixed(2)
        .replace(/\.00$/, "")}`;
    }
    return String(v.kind ?? "Voucher");
  }

  const voucherRows = ((vouchersRes as { data?: VoucherRow[] | null }).data ?? []) as VoucherRow[];
  const vouchers: ClientProfile360["vouchers"] = voucherRows
    .filter((v) => {
      // Exclude exhausted vouchers
      if (
        typeof v.used_count === "number" &&
        typeof v.max_uses === "number" &&
        v.used_count >= v.max_uses
      ) {
        return false;
      }
      // Exclude expired vouchers
      if (v.expires_at && v.expires_at < now) return false;
      return true;
    })
    .map((v) => ({
      code: String(v.code ?? ""),
      kind: String(v.kind ?? ""),
      label: voucherLabel(v),
      expiresAt: v.expires_at ?? null,
    }));

  // ── 8. Reviews ────────────────────────────────────────────────────────────
  type ReviewRow = {
    rating?: number | null;
    message?: string | null;
    submitted_at?: string | null;
    staff?: { name?: string | null } | Array<{ name?: string | null }> | null;
  };
  const reviews: ClientProfile360["reviews"] = (
    (reviewsRes.data ?? []) as ReviewRow[]
  ).map((r) => ({
    rating: Number(r.rating ?? 0),
    message: r.message ?? null,
    submittedAt: r.submitted_at ?? null,
    staffName: resolveJoinedName(r.staff),
  }));

  // ── 9. Notifications ──────────────────────────────────────────────────────
  type NotifRow = {
    notification_type?: string | null;
    channel?: string | null;
    status?: string | null;
    sent_at?: string | null;
  };
  const notifications: ClientProfile360["notifications"] = (
    (notificationsRes.data ?? []) as NotifRow[]
  ).map((n) => ({
    type: String(n.notification_type ?? ""),
    channel: String(n.channel ?? "sms"),
    status: String(n.status ?? ""),
    sentAt: n.sent_at ?? null,
  }));

  // ── 10. AI interaction counts — both scoped by salon_id + client_phone ──
  //   ai_chats and voice_ai_sessions both have a client_phone column.
  const [chatCountRes, voiceCountRes, lastChatRes, lastVoiceRes] =
    await Promise.all([
      supabase
        .from("ai_chats")
        .select("id", { count: "exact", head: true })
        .eq("salon_id", salonId)
        .eq("client_phone" as never, clientPhone),
      supabase
        .from("voice_ai_sessions")
        .select("id", { count: "exact", head: true })
        .eq("salon_id", salonId)
        .eq("client_phone" as never, clientPhone),
      supabase
        .from("ai_chats")
        .select("created_at")
        .eq("salon_id", salonId)
        .eq("client_phone" as never, clientPhone)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("voice_ai_sessions")
        .select("created_at")
        .eq("salon_id", salonId)
        .eq("client_phone" as never, clientPhone)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const chatCount = typeof chatCountRes.count === "number" ? chatCountRes.count : 0;
  const voiceCount = typeof voiceCountRes.count === "number" ? voiceCountRes.count : 0;

  // lastInteractionAt = max of last chat + last voice session timestamps
  const lastChatAt =
    (lastChatRes.data as { created_at?: string | null } | null)?.created_at ?? null;
  const lastVoiceAt =
    (lastVoiceRes.data as { created_at?: string | null } | null)?.created_at ?? null;
  let lastInteractionAt: string | null = null;
  for (const ts of [lastChatAt, lastVoiceAt]) {
    if (ts && (!lastInteractionAt || ts > lastInteractionAt)) lastInteractionAt = ts;
  }

  const ai: ClientProfile360["ai"] = {
    chatCount,
    voiceCount,
    lastInteractionAt,
  };

  // ── 11. AI Summary — salon-scoped cache in client_ai_summaries ──
  //   PK (salon_id, client_profile_id) → no cross-tenant leak.
  let aiSummary: ClientProfile360["aiSummary"] = null;
  if (clientProfileId) {
    const { data: summaryRow } = await supabase
      .from("client_ai_summaries" as never)
      .select("summary_text, next_action, visit_count, computed_at")
      .eq("salon_id", salonId)
      .eq("client_profile_id", clientProfileId)
      .maybeSingle();

    const s = summaryRow as {
      summary_text?: string | null;
      next_action?: string | null;
      visit_count?: number | null;
      computed_at?: string | null;
    } | null;

    // Only return the cached summary if its visit_count matches the current
    // computed visitCount (else it's stale → null, forces regeneration).
    if (
      s &&
      typeof s.visit_count === "number" &&
      s.visit_count === visitCount &&
      typeof s.summary_text === "string" &&
      typeof s.next_action === "string" &&
      typeof s.computed_at === "string"
    ) {
      aiSummary = {
        text: s.summary_text,
        nextAction: s.next_action,
        computedAt: s.computed_at,
      };
    }
  }

  // ── Assemble result ───────────────────────────────────────────────────────
  const data: ClientProfile360 = {
    profile,
    stats,
    reliability,
    favorites,
    timeline,
    upcoming,
    preferences,
    pattern,
    loyalty,
    vouchers,
    reviews,
    notifications,
    ai,
    aiSummary,
  };

  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Action 2: generateClient360Summary
// ---------------------------------------------------------------------------

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

/**
 * Generates (or refreshes) a short AI summary + next-action recommendation
 * for a client using Claude Haiku. Result is cached in the salon-scoped
 * `client_ai_summaries` table (PK salon_id + client_profile_id).
 *
 * Auth: same as loadClientProfile360 (owner/senior/admin/receptionist;
 * nail_tech denied).
 *
 * Returns ok:true with text/nextAction/computedAt on success, or
 * ok:false with an error message on any failure (auth, AI, DB).
 */
export async function generateClient360Summary(
  slug: string,
  clientPhone: string,
): Promise<GenerateClient360SummaryResult> {
  // Auth gate
  const ctx = await requireDeskRole(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const salonId = ctx.salon.id;

  // Re-gather the key facts needed for the prompt (lean query)
  const supabase = createServiceRoleClient();

  const [profileRes, bookingsCountRes, lastBookingRes, notifRes] =
    await Promise.all([
      supabase
        .from("client_profiles")
        .select("id, name, is_vip, no_show_count, preferred_staff_id")
        .eq("phone", clientPhone)
        .is("deleted_at" as never, null)
        .maybeSingle(),

      // visit count + lifetime spend
      supabase
        .from("bookings")
        .select("status, price_cents, start_time_utc, services ( name ), staff ( name )")
        .eq("salon_id", salonId)
        .eq("client_phone", clientPhone),

      // last completed visit
      supabase
        .from("bookings")
        .select("start_time_utc, services ( name ), staff ( name )")
        .eq("salon_id", salonId)
        .eq("client_phone", clientPhone)
        .eq("status", "completed")
        .order("start_time_utc", { ascending: false })
        .limit(1)
        .maybeSingle(),

      // recent notification channel
      supabase
        .from("booking_notifications")
        .select("channel")
        .eq("salon_id", salonId)
        .eq("client_phone", clientPhone)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  // Process bookings for stats
  type BookingRow = {
    status?: string | null;
    price_cents?: number | null;
    start_time_utc?: string | null;
    services?: { name?: string | null } | Array<{ name?: string | null }> | null;
    staff?: { name?: string | null } | Array<{ name?: string | null }> | null;
  };

  const bookingRows = (bookingsCountRes.data ?? []) as BookingRow[];
  let lifetimeSpentCents = 0;
  let completedCount = 0;
  let noShowCount = 0;
  const serviceCounts = new Map<string, number>();

  for (const b of bookingRows) {
    const status = String(b.status ?? "");
    if (status === "completed") {
      completedCount += 1;
      lifetimeSpentCents += typeof b.price_cents === "number" ? b.price_cents : 0;
    }
    if (status === "no_show") noShowCount += 1;
    if (status !== "cancelled") {
      function resolveJoined(
        raw:
          | { name?: string | null }
          | Array<{ name?: string | null }>
          | null
          | undefined,
      ): string | null {
        const row = Array.isArray(raw) ? raw[0] ?? null : raw ?? null;
        return (row as { name?: string | null } | null)?.name?.trim() || null;
      }
      const svcName = resolveJoined(b.services);
      if (svcName) serviceCounts.set(svcName, (serviceCounts.get(svcName) ?? 0) + 1);
    }
  }

  function topName(map: Map<string, number>): string | null {
    let best: string | null = null;
    let bestCount = 0;
    for (const [name, count] of map) {
      if (count > bestCount) {
        best = name;
        bestCount = count;
      }
    }
    return best;
  }

  type ProfileRow = {
    id?: string | null;
    name?: string | null;
    is_vip?: boolean | null;
    no_show_count?: number | null;
  };
  const profile = profileRes.data as ProfileRow | null;

  type LastBookingRow = {
    start_time_utc?: string | null;
    services?: { name?: string | null } | Array<{ name?: string | null }> | null;
  };
  const lastBooking = lastBookingRes.data as LastBookingRow | null;

  function resolveJoinedName(
    raw:
      | { name?: string | null }
      | Array<{ name?: string | null }>
      | null
      | undefined,
  ): string | null {
    const row = Array.isArray(raw) ? raw[0] ?? null : raw ?? null;
    return (row as { name?: string | null } | null)?.name?.trim() || null;
  }

  const clientName = profile?.name?.trim() || "Client";
  const isVip = profile?.is_vip === true;
  const totalNoShows = Number(profile?.no_show_count ?? 0);
  const topService = topName(serviceCounts);
  const lifetimeSpentDollars = (lifetimeSpentCents / 100).toFixed(0);
  const lastVisitDate = lastBooking?.start_time_utc
    ? new Date(lastBooking.start_time_utc).toLocaleDateString("en-CA", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const lastServiceName = resolveJoinedName(lastBooking?.services);
  const preferredChannel =
    (notifRes.data as { channel?: string | null } | null)?.channel ?? "sms";
  const noShowRatePct =
    completedCount + noShowCount > 0
      ? Math.round((noShowCount / (completedCount + noShowCount)) * 100)
      : 0;

  // Build prompt
  const prompt = `You are a salon front-desk assistant. Based on this client snapshot, write a brief 360° summary and a specific next-action recommendation for the front-desk team.

Client: ${clientName}${isVip ? " (VIP)" : ""}
Phone: ${clientPhone}
Total visits: ${completedCount}
Lifetime spend: $${lifetimeSpentDollars}
No-show count: ${totalNoShows} (${noShowRatePct}% rate)
Favorite service: ${topService ?? "unknown"}
Last visit: ${lastVisitDate ?? "never"}${lastServiceName ? ` (${lastServiceName})` : ""}
Preferred contact: ${preferredChannel}

Respond ONLY with valid JSON in this exact format (no markdown, no extra text):
{"summary": "max 160 chars describing who this client is and their value", "nextAction": "max 120 chars specific action the front-desk should take next"}`;

  // Call Claude Haiku
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!anthropicKey) {
    return { ok: false, error: "anthropic_not_configured" };
  }

  let summaryText: string;
  let nextAction: string;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error("[generateClient360Summary] anthropic http", res.status);
      return { ok: false, error: `anthropic_http_${res.status}` };
    }

    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const raw = json.content?.[0]?.text?.trim() ?? "";
    if (!raw) return { ok: false, error: "empty_response" };

    // Defensive parse — Claude sometimes wraps JSON in ```json ... ```
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let parsed: { summary?: unknown; nextAction?: unknown };
    try {
      parsed = JSON.parse(jsonStr) as { summary?: unknown; nextAction?: unknown };
    } catch {
      console.error("[generateClient360Summary] JSON parse failed", raw);
      return { ok: false, error: "parse_failed" };
    }

    summaryText = typeof parsed.summary === "string" ? parsed.summary.slice(0, 160) : "";
    nextAction = typeof parsed.nextAction === "string" ? parsed.nextAction.slice(0, 120) : "";

    if (!summaryText || !nextAction) {
      return { ok: false, error: "incomplete_response" };
    }
  } catch (err) {
    console.error("[generateClient360Summary] fetch error", err);
    return { ok: false, error: "network_error" };
  }

  const computedAt = new Date().toISOString();

  // Cache in salon-scoped client_ai_summaries (PK salon_id + client_profile_id).
  const clientProfileId = (profileRes.data as ProfileRow | null)?.id ?? null;
  if (clientProfileId) {
    try {
      await supabase
        .from("client_ai_summaries" as never)
        .upsert(
          {
            salon_id: salonId,
            client_profile_id: clientProfileId,
            summary_text: summaryText,
            next_action: nextAction,
            visit_count: completedCount,
            computed_at: computedAt,
          } as never,
          { onConflict: "salon_id,client_profile_id" },
        );
    } catch (cacheErr) {
      // Cache failure is non-fatal — return the result anyway
      console.error("[generateClient360Summary] cache write", cacheErr);
    }
  }

  return { ok: true, text: summaryText, nextAction, computedAt };
}
