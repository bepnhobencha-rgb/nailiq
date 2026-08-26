// POST /api/booking/sms-confirm
// Sends bilingual confirmation SMS and tracks delivery status on the booking row.
// Checks customer_preferences for preferred language; defaults to Vietnamese.

import * as ErrorReporter from "@/shared/observability/errorReporter";
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildSmsConsentMeta } from "@/shared/booking/smsConsentRecord";
import { loadBookingSequenceReceipt } from "@/shared/booking/bookingSequenceReceiptServer";
import {
  classifyDurableConfirmationStatus,
  sendClaimedBookingConfirmationSms,
} from "@/shared/booking/claimedConfirmationSms";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import { consumeDurableRateLimitBuckets } from "@/shared/security/publicServerActionRateLimit";

export const dynamic = "force-dynamic";

type ConfirmationStatus = {
  status: string;
  messageSid: string | null;
};

type GroupFanoutFailure = {
  stage:
    | "organizer_status"
    | "member_query"
    | "token"
    | "member_claim"
    | "member_finalize"
    | "member_outcome"
    | "member_status";
  reason: string;
};

type GroupFanoutResult = {
  complete: boolean;
  eligible: number;
  completed: number;
  failures: GroupFanoutFailure[];
};

function incompleteGroupFanout(
  stage: GroupFanoutFailure["stage"],
  reason: string,
): GroupFanoutResult {
  return {
    complete: false,
    eligible: 0,
    completed: 0,
    failures: [{ stage, reason }],
  };
}

function formatConfirmDate(isoUtc: string, timezone = "America/Vancouver"): string {
  try {
    return new Date(isoUtc).toLocaleString("en-CA", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
      timeZoneName: "short",
    });
  } catch {
    return isoUtc;
  }
}

const BodySchema = z.object({
  bookingId: z.string().uuid(),
  salonId: z.string().uuid(),
  // Legacy display fields remain optional for caller compatibility, but the
  // route never trusts them. Recipient and appointment facts come from the
  // persisted booking/catalog rows below.
  clientPhone: z.string().min(1).optional(),
  clientName: z.string().nullish(),
  serviceName: z.string().nullish(),
  staffName: z.string().nullish(),
  startTimeUtc: z.string().min(1).optional(),
  /** Language the customer chose at booking — wins over any stored pref. */
  language: z.enum(["en", "vi"]).nullish(),
  /** Set (>1) for a GROUP booking → one party-summary message instead of a
   *  per-service line. serviceName is then not required. */
  partySize: z.number().int().positive().optional(),
  /** The customer ticked the required SMS-consent box in their browser. Callers
   *  that never showed a checkbox (desk, voice) must omit this — see
   *  smsConsentRecord.ts on why a fabricated record is worse than none. */
  smsConsent: z.boolean().optional(),
  /** Group id — used to label the consent record, never to widen the write. */
  groupId: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  const ipRate = await consumeDurableRateLimitBuckets("booking-sms-confirm", [
    { name: "ip-minute", material: [clientIp(req)], limit: 30, windowSeconds: 60 },
    { name: "ip-hour", material: [clientIp(req)], limit: 120, windowSeconds: 3_600 },
  ]);
  if (ipRate !== "allowed") {
    return NextResponse.json(
      { ok: false, error: ipRate === "limited" ? "rate_limited" : "rate_limit_unavailable" },
      { status: ipRate === "limited" ? 429 : 503, headers: { "Retry-After": ipRate === "limited" ? "60" : "30" } },
    );
  }
  const raw = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const {
    bookingId,
    salonId: requestedSalonId,
    language,
    smsConsent,
    groupId: requestedGroupId,
  } = parsed.data;

  const bookingRate = await consumeDurableRateLimitBuckets("booking-sms-confirm", [
    { name: "booking-hour", material: [bookingId], limit: 10, windowSeconds: 3_600 },
  ]);
  if (bookingRate !== "allowed") {
    return NextResponse.json(
      { ok: false, error: bookingRate === "limited" ? "rate_limited" : "rate_limit_unavailable" },
      { status: bookingRate === "limited" ? 429 : 503, headers: { "Retry-After": bookingRate === "limited" ? "3600" : "30" } },
    );
  }

  const db = createServiceRoleClient();

  // This route is public and uses the service-role client, so the booking must
  // be proven to belong to `salonId` before anything is written or texted.
  // Without it, a caller could stamp consent on another tenant's booking, and
  // `clientPhone` from the body turned this into an open SMS relay.
  const { data: bookingRow } = await db
    .from("bookings")
    .select(
      "id, salon_id, group_id, group_size, status, schedule_model, client_phone, client_name, service_id, staff_id, start_time_utc",
    )
    .eq("id", bookingId)
    .maybeSingle();

  const booking = bookingRow as
    | {
        id: string;
        salon_id: string;
        group_id: string | null;
        group_size: number | null;
        status: string | null;
        schedule_model: string | null;
        client_phone: string | null;
        client_name: string | null;
        service_id: string | null;
        staff_id: string | null;
        start_time_utc: string | null;
      }
    | null;

  if (!booking) return NextResponse.json({ ok: false, error: "booking_not_found" }, { status: 404 });
  if (booking.salon_id !== requestedSalonId) {
    return NextResponse.json({ ok: false, error: "salon_mismatch" }, { status: 403 });
  }
  if (requestedGroupId && booking.group_id !== requestedGroupId) {
    return NextResponse.json({ ok: false, error: "group_mismatch" }, { status: 403 });
  }

  const bookingStatus = booking.status?.trim().toLowerCase() || null;
  if (!bookingStatus) {
    return NextResponse.json(
      {
        ok: false,
        outcome: "not_sent",
        reason: "booking_status_unreadable",
      },
      { status: 503 },
    );
  }
  if (bookingStatus !== "confirmed") {
    const terminal = new Set(["cancelled", "no_show", "completed"]);
    return NextResponse.json(
      {
        ok: false,
        outcome: "not_sent",
        reason: terminal.has(bookingStatus)
          ? `booking_${bookingStatus}_not_sendable`
          : `booking_${bookingStatus}_not_confirmed`,
        bookingStatus,
      },
      { status: 409 },
    );
  }

  const scheduleModel = booking.schedule_model ?? "single";
  if (scheduleModel !== "single" && scheduleModel !== "segments_v1") {
    return NextResponse.json(
      { ok: false, error: "booking_schedule_unreadable" },
      { status: 503 },
    );
  }
  const sequenceLoad = scheduleModel === "segments_v1"
    ? await loadBookingSequenceReceipt({ salonId: booking.salon_id, bookingId })
    : null;
  if (sequenceLoad && !sequenceLoad.ok) {
    return NextResponse.json(
      { ok: false, error: "sequence_receipt_unavailable" },
      { status: 503 },
    );
  }
  const sequenceReceipt = sequenceLoad?.ok ? sequenceLoad.receipt : null;
  if (sequenceReceipt && sequenceReceipt.status !== "confirmed") {
    return NextResponse.json(
      { ok: false, error: "sequence_booking_not_confirmed" },
      { status: 409 },
    );
  }

  const salonId = booking.salon_id;
  const groupId = booking.group_id;

  // Destination comes from the booking row, never from the body.
  const clientPhone = booking.client_phone?.trim();
  if (!clientPhone) return NextResponse.json({ ok: false, error: "no_phone" }, { status: 400 });
  const startTimeUtc = sequenceReceipt?.parentStartTimeUtc ?? booking.start_time_utc?.trim();
  if (!startTimeUtc) {
    return NextResponse.json(
      { ok: false, error: "booking_time_missing" },
      { status: 409 },
    );
  }

  const [serviceResult, staffResult] = sequenceReceipt
    ? [{ data: null }, { data: null }]
    : await Promise.all([
    booking.service_id
      ? db
          .from("services")
          .select("name")
          .eq("id", booking.service_id)
          .eq("salon_id", salonId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    booking.staff_id
      ? db
          .from("staff")
          .select("name")
          .eq("id", booking.staff_id)
          .eq("salon_id", salonId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const serviceName = sequenceReceipt
    ? sequenceReceipt.segments.map((segment) => segment.serviceName).join(" + ")
    : (serviceResult.data as { name?: string | null } | null)?.name?.trim() || null;
  const staffName = sequenceReceipt
    ? [...new Set(sequenceReceipt.segments.map((segment) => segment.staffName))].join(", ")
    : (staffResult.data as { name?: string | null } | null)?.name?.trim() || null;
  const clientName = booking.client_name?.trim() || null;
  const partySize =
    typeof booking.group_size === "number" && booking.group_size > 1
      ? Math.floor(booking.group_size)
      : null;
  const isGroup = Boolean(groupId && partySize);

  if (!isGroup && !serviceName) {
    return NextResponse.json(
      { ok: false, error: "booking_service_missing" },
      { status: 409 },
    );
  }

  // Check if SMS is enabled for this salon
  const { data: salon } = await db
    .from("salons")
    .select("name, slug, subscription_plan, plan_override, address, sms_outbound_enabled, timezone, default_notification_locale")
    .eq("id", salonId)
    .maybeSingle();

  if (!salon) return NextResponse.json({ ok: false, error: "salon_not_found" }, { status: 404 });

  // Express SMS consent, recorded before the Twilio send so the record persists
  // whether or not the message goes out. It runs after the salon lookup because
  // the stored disclosure has to name the salon the customer actually read.
  //
  // Must be awaited: a PostgrestBuilder only issues its HTTP request from
  // `then()`, so the previous `void db.from(...).update(...)` built the query
  // and dropped it — no booking ever got a consent stamp.
  //
  // Stamped on THIS booking only. The group path used to fan out across
  // `group_id`, writing the organizer's IP and user agent onto every party
  // member's row as if each had consented personally. Only the organizer ticks
  // the box, and the party shares their phone, so the organizer's booking is
  // the one row the evidence belongs to.
  //
  // `.is("sms_consent_at", null)` keeps it first-write-wins: a retry must not
  // move the timestamp off the moment consent was actually given.
  if (smsConsent === true) {
    const meta = buildSmsConsentMeta(req, language, groupId ? "group_booking" : "public_booking", {
      groupId: groupId ?? undefined,
      salonName: salon.name ?? "",
    });
    const patch = { sms_consent_at: new Date().toISOString(), sms_consent_meta: meta } as never;

    const { error: consentError } = await db
      .from("bookings")
      .update(patch)
      .eq("id", bookingId)
      .eq("salon_id", salonId)
      .is("sms_consent_at", null);

    if (consentError) {
      // Consent evidence is a compliance artifact — never let it fail silently.
      console.error("[sms-confirm] consent record write failed", {
        bookingId,
        groupId,
        error: consentError.message,
      });
      ErrorReporter.captureException(new Error(`sms_consent write failed: ${consentError.message}`), {
        tags: { area: "sms_consent" },
        extra: { bookingId, groupId, salonId },
      });
    }
  }

  // Defense-in-depth for the Twilio kill-switch: flag E2E/test salons so
  // sendSmsReminder suppresses real SMS even if a seed number ever slips past
  // the 555-exchange guard. E2E fixtures use slugs prefixed "e2e-" / names
  // starting "E2E " (e.g. "E2E Group Salon") — no real tenant does.
  const salonSlug = (salon as { slug?: string | null }).slug ?? "";
  const salonIsTest =
    /^e2e[-_]/i.test(salonSlug) || /^e2e\b/i.test(salon.name ?? "");

  // Language precedence: the language the customer just chose at booking wins;
  // else their stored preference for this salon; else the SALON's configured
  // notification locale.
  //
  // That last step used to be a hardcoded "vi", which is how a California salon
  // whose default_notification_locale is "en" ended up texting a customer in
  // Vietnamese: the voice widget passes the language of the browser session, so
  // one Vietnamese-speaking person testing the flow picked the language for a
  // customer base that does not read it. The salon's own setting is the only
  // sensible default when we know nothing about the individual customer.
  const salonLocale: "en" | "vi" =
    (salon as { default_notification_locale?: string | null }).default_notification_locale === "vi"
      ? "vi"
      : "en";
  const requestedLang = language === "en" || language === "vi" ? language : null;

  const { data: profile } = await db
    .from("client_profiles")
    .select("id")
    .eq("phone", clientPhone)
    .is("deleted_at", null)
    .maybeSingle();
  let lang: "en" | "vi" = requestedLang ?? salonLocale;
  if (profile) {
    if (requestedLang) {
      // Persist the choice so future reminders for this customer match it.
      await db.from("customer_preferences").upsert(
        {
          client_profile_id: profile.id,
          salon_id: salonId,
          preferred_language: requestedLang,
        },
        { onConflict: "client_profile_id" },
      );
    } else {
      const { data: prefs } = await db
        .from("customer_preferences")
        .select("preferred_language")
        .eq("client_profile_id", profile.id)
        .eq("salon_id", salonId)
        .maybeSingle();
      lang = prefs?.preferred_language === "vi" || prefs?.preferred_language === "en"
        ? prefs.preferred_language
        : salonLocale;
    }
  }

  const salonTimezone = (salon as { timezone?: string | null }).timezone ?? "America/Vancouver";
  const dateStr = formatConfirmDate(startTimeUtc, salonTimezone);
  const salonName = salon.name ?? "";
  const boundedSequenceServiceName = sequenceReceipt && serviceName && serviceName.length > 180
    ? lang === "en"
      ? `${sequenceReceipt.segments.length} services`
      : `${sequenceReceipt.segments.length} dịch vụ`
    : serviceName ?? "";
  const boundedStaffName = staffName && staffName.length <= 120
    ? staffName
    : sequenceReceipt
      ? lang === "en"
        ? `${new Set(sequenceReceipt.segments.map((segment) => segment.resolvedStaffId)).size} staff`
        : `${new Set(sequenceReceipt.segments.map((segment) => segment.resolvedStaffId)).size} nhân viên`
      : null;
  const staff = boundedStaffName ? ` with ${boundedStaffName}` : "";

  const baseMessage = isGroup
    ? lang === "en"
      ? `✅ Group of ${partySize} booked at ${salonName} · ${dateStr}. Reply STOP to opt out.`
      : `✅ Đã đặt lịch nhóm ${partySize} người tại ${salonName} · ${dateStr}. Nhắn STOP để huỷ nhận tin.`
    : lang === "en"
      ? `✅ Booked! ${boundedSequenceServiceName}${staff} at ${salonName} · ${dateStr}. Reply STOP to opt out.`
      : `✅ Đã đặt lịch! ${boundedSequenceServiceName} tại ${salonName} · ${dateStr}. Nhắn STOP để huỷ nhận tin.`;

  // Append the salon ADDRESS as plain text (not a long Google Maps URL): phones
  // auto-link a street address → tap opens the user's default maps app, and it's
  // far shorter than an encoded maps URL (saves an SMS segment). The full
  // "Get directions" Google button stays in the confirmation EMAIL.
  const salonAddress = (salon as { address?: string | null }).address?.trim() || "";
  const addrLine = salonAddress ? `\n📍 ${salonAddress}` : "";

  const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
  const smsOutboundEnabled =
    (salon as { sms_outbound_enabled?: boolean | null }).sms_outbound_enabled !== false;
  // Status links are capability-scoped. Never expose a naked booking UUID in a
  // customer message or mint stronger reschedule/cancel rights from that UUID.
  let manageLink = "";
  if (smsOutboundEnabled && salonSlug && bookingId && !isGroup) {
    const statusCapability = await generateReminderToken(bookingId, salonId, {
      action: "status",
      expiresAt: new Date(Date.parse(startTimeUtc) + 2 * 60 * 60 * 1000).toISOString(),
    });
    if (statusCapability) {
      manageLink = `\nStatus: ${SITE_URL}/booking/status?token=${statusCapability.id}`;
    }
  }
  const message = baseMessage + addrLine + manageLink;
  const statusCallbackUrl = `${SITE_URL}/api/twilio/status`;
  // The salon-level switch is a hard operational kill-switch. Keep consent
  // evidence above, but do not call Twilio, stamp the booking as sent, or fan
  // out group-member texts while outbound SMS is disabled.
  const dispatch = await sendClaimedBookingConfirmationSms({
    bookingId,
    salonId,
    clientPhone,
    message,
    statusCallbackUrl,
    salonIsTest,
    lang: lang === "en" ? "en" : "vi",
    suppressionReason: smsOutboundEnabled ? undefined : "outbound_disabled",
  });
  const outcome = dispatch.outcome;
  const outcomeReason = dispatch.reason;
  const claimedRowId = dispatch.claimId;
  const acceptedMessageSid = dispatch.messageSid;
  const claimFinalized = dispatch.claimFinalized;

  // Track on bookings row (legacy columns kept for now).
  // Awaited: a PostgrestBuilder only issues its request from `then()`, so the
  // `void`-ed form here never wrote — every one of these columns was NULL.
  if (outcome === "accepted" || outcome === "rejected" || outcome === "unknown") {
    const trackingPatch =
      outcome === "accepted"
        ? { sms_confirmation_sent_at: new Date().toISOString() }
        : outcome === "rejected"
          ? {
              sms_confirmation_failed_at: new Date().toISOString(),
              sms_confirmation_error: outcomeReason,
            }
          : { sms_confirmation_error: `unknown:${outcomeReason}` };
    const { error: trackError } = await db
      .from("bookings")
      .update(trackingPatch)
      .eq("id", bookingId);
    if (trackError) console.error("[sms-confirm] sms_confirmation tracking write failed", trackError.message);
  }

  // Losing the unique claim proves only that another attempt owns/owned it. It
  // does not prove delivery. Inspect the durable row and never call Twilio from
  // this branch: in-flight, unknown, failed, malformed, and unreadable rows all
  // remain retryable only by an operator and surface 503 to this caller.
  let effectiveOutcome = outcome;
  let effectiveReason = outcomeReason;
  let effectiveMessageSid = acceptedMessageSid;
  let duplicateStatusFailure: string | null = null;
  if (
    claimFinalized &&
    outcome === "suppressed" &&
    outcomeReason === "duplicate"
  ) {
    const durable = await readConfirmationStatus(db, bookingId, salonId);
    if (!durable.ok) {
      duplicateStatusFailure = durable.reason;
      effectiveOutcome = "unknown";
      effectiveReason = durable.reason;
      effectiveMessageSid = null;
    } else {
      const classified = classifyDurableConfirmationStatus(
        durable.value.status,
        durable.value.messageSid,
      );
      effectiveOutcome = classified.outcome;
      effectiveReason = classified.reason;
      effectiveMessageSid = classified.messageSid;
      if (!classified.complete) duplicateStatusFailure = classified.reason;
    }
  }

  // ── Per-member SMS for group bookings ─────────────────────────────────────
  // A retry may arrive after the organizer was already durably accepted. The
  // organizer's unique claim suppresses a second provider attempt, so verify
  // its persisted exact receipt and resume only the still-unclaimed members.
  let groupFanout: GroupFanoutResult | null = null;
  if (smsOutboundEnabled && isGroup && groupId) {
    const organizerAuthorizesFanout =
      claimFinalized &&
      !duplicateStatusFailure &&
      effectiveOutcome === "accepted" &&
      (Boolean(claimedRowId) || outcomeReason === "duplicate");

    if (organizerAuthorizesFanout) {
      groupFanout = await sendGroupMemberSms({
        db,
        groupId,
        organizerBookingId: bookingId,
        organizerName: clientName ?? "",
        salonName: salonName,
        salonTimezone,
        salonIsTest,
        salonId,
        lang,
        statusCallbackUrl,
      });
    }
  }

  const fanoutIncomplete = groupFanout?.complete === false;

  const responseStatus =
    !claimFinalized || fanoutIncomplete || duplicateStatusFailure
      ? 503
      : effectiveOutcome === "accepted" || effectiveOutcome === "suppressed"
      ? 200
      : 503;
  return NextResponse.json(
    {
      ok:
        claimFinalized &&
        !fanoutIncomplete &&
        !duplicateStatusFailure &&
        (effectiveOutcome === "accepted" || effectiveOutcome === "suppressed"),
      outcome: effectiveOutcome,
      reason: !claimFinalized
        ? `claim_completion_failed:${outcomeReason}`
        : fanoutIncomplete
          ? `group_member_fanout_incomplete:${groupFanout?.failures[0]?.reason ?? "unknown"}`
          : effectiveReason,
      claimFinalized,
      ...(groupFanout ? { groupFanout } : {}),
      ...(effectiveOutcome === "accepted" && effectiveMessageSid
        ? { messageSid: effectiveMessageSid }
        : {}),
    },
    { status: responseStatus },
  );
}

async function readConfirmationStatus(
  db: ReturnType<typeof createServiceRoleClient>,
  bookingId: string,
  salonId: string,
): Promise<
  | { ok: true; value: ConfirmationStatus }
  | { ok: false; reason: string }
> {
  try {
    const { data, error } = await db
      .from("booking_notifications" as never)
      .select("status, twilio_message_sid")
      .eq("booking_id", bookingId)
      .eq("salon_id", salonId)
      .eq("notification_type", "booking_confirmation")
      .eq("channel", "sms")
      .maybeSingle();
    if (error) return { ok: false, reason: "status_query_failed" };
    const row = data as {
      status?: unknown;
      twilio_message_sid?: unknown;
    } | null;
    if (!row || typeof row.status !== "string") {
      return { ok: false, reason: "status_missing" };
    }
    return {
      ok: true,
      value: {
        status: row.status,
        messageSid:
          typeof row.twilio_message_sid === "string"
            ? row.twilio_message_sid
            : null,
      },
    };
  } catch {
    return { ok: false, reason: "status_query_exception" };
  }
}

async function sendGroupMemberSms(opts: {
  db: ReturnType<typeof createServiceRoleClient>;
  groupId: string;
  organizerBookingId: string;
  organizerName: string;
  salonName: string;
  salonTimezone: string;
  salonIsTest: boolean;
  salonId: string;
  statusCallbackUrl: string;
  /** Resolved by the caller (customer choice → stored pref → salon default).
   *  Everything below used to be hardcoded Vietnamese, so every guest of every
   *  party — including at English-speaking salons — got a Vietnamese text. */
  lang: "en" | "vi";
}): Promise<GroupFanoutResult> {
  const {
    db,
    groupId,
    organizerBookingId,
    organizerName,
    salonName,
    salonTimezone,
    salonIsTest,
    salonId,
    lang,
    statusCallbackUrl,
  } = opts;

  let memberRows: unknown;
  try {
    // Fetch all non-organizer bookings in the group. A query failure is not an
    // empty party: surface it so the caller can safely retry later.
    const { data, error } = await db
      .from("bookings" as never)
      .select(
        "id, salon_id, status, client_name, client_phone, start_time_utc, sms_consent_at, service:services!bookings_service_id_fkey(name), staff:staff!bookings_staff_id_fkey(name)",
      )
      .eq("group_id", groupId)
      .eq("salon_id", salonId)
      .eq("status", "confirmed")
      .not("sms_consent_at", "is", null)
      .neq("id", organizerBookingId);
    if (error) return incompleteGroupFanout("member_query", "member_query_failed");
    memberRows = data;
  } catch {
    return incompleteGroupFanout("member_query", "member_query_exception");
  }

  if (memberRows != null && !Array.isArray(memberRows)) {
    return incompleteGroupFanout("member_query", "member_query_invalid");
  }
  const members = (memberRows as Record<string, unknown>[] | null) ?? [];
  const eligibleMembers = members.filter((raw) => {
    const m = raw as {
      salon_id?: unknown;
      status?: unknown;
      client_phone?: unknown;
      start_time_utc?: unknown;
      sms_consent_at?: unknown;
    };
    return (
      m.salon_id === salonId &&
      m.status === "confirmed" &&
      typeof m.client_phone === "string" &&
      m.client_phone.length > 0 &&
      typeof m.start_time_utc === "string" &&
      m.start_time_utc.length > 0 &&
      typeof m.sms_consent_at === "string" &&
      m.sms_consent_at.length > 0
    );
  });
  const result: GroupFanoutResult = {
    complete: true,
    eligible: eligibleMembers.length,
    completed: 0,
    failures: [],
  };
  if (eligibleMembers.length === 0) return result;

  const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca").trim();

  for (const raw of eligibleMembers) {
    const m = raw as {
      id: string;
      client_phone: string;
      start_time_utc: string;
      service: { name?: string | null } | null;
      staff: { name?: string | null } | null;
    };

    let confirmCapability: Awaited<ReturnType<typeof generateReminderToken>>;
    let cancelCapability: Awaited<ReturnType<typeof generateReminderToken>>;
    try {
      // Independent member-own capabilities prevent a confirm bearer from
      // authorizing cancellation (or vice versa).
      [confirmCapability, cancelCapability] = await Promise.all([
        generateReminderToken(m.id, salonId, {
          action: "confirm",
          expiresAt: m.start_time_utc,
        }),
        generateReminderToken(m.id, salonId, {
          action: "cancel",
          expiresAt: m.start_time_utc,
        }),
      ]);
    } catch {
      result.failures.push({ stage: "token", reason: "token_exception" });
      continue;
    }
    if (!confirmCapability || !cancelCapability) {
      result.failures.push({ stage: "token", reason: "token_unavailable" });
      continue;
    }

    const dateStr = formatConfirmDate(m.start_time_utc, salonTimezone);
    const serviceName = m.service?.name?.trim() || null;
    const staffName = m.staff?.name?.trim() || null;
    const staffPart = staffName ? ` · ${staffName}` : "";
    const rsvpUrl = `${SITE_URL}/booking/group-rsvp?confirmToken=${encodeURIComponent(confirmCapability.id)}&cancelToken=${encodeURIComponent(cancelCapability.id)}&lang=${lang}`;

    const msg = (lang === "en"
      ? [
          `${organizerName || "Your group"} booked an appointment for you at ${salonName} · ${dateStr}.`,
          serviceName ? `Service: ${serviceName}${staffPart}.` : null,
          `Confirm you're coming: ${rsvpUrl}`,
        ]
      : [
          `${organizerName || "Nhóm"} đã đặt lịch cho bạn tại ${salonName} · ${dateStr}.`,
          serviceName ? `Dịch vụ: ${serviceName}${staffPart}.` : null,
          `Xác nhận tham dự: ${rsvpUrl}`,
        ])
      .filter(Boolean)
      .join(" ");

    let memberDispatch: Awaited<
      ReturnType<typeof sendClaimedBookingConfirmationSms>
    >;
    try {
      memberDispatch = await sendClaimedBookingConfirmationSms({
        bookingId: m.id,
        salonId,
        clientPhone: m.client_phone,
        message: msg,
        statusCallbackUrl,
        salonIsTest,
        lang,
      });
    } catch {
      result.failures.push({
        stage: "member_claim",
        reason: "member_claim_exception",
      });
      continue;
    }

    if (memberDispatch.outcome === "accepted" && memberDispatch.claimFinalized) {
      result.completed += 1;
      continue;
    }

    if (
      memberDispatch.outcome === "suppressed" &&
      memberDispatch.reason === "duplicate" &&
      memberDispatch.claimFinalized
    ) {
      const memberStatus = await readConfirmationStatus(db, m.id, salonId);
      const classified = memberStatus.ok
        ? classifyDurableConfirmationStatus(
            memberStatus.value.status,
            memberStatus.value.messageSid,
          )
        : null;
      if (classified?.complete) {
        result.completed += 1;
      } else {
        result.failures.push({
          stage: "member_status",
          reason:
            classified?.reason ??
            (memberStatus.ok ? "member_status_unreadable" : memberStatus.reason),
        });
      }
      continue;
    }

    result.failures.push({
      stage:
        !memberDispatch.claimFinalized && memberDispatch.claimId
          ? "member_finalize"
          : !memberDispatch.claimFinalized
            ? "member_claim"
            : "member_outcome",
      reason:
        !memberDispatch.claimFinalized && memberDispatch.claimId
          ? `member_finalize_failed:${memberDispatch.reason}`
          : `member_${memberDispatch.reason || memberDispatch.outcome}`,
    });
  }

  result.complete = result.failures.length === 0;
  return result;
}
