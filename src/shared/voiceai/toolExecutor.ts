import crypto from "crypto";
import { NextResponse, after } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { compareSpokenTimeToSlot, parseSpokenTime } from "@/shared/voiceai/spokenTime";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { logBookingEvent } from "@/shared/dashboard/auditLog";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { computeTimeSlots } from "@/shared/booking/getAvailableTimeSlots";
import { parseOpeningHours, type DayKey, type OpeningHoursWeek } from "@/shared/dashboard/openingHoursDefaults";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { voiceBookingLogicalIdempotencyKey } from "@/shared/voiceai/voiceBookingIdempotency";
import {
  parseVoiceGroupMode,
  voiceGroupBookingLogicalIdempotencyKey,
} from "@/shared/voiceai/voiceGroupBookingIdempotency";
import { parsePublicBookingPricingQuote } from "@/shared/booking/publicBookingPricing";
import { parseGroupBookingPricingQuote } from "@/shared/booking/groupBookingPricing";
import {
  createGroupBookingsAuthoritative,
  resolveGroupBookingQuote,
  type GroupBookingCreateServerRequest,
} from "@/shared/booking/groupBookingPricingServer";
import { reconcileCommittedBooking } from "@/shared/booking/reconcileCommittedBooking";
import { committedBookingLifecycleError } from "@/shared/booking/committedBookingLifecycle";
import {
  isClearVoicePricingConfirmation,
  toVoicePendingGroupPricing,
  toVoicePendingPricing,
} from "@/shared/voiceai/voicePricingConfirmation";
import { computeBookingTiming } from "@/shared/booking/bookingTiming";
import { checkGroupWithinOpeningHours } from "@/shared/booking/groupBookingHoursPolicy";
import { salonDayRangeUtc, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import {
  tryAlignedArrangement,
  buildArrangement,
  findFinishArrangementsInWindow,
  tryWaveArrangement,
  findEarliestWaveArrangement,
  buildWaveArrangement,
  type WaveRawAssignment,
  SLOT_STEP_MIN,
  type GroupArrangement,
  type ResolvedMember,
  type StaffRow,
  type ExistingBooking,
} from "@/shared/booking/groupSchedulerCore";
import {
  buildCapabilityMap,
  type StaffCapabilityMap,
} from "@/shared/booking/staffCapability";
import { eligibleVoiceAnyStaff } from "@/shared/voiceai/voiceAnyStaff";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { createPartyLink } from "@/shared/booking/partyLinkActions";
import { requirePhoneVerified } from "@/shared/voiceai/otpGate";
import type { GroupSyncMode } from "@/shared/booking/loadGroupSmartSchedule";
import { transferActiveTwilioCall } from "@/shared/lib/twilioCallTransfer";
import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "@/shared/voiceai/config";
import { chargeNoShowFee } from "@/shared/integrations/square/noshow";
import {
  buildLateCancellationLockPatch,
  evaluateLateCancellationPolicy,
  type LateCancellationBookingPolicy,
  type LateCancellationSalonPolicy,
} from "@/shared/noshow/lateCancellationPolicy";
import {
  cancelBookingWithManagementCapability,
  mintBookingManagementCapability,
} from "@/shared/booking/bookingManagementCapabilities";

/**
 * Shared receptionist tool executor.
 *
 * Extracted from /api/voice/tool/route.ts so BOTH receptionist surfaces reuse
 * the exact same battle-tested handlers:
 *   • /api/voice/tool   — OpenAI Realtime voice sessions (gated on voice_ai_enabled)
 *   • /api/chat/booking — text chat receptionist (gated by its own route)
 *
 * Callers are responsible for their own SURFACE gating (voice_ai_enabled, chat
 * feature flag, etc.) — this module does not re-check those. It DOES enforce the
 * identity gate on every mutating tool, so a surface cannot forget to.
 *
 * `baseUrl` is used for Party Link generation and for the internal OTP calls.
 *
 * `opts.callerVerifiedPhone` is the carrier-authenticated inbound number, and it
 * is ONLY ever set by the phone bridge (shared-secret header, checked in
 * /api/voice/tool). Any other surface — web voice, text chat — must leave it
 * unset, which forces the OTP tier. Defaulting to null here means a caller that
 * forgets the option gets the STRICTER path, never the weaker one.
 */
export async function executeVoiceTool(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  sessionId: string | null,
  baseUrl: string,
  opts?: {
    callerVerifiedPhone?: string | null;
    trustedUserUtterance?: string | null;
    trustedPhoneCallSid?: string | null;
    trustedCalledPhone?: string | null;
    trustedLanguage?: string | null;
  },
): Promise<NextResponse> {
  const callerVerifiedPhone = opts?.callerVerifiedPhone ?? null;
  const trustedUserUtterance = opts?.trustedUserUtterance ?? null;
  const trustedPhoneCallSid = opts?.trustedPhoneCallSid ?? null;
  const trustedCalledPhone = opts?.trustedCalledPhone ?? null;
  const requestedLanguage = (opts?.trustedLanguage ?? "") as SupportedLanguage;
  const trustedLanguage: SupportedLanguage = SUPPORTED_LANGUAGES.includes(requestedLanguage)
    ? requestedLanguage
    : "en";

  // Phase A deliberately keeps Voice on the existing one-main-service
  // contract. Do not silently choose the first item from a model-invented
  // sequence shape; public individual review is the only multi-service UI.
  if (
    (toolName === "get_available_slots" || toolName === "confirm_booking") &&
    (Array.isArray(toolArgs.service_id) ||
      Object.prototype.hasOwnProperty.call(toolArgs, "service_ids") ||
      Object.prototype.hasOwnProperty.call(toolArgs, "services") ||
      Object.prototype.hasOwnProperty.call(toolArgs, "lines"))
  ) {
    return NextResponse.json(
      { error: "multi_service_not_supported", code: "human_review_required" },
      { status: 409 },
    );
  }

  if (toolName === "get_available_slots") {
    return handleGetAvailableSlots(supabase, salonSlug, toolArgs);
  }
  if (toolName === "request_otp") {
    return handleRequestOtp(salonSlug, toolArgs, baseUrl);
  }
  if (toolName === "verify_otp") {
    return handleVerifyOtp(salonSlug, toolArgs, baseUrl);
  }
  if (toolName === "confirm_booking") {
    return handleConfirmBooking(supabase, salonSlug, toolArgs, sessionId, callerVerifiedPhone, trustedUserUtterance);
  }
  if (toolName === "find_booking") {
    return handleFindBooking(supabase, salonSlug, toolArgs);
  }
  if (toolName === "cancel_booking") {
    return handleCancelBooking(
      supabase,
      salonSlug,
      toolArgs,
      sessionId,
      callerVerifiedPhone,
      trustedUserUtterance,
    );
  }
  if (toolName === "reschedule_booking") {
    return handleRescheduleBooking(supabase, salonSlug, toolArgs, sessionId, callerVerifiedPhone);
  }
  if (toolName === "get_group_available_slots") {
    return handleGetGroupAvailableSlots(supabase, salonSlug, toolArgs);
  }
  if (toolName === "confirm_group_booking") {
    return handleConfirmGroupBooking(
      supabase,
      salonSlug,
      toolArgs,
      sessionId,
      baseUrl,
      callerVerifiedPhone,
      trustedUserUtterance,
    );
  }
  if (toolName === "join_waitlist") {
    return handleJoinWaitlist(supabase, salonSlug, toolArgs);
  }
  if (toolName === "lookup_customer") {
    return handleLookupCustomer(supabase, salonSlug, toolArgs, sessionId);
  }
  if (toolName === "transfer_to_human") {
    return handleTransferToHuman(
      supabase,
      salonSlug,
      toolArgs,
      sessionId,
      callerVerifiedPhone,
      trustedPhoneCallSid,
      trustedCalledPhone,
      trustedLanguage,
      baseUrl,
    );
  }
  if (toolName === "leave_message_for_owner") {
    return handleLeaveMessageForOwner(supabase, salonSlug, toolArgs, sessionId);
  }
  // end_call is a transport action: the phone bridge hangs up the line, and the
  // web widget closes the chat. There is nothing to do server-side, but it must
  // succeed (not "unknown_tool") so neither channel treats a normal goodbye as an
  // error.
  if (toolName === "end_call") {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown_tool", toolName }, { status: 400 });
}

const TRANSFER_REASON_MAX_CHARS = 500;
const TRANSFER_MAX_PER_SALON_PER_HOUR = 10;

async function handleTransferToHuman(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
  callerVerifiedPhone: string | null,
  trustedPhoneCallSid: string | null,
  trustedCalledPhone: string | null,
  language: SupportedLanguage,
  baseUrl: string,
): Promise<NextResponse> {
  // A browser or direct API caller never receives the trusted Twilio Call SID,
  // so it cannot make the platform dial an arbitrary active call.
  if (!trustedPhoneCallSid) {
    return NextResponse.json({
      success: false,
      error: "phone_transfer_unavailable",
      hint: "Apologise and use leave_message_for_owner instead.",
    });
  }

  const reason = (args.reason as string | undefined)?.trim().slice(0, TRANSFER_REASON_MAX_CHARS);
  const customerName = (args.customer_name as string | undefined)?.trim().slice(0, 120) ?? "";
  const urgency = args.urgency === "urgent" ? "urgent" : "normal";
  if (!reason) {
    return NextResponse.json({ success: false, error: "missing_reason" }, { status: 400 });
  }

  const { data: salon } = await supabase
    .from("salons")
    .select("id, name, voice_ai_transfer_phone")
    .eq("slug", salonSlug)
    .maybeSingle();
  const row = salon as {
    id?: string;
    name?: string | null;
    voice_ai_transfer_phone?: string | null;
  } | null;
  if (!row?.id) {
    return NextResponse.json({ success: false, error: "salon_not_found" }, { status: 404 });
  }
  const destinationPhone = row.voice_ai_transfer_phone?.trim();
  if (!destinationPhone) {
    return NextResponse.json({
      success: false,
      error: "transfer_phone_not_configured",
      hint: "Apologise and use leave_message_for_owner instead.",
    });
  }

  // Live transfers incur outbound voice charges. Count durable attempts rather
  // than process memory so a caller cannot reset the limit with a new session.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentCount } = await supabase
    .from("ai_actions_log")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", row.id)
    .eq("action_type", "voice_human_transfer")
    .gte("created_at", oneHourAgo);
  if ((recentCount ?? 0) >= TRANSFER_MAX_PER_SALON_PER_HOUR) {
    return NextResponse.json({
      success: false,
      error: "transfer_rate_limited",
      hint: "Apologise and use leave_message_for_owner instead. Do not retry the transfer.",
    });
  }

  // Persist the handoff context BEFORE redirecting the live call. Once Twilio
  // leaves the Media Stream, the AI session closes; this row is the reliable
  // fallback if the human destination is busy or does not answer.
  const { error: logError } = await supabase.from("ai_actions_log").insert({
    salon_id: row.id,
    agent: "receptionist",
    action_type: "voice_human_transfer",
    payload: {
      customer_name: customerName || null,
      customer_phone: callerVerifiedPhone,
      reason,
      urgency,
      voice_session_id: sessionId,
    },
  });
  if (logError) {
    console.error("[transfer_to_human] could not persist handoff", logError);
    return NextResponse.json({
      success: false,
      error: "transfer_log_failed",
      hint: "Apologise and use leave_message_for_owner instead.",
    }, { status: 503 });
  }

  try {
    const { sendOwnerAlert } = await import("@/shared/ai/sendOwnerAlert");
    const flag = urgency === "urgent" ? "🔴 KHẨN — " : "";
    await sendOwnerAlert(String(row.id), {
      subject: `${flag}Khách yêu cầu chuyển cuộc gọi${customerName ? ` — ${customerName}` : ""}`,
      bodyText:
        `Khách: ${customerName || "(không rõ tên)"}\n` +
        `SĐT: ${callerVerifiedPhone || "(không hiển thị)"}\n` +
        `Lý do: ${reason}\n\n` +
        `AI Tiếp tân đang chuyển cuộc gọi đến số người trực.`,
    });
  } catch (error) {
    // The durable dashboard row above remains the source of truth.
    console.error("[transfer_to_human] owner alert failed", error);
  }

  const transfer = await transferActiveTwilioCall({
    supabase,
    callSid: trustedPhoneCallSid,
    destinationPhone,
    calledPhone: trustedCalledPhone,
    language,
    statusCallbackUrl:
      `${baseUrl.replace(/\/$/, "")}/api/twilio/voice/transfer-result` +
      `?language=${encodeURIComponent(language)}`,
  });
  if (!transfer.ok) {
    return NextResponse.json({
      success: false,
      error: transfer.error,
      message_saved: true,
      hint:
        "Apologise that the live transfer is unavailable. Tell the caller the salon has their message and will follow up. Do not retry.",
    });
  }

  return NextResponse.json({
    success: true,
    transportAction: "transfer_call",
    message_saved: true,
  });
}

// request_otp — send a 6-digit SMS code to the customer's phone. Reuses the
// public booking OTP sender (Twilio Verify + rate-limit guard); no duplication.
async function handleRequestOtp(
  salonSlug: string,
  args: Record<string, unknown>,
  baseUrl: string,
): Promise<NextResponse> {
  const phone = (args.customer_phone as string | undefined)?.trim();
  if (!phone) return NextResponse.json({ error: "missing_customer_phone" }, { status: 400 });
  try {
    const r = await fetch(`${internalOrigin(baseUrl)}/api/booking-otp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopSlug: salonSlug, phone }),
    });
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (r.ok && data.ok) {
      return NextResponse.json({
        ok: true,
        message: "A 6-digit code was texted to the customer. Ask them to read it back, then call verify_otp.",
        // The customer's phone buzzes the moment this returns. If the agent stays
        // silent they get an unexplained code out of nowhere — one tester said so
        // in as many words: "I didn't hear you ask anything and suddenly I have
        // this number." Handing over the sentence guarantees it gets said.
        say_this: "I've just texted a 6-digit code to your phone. Could you read it back to me?",
      });
    }
    return NextResponse.json({
      ok: false,
      error: data.error ?? "otp_send_failed",
      hint: data.error === "rate_limited"
        ? "Too many codes were requested; wait a moment before trying again."
        : "Couldn't send the code; try again shortly.",
    });
  } catch {
    return NextResponse.json({ ok: false, error: "otp_send_failed", hint: "Temporary problem sending the code." });
  }
}

// verify_otp — check the code and, on success, return an otp_session_id that the
// mutating tools must carry as proof the caller controls this phone.
async function handleVerifyOtp(
  salonSlug: string,
  args: Record<string, unknown>,
  baseUrl: string,
): Promise<NextResponse> {
  const phone = (args.customer_phone as string | undefined)?.trim();
  const code = (args.code as string | undefined)?.trim();
  if (!phone || !code) return NextResponse.json({ error: "missing_phone_or_code" }, { status: 400 });
  try {
    const r = await fetch(`${internalOrigin(baseUrl)}/api/booking-otp/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopSlug: salonSlug, phone, code }),
    });
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; sessionId?: string; error?: string };
    if (r.ok && data.ok && data.sessionId) {
      return NextResponse.json({
        ok: true,
        otp_session_id: data.sessionId,
        message: "Phone verified. Pass otp_session_id to confirm/cancel/reschedule for this phone.",
      });
    }
    return NextResponse.json({
      ok: false,
      error: data.error ?? "otp_invalid",
      hint: "The code was wrong or expired. Offer to resend it with request_otp.",
    });
  } catch {
    return NextResponse.json({ ok: false, error: "otp_invalid", hint: "Temporary problem verifying the code." });
  }
}

// Internal origin for server-to-server calls to our own OTP endpoints. Prefers
// the configured public URL (as the route version did) and falls back to the
// caller's own origin, which is what keeps preview deployments self-consistent.
function internalOrigin(baseUrl: string): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || baseUrl;
}

/**
 * Last-9-digit suffix used to match a caller's phone against `client_phone`
 * (handles +84 / +1 / spaces / dashes), or null when the input is too short to
 * identify one person.
 *
 * The minimum matters: these lookups run as `ilike '%' || suffix` on a surface
 * reachable without auth, so a 1-digit input like "5" matched every booking
 * whose number ends in 5 and returned the customer's name, time, service and
 * staff. Ported from #781 — that fix landed in route.ts, which this module
 * replaced, so it has to live here or the hole silently reopens.
 */
const PHONE_SUFFIX_MIN_DIGITS = 7;

function phoneSuffixOrNull(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < PHONE_SUFFIX_MIN_DIGITS) return null;
  return digits.slice(-9);
}

const PHONE_TOO_SHORT = {
  error: "phone_too_short",
  hint: "Ask the customer to read out their full phone number, then try again.",
};

/** Best-effort per-tool-call log appended to voice_ai_sessions.tool_log (eval loop). */
export async function logVoiceToolCall(
  supabase: ReturnType<typeof createServiceRoleClient>,
  sessionId: string,
  toolName: string,
  httpStatus: number,
): Promise<void> {
  try {
    // Writes to `tool_log`, NOT `transcript`. They used to share one column and
    // the session-end write clobbered whatever this had appended.
    const { data } = await supabase
      .from("voice_ai_sessions")
      .select("tool_log")
      .eq("id", sessionId)
      .maybeSingle();
    const existing = Array.isArray((data as { tool_log?: unknown } | null)?.tool_log)
      ? ((data as { tool_log: unknown[] }).tool_log)
      : [];
    const entry = { at: new Date().toISOString(), type: "tool_call", tool: toolName, ok: httpStatus < 400 };
    // Keep the last 200 entries so the row never grows unbounded.
    await supabase
      .from("voice_ai_sessions")
      .update({ tool_log: [...existing.slice(-199), entry] } as never)
      .eq("id", sessionId);
  } catch { /* best-effort — logging must never break a live call */ }
}

async function handleGetAvailableSlots(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
) {
  const serviceId = args.service_id as string | undefined;
  const dateYmd   = args.date       as string | undefined;
  const staffId   = (args.staff_id  as string | undefined) ?? BOOKING_ANY_STAFF_ID;

  if (!serviceId || !dateYmd) {
    return NextResponse.json({ error: "missing_required_args: service_id, date" }, { status: 400 });
  }

  // Load salon + service + staff (timezone required for correct slot filtering)
  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone, opening_hours, booking_closed_dates")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  const { data: service } = await supabase
    .from("services")
    .select("duration_minutes")
    .eq("id", serviceId)
    .eq("salon_id", salon.id)
    .single();
  if (!service) return NextResponse.json({ error: "service_not_found" }, { status: 404 });

  const { data: staffRows } = await supabase
    .from("staff")
    .select("id, name, job_role")
    .eq("salon_id", salon.id)
    .eq("status", "active")
    .is("deleted_at", null);

  // Parse the requested date
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  if (!m) return NextResponse.json({ error: "invalid_date_format" }, { status: 400 });
  const selectedDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);

  // ── Timezone-aware slot computation ──────────────────────────────────────────
  //
  // Problem: Vercel runs in UTC. computeTimeSlots uses `setHours(0,0,0,0)` which
  // gives UTC midnight as the base. For a Vancouver (UTC-7) salon:
  //   • Server's "10:00 AM" slot = UTC midnight + 600 min = 10:00 UTC
  //   • Actual 10:00 AM PDT                                = 17:00 UTC
  // This causes the past-time filter and conflict check to use the wrong times.
  // Example: at 15:36 PDT (22:36 UTC) all salon slots (10:00–19:00 UTC) look
  // "past" and the AI says "no slots today" even with 4 hours remaining.
  //
  // Fix: compute the offset between salon local midnight and UTC midnight,
  // then shift nowMs and occupancy timestamps by that offset so all comparisons
  // inside computeTimeSlots use a consistent "local fake-UTC" frame.
  //
  // tzOffsetMs  = salonMidnightUtc - utcMidnight
  //   UTC-7:  07:00 UTC - 00:00 UTC = +7h   (25 200 000 ms)
  //   UTC+7:  17:00 UTC of prev day - 00:00 UTC of day = -7h (−25 200 000 ms)
  //
  // adjustedNowMs    = Date.now() − tzOffsetMs
  // adjustedOccupancy = occupancy shifted by −tzOffsetMs
  //
  // In the fake frame, slot "10:00 AM" (10:00 UTC fake) matches a booking at
  // 10:00 AM local (17:00 UTC real) shifted to 10:00 UTC fake. Overlap checks
  // and the past-time guard all produce correct results.
  // ─────────────────────────────────────────────────────────────────────────────
  const timezone = (salon as { timezone?: string }).timezone ?? "America/Los_Angeles";

  // Salon's local midnight expressed in UTC (DST-safe via binary-search Intl)
  const salonMidnightUtcMs = Date.parse(salonWallTimeToUtcIso(dateYmd, 0, timezone));
  // UTC midnight of the same calendar date (what setHours(0,0,0,0) gives on the server)
  const utcMidnightMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // How many ms ahead salon midnight is vs UTC midnight (+7h for UTC-7, −7h for UTC+7)
  const tzOffsetMs = salonMidnightUtcMs - utcMidnightMs;

  // Occupancy query: cover the full salon local day (midnight → midnight+24 h)
  // to capture bookings that spill into the next UTC day (e.g. 6 PM PDT = 01:00 UTC+1).
  const dayStart = new Date(salonMidnightUtcMs);
  const dayEnd   = new Date(salonMidnightUtcMs + 24 * 60 * 60 * 1000 - 1);

  const { data: occData } = await supabase.rpc("public_booking_occupancy_for_range", {
    p_salon_id: salon.id,
    p_start:    dayStart.toISOString(),
    p_end:      dayEnd.toISOString(),
  });

  // Check opening hours are parseable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const salonAny = salon as any;
  const week = parseOpeningHours(salonAny.opening_hours);
  if (!week) return NextResponse.json({ slots: [], reason: "invalid_hours_config" });

  const staffList = (staffRows ?? []).map((s) => ({
    id:       s.id,
    name:     s.name,
    job_role: s.job_role,
  }));

  // Shift occupancy timestamps into fake-UTC frame so conflict detection is correct.
  type OccRow = { staff_id: string; start_time_utc: string; end_time_utc: string };
  const adjustedOccupancy: OccRow[] = (occData ?? []).map((row: OccRow) => ({
    staff_id:       row.staff_id,
    start_time_utc: new Date(Date.parse(row.start_time_utc) - tzOffsetMs).toISOString(),
    end_time_utc:   new Date(Date.parse(row.end_time_utc)   - tzOffsetMs).toISOString(),
  }));

  const slots = computeTimeSlots({
    openingHoursRaw:        salonAny.opening_hours,
    selectedDate,
    staffId:                staffId === "any" ? BOOKING_ANY_STAFF_ID : staffId,
    staffList,
    serviceDurationMinutes: service.duration_minutes,
    occupancy:              adjustedOccupancy,
    // Shift nowMs into the same fake-UTC frame so the past-time filter
    // correctly hides slots that are already past in the salon's local timezone.
    nowMs:                  Date.now() - tzOffsetMs,
  });

  const available = slots.filter((s) => s.available).map((s) => s.label);
  return NextResponse.json({ slots: available, date: dateYmd, count: available.length });
}

/**
 * Parse a time-slot label (e.g. "2:00 PM", "9:30 AM") produced by
 * computeTimeSlots / formatSlotLabel and return minutes-from-midnight.
 */
function parseSlotLabelToMinutes(label: string): number | null {
  // Accepts "H:MM AM/PM" or "HH:MM AM/PM" (en-US locale format)
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(label.trim());
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  const period = m[3]!.toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

function scheduleVoiceBookingReconciliation(input: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  salonId: string;
  bookingId: string;
  sessionId: string | null;
  serviceId: string;
  serviceName: string;
  customerName: string;
  customerPhone: string;
  resolvedStaffName: string | null;
  startUtcIso: string;
  upsellAccepted?: boolean;
}): void {
  const appUrl =
    (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
  after(() =>
    reconcileCommittedBooking({
      bookingId: input.bookingId,
      salonId: input.salonId,
      channel: "voice",
      stamp: async () => {
        const { error } = await input.supabase
          .from("bookings")
          .update({ source: "voice", booking_channel: "voice" } as never)
          .eq("id", input.bookingId)
          .eq("salon_id", input.salonId);
        if (error) throw error;
      },
      ownerNotify: {
        salonId: input.salonId,
        bookingId: input.bookingId,
        event: "new",
      },
      audit: {
        actorUserId: null,
        actorRole: "system",
        eventType: "booking_created",
        payload: { source: "voice", serviceId: input.serviceId },
      },
      protectionChannel: "voice",
      jobs: [
        ...(input.sessionId
          ? [
              {
                name: "voice session link",
                run: async () => {
                  const { error } = await input.supabase
                    .from("voice_ai_sessions")
                    .update({
                      booking_id: input.bookingId,
                      status: "completed",
                      ...(input.upsellAccepted
                        ? { upsell_accepted: true }
                        : {}),
                    })
                    .eq("id", input.sessionId!);
                  if (error) throw error;
                },
              },
            ]
          : []),
        {
          name: "customer SMS confirmation",
          run: async () => {
            const smsRes = await fetch(`${appUrl}/api/booking/sms-confirm`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                bookingId: input.bookingId,
                salonId: input.salonId,
                clientPhone: input.customerPhone,
                clientName: input.customerName,
                serviceName: input.serviceName,
                staffName: input.resolvedStaffName ?? undefined,
                startTimeUtc: input.startUtcIso,
              }),
            });
            const smsJson = (await smsRes.json().catch(() => ({}))) as {
              ok?: boolean;
              error?: string;
            };
            if (!(smsRes.ok && smsJson.ok === true)) {
              console.warn(
                "[voice/confirm_booking] confirmation SMS not sent:",
                smsJson.error ?? `http_${smsRes.status}`,
              );
            }
          },
        },
      ],
    }),
  );
}

async function handleConfirmBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
  callerVerifiedPhone: string | null,
  /** The caller's most recent transcribed utterance, trusted ONLY when it came
   *  from the phone bridge (secret-gated in the route). Used to catch a model
   *  that put a different time in `time_slot` than the caller actually said. */
  trustedUserUtterance: string | null,
) {
  const serviceId     = args.service_id     as string | undefined;
  const date          = args.date           as string | undefined;  // YYYY-MM-DD
  const timeSlot      = args.time_slot      as string | undefined;  // e.g. "2:00 PM"
  const staffId       = args.staff_id       as string | undefined;  // UUID or "any"
  const customerName  = args.customer_name  as string | undefined;
  const customerPhone = args.customer_phone as string | undefined;
  const confirmedPricingFingerprint =
    typeof args.confirmed_pricing_fingerprint === "string"
      ? args.confirmed_pricing_fingerprint.trim().toLowerCase()
      : "";

  if (!serviceId || !date || !timeSlot || !staffId || !customerName || !customerPhone) {
    return NextResponse.json({ error: "missing_required_booking_fields" }, { status: 400 });
  }

  // Time-confirmation guard. If the caller's last utterance names a clear time
  // that disagrees with the slot the model chose, refuse the booking — a model
  // mistake here becomes a wrong appointment (a real call booked 5:30 PM after
  // the caller said "six" for 6:00). Only a POSITIVE mismatch blocks; when no
  // time is legible we defer to the read-back rule. The utterance is trusted
  // only from the bridge, so the model cannot suppress the check via its args.
  if (trustedUserUtterance) {
    const verdict = compareSpokenTimeToSlot(trustedUserUtterance, timeSlot);
    if (verdict === "mismatch") {
      const heard = parseSpokenTime(trustedUserUtterance);
      const heardLabel = heard
        ? `${heard.hour12}:${String(heard.minute ?? 0).padStart(2, "0")}${heard.period ? ` ${heard.period.toUpperCase()}` : ""}`
        : "(unclear)";
      return NextResponse.json({
        error: "time_confirmation_mismatch",
        heard_time: heardLabel,
        requested_time_slot: timeSlot,
        message:
          "The time in time_slot does not match what the customer just said. Apologise, read " +
          "back the exact time you are about to book, and wait for the customer to confirm before " +
          "calling confirm_booking again.",
      });
    }
  }

  // ── 1. Load salon by slug → get salon.id and timezone ──────────────────────
  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone, opening_hours, booking_closed_dates")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  // Identity gate — creating a booking requires proof the customer controls this
  // phone (caller-ID on the phone channel, else OTP). Stops fake/spam bookings.
  const gate = await requirePhoneVerified(supabase, salon.id, customerPhone, {
    otpSessionId: args.otp_session_id as string | undefined,
    callerVerifiedPhone,
  });
  if (!gate.ok) return NextResponse.json({ error: gate.error, hint: gate.hint });

  // ── 2. Load service → duration for end-time calc ────────────────────────────
  const { data: service } = await supabase
    .from("services")
    .select("id, name, duration_minutes, price_cents")
    .eq("id", serviceId)
    .eq("salon_id", salon.id)
    .single();
  if (!service) return NextResponse.json({ error: "service_not_found" }, { status: 404 });

  // ── 3. Resolve staff ────────────────────────────────────────────────────────
  // "any" → pick the first active staff who has NO conflicting booking at the
  // requested slot. Picking unconditionally by created_at caused slot_conflict
  // when that staff member was already booked, even if others were free.
  let resolvedStaffId: string | null = null;
  let resolvedStaffName: string | null = null;
  if (staffId !== "any" && staffId !== BOOKING_ANY_STAFF_ID) {
    resolvedStaffId = staffId;
    const { data: staffRow } = await supabase
      .from("staff").select("id, name").eq("id", staffId).single();
    resolvedStaffName = staffRow?.name ?? null;
  }
  // "any" resolution deferred to after time conversion so we can check occupancy.

  // ── 4. Convert date (YYYY-MM-DD) + timeSlot ("2:00 PM") → UTC timestamps ────
  //  Uses salonWallTimeToUtcIso from salonTime.ts (DST-safe Intl binary search)
  const timezone = (salon as { timezone?: string }).timezone ?? "America/Los_Angeles";
  const slotMins = parseSlotLabelToMinutes(timeSlot);
  if (slotMins === null) {
    return NextResponse.json({ error: "invalid_time_slot_format", received: timeSlot }, { status: 400 });
  }
  const endMins = slotMins + (service as { duration_minutes: number }).duration_minutes;

  let startUtcIso: string;
  let endUtcIso: string;
  try {
    startUtcIso = salonWallTimeToUtcIso(date, slotMins, timezone);
    endUtcIso   = salonWallTimeToUtcIso(date, endMins,  timezone);
  } catch (e) {
    return NextResponse.json({ error: "time_conversion_failed", detail: String(e) }, { status: 400 });
  }

  const canonicalPhone = toCanonicalPhone(customerPhone) ?? customerPhone;
  const idempotencyKey = voiceBookingLogicalIdempotencyKey({
    sessionId,
    salonId: String(salon.id),
    serviceId,
    requestedStaffId: staffId,
    date,
    timeSlot,
    customerName: customerName.trim(),
    customerPhone: canonicalPhone,
  });
  const hasConfirmedFingerprint = /^[a-f0-9]{64}$/.test(confirmedPricingFingerprint);
  const callerConfirmedPrice =
    hasConfirmedFingerprint && isClearVoicePricingConfirmation(trustedUserUtterance);

  // If the first transaction committed but its HTTP response was lost, its own
  // row now makes the assigned "Any" staff look occupied. Resolve the logical
  // idempotency key before availability, and replay only when the persisted
  // authoritative fingerprint is the exact one the caller confirmed.
  if (callerConfirmedPrice) {
    const { data: replayRow } = await supabase
      .from("bookings")
      .select(
        "id, status, service_id, staff_id, client_name, client_phone, start_time_utc, public_booking_pricing_fingerprint",
      )
      .eq("salon_id", salon.id)
      .eq("idempotency_key", idempotencyKey)
      .is("group_id", null)
      .is("recovered_from_booking_id", null)
      .maybeSingle();
    if (replayRow) {
      const persisted = replayRow as {
        id: string;
        status?: string | null;
        service_id?: string | null;
        staff_id?: string | null;
        client_name?: string | null;
        client_phone?: string | null;
        start_time_utc?: string | null;
        public_booking_pricing_fingerprint?: string | null;
      };
      const sameCoreIntent =
        String(persisted.service_id ?? "") === serviceId &&
        String(persisted.client_name ?? "").trim() === customerName.trim() &&
        String(persisted.client_phone ?? "") === canonicalPhone;
      if (!sameCoreIntent) {
        return NextResponse.json(
          { success: false, error: "idempotency_conflict" },
          { status: 409 },
        );
      }
      const lifecycleError = committedBookingLifecycleError({
        status: persisted.status,
        persistedStartTimeUtc: persisted.start_time_utc,
        requestedStartTimeUtc: startUtcIso,
      });
      if (lifecycleError) {
        return NextResponse.json(
          {
            success: false,
            error: lifecycleError,
            bookingId: persisted.id,
            current_status: persisted.status ?? null,
            current_start_time_utc: persisted.start_time_utc ?? null,
          },
          { status: 409 },
        );
      }
      if (
        staffId !== "any" &&
        staffId !== BOOKING_ANY_STAFF_ID &&
        String(persisted.staff_id ?? "") !== staffId
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "booking_rescheduled",
            bookingId: persisted.id,
            current_status: persisted.status ?? null,
            current_start_time_utc: persisted.start_time_utc ?? null,
            current_staff_id: persisted.staff_id ?? null,
          },
          { status: 409 },
        );
      }
      const persistedFingerprint = String(
        persisted.public_booking_pricing_fingerprint ?? "",
      );
      if (persistedFingerprint !== confirmedPricingFingerprint) {
        return NextResponse.json({
          success: false,
          error: "pricing_changed",
          requires_price_confirmation: true,
        }, { status: 409 });
      }
      const replayStaffId = String(persisted.staff_id ?? "");
      const { data: replayStaff } = replayStaffId
        ? await supabase.from("staff").select("name").eq("id", replayStaffId).maybeSingle()
        : { data: null };
      const replayStaffName = String((replayStaff as { name?: string | null } | null)?.name ?? "");
      const staffPart = replayStaffName ? ` with ${replayStaffName}` : "";
      const replayBookingId = persisted.id;
      scheduleVoiceBookingReconciliation({
        supabase,
        salonId: String(salon.id),
        bookingId: replayBookingId,
        sessionId,
        serviceId,
        serviceName: (service as { name: string }).name,
        customerName,
        customerPhone,
        resolvedStaffName: replayStaffName || null,
        startUtcIso,
      });
      return NextResponse.json({
        success: true,
        idempotent: true,
        bookingId: replayBookingId,
        serviceName: (service as { name: string }).name,
        date,
        timeSlot,
        staffName: replayStaffName || null,
        customerName,
        customerPhone,
        smsSent: "sending",
        say_this:
          `All set! I have you booked for ${(service as { name: string }).name} on ${date} at ${timeSlot}${staffPart}.` +
          " Your confirmation is already being delivered.",
      });
    }
  }

  // ── 4b. Resolve "any" staff → first active staff FREE at this specific slot ──
  if (staffId === "any" || staffId === BOOKING_ANY_STAFF_ID) {
    const { data: allStaff } = await supabase
      .from("staff")
      .select("id, name")
      .eq("salon_id", salon.id)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    const activeStaff = (allStaff ?? []).map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ""),
    }));
    const { data: capabilityRows } = activeStaff.length > 0
      ? await supabase
          .from("staff_services")
          .select("staff_id, service_id")
          .in("staff_id", activeStaff.map((row) => row.id))
      : { data: [] };
    const eligibleStaff = eligibleVoiceAnyStaff(
      activeStaff,
      (capabilityRows ?? []).map((row) => ({
        staff_id: String(row.staff_id),
        service_id: String(row.service_id),
      })),
      serviceId,
    );

    // Find first staff who has no overlapping active booking at this time
    for (const s of eligibleStaff) {
      const { data: conflicts } = await supabase
        .from("bookings")
        .select("id")
        .eq("staff_id", s.id)
        .not("status", "in", '("cancelled","waiting")')
        .lt("start_time_utc", endUtcIso)
        .gt("end_time_utc", startUtcIso)
        .limit(1);
      if (!conflicts || conflicts.length === 0) {
        resolvedStaffId   = s.id;
        resolvedStaffName = s.name;
        break;
      }
    }
    if (!resolvedStaffId) {
      return NextResponse.json({ error: "no_staff_available" }, { status: 409 });
    }
  }

  if (!resolvedStaffId) {
    return NextResponse.json({ error: "no_staff_available" }, { status: 409 });
  }
  const { data: quoteData, error: quoteError } = await supabase.rpc(
    "resolve_public_booking_pricing" as never,
    {
      p_salon_id: salon.id,
      p_service_id: serviceId,
      p_staff_id: resolvedStaffId,
      p_start_time_utc: startUtcIso,
      p_end_time_utc: endUtcIso,
      p_addon_service_ids: [],
      p_combo_id: null,
      p_voucher_id: null,
      p_client_phone: canonicalPhone,
      p_client_email: null,
      p_apply_email_discount: false,
      p_lock_claims: false,
    } as never,
  );
  const quoteRaw = Array.isArray(quoteData) ? quoteData[0] : quoteData;
  const quote = parsePublicBookingPricingQuote(quoteRaw, {
    resolvedStaffId,
    resolvedStaffName,
  });
  if (quoteError || !quote) {
    return NextResponse.json({ error: "pricing_unavailable" }, { status: 503 });
  }
  const pendingPricing = toVoicePendingPricing(quote);
  if (!callerConfirmedPrice) {
    return NextResponse.json({
      success: false,
      error:
        confirmedPricingFingerprint && !hasConfirmedFingerprint
          ? "pricing_changed"
          : "pricing_confirmation_required",
      requires_price_confirmation: true,
      quote: pendingPricing,
      message:
        "Read back the exact total and currency. Ask for a clear yes, then call confirm_booking again with this exact confirmed_pricing_fingerprint.",
    });
  }
  // ── 5. Create with the exact quote just resolved. Provider retries use the
  // same deterministic key, so they replay instead of creating a second row.
  const { data: rpcData, error: rpcErr } = await supabase.rpc("create_public_booking", {
    p_salon_id:      salon.id,
    p_service_id:    serviceId,
    p_staff_id:      resolvedStaffId,
    p_client_name:   customerName,
    p_client_phone:  canonicalPhone,
    p_start_time_utc: startUtcIso,
    p_end_time_utc:   endUtcIso,
    p_status:         "confirmed",
    p_client_notes:   "Voice booking",
    p_addon_service_ids: [],
    p_client_email: null,
    p_resource_id: null,
    p_combo_id: null,
    p_voucher_id: null,
    p_apply_email_discount: false,
    p_idempotency_key: idempotencyKey,
    // Send the customer-confirmed snapshot, not the just-refreshed quote. This
    // lets create_public_booking replay an already-committed idempotent request
    // before its pricing check; on a first attempt, a stale fingerprint returns
    // pricing_changed with zero writes.
    p_expected_pricing_fingerprint: confirmedPricingFingerprint,
  });

  if (rpcErr) {
    console.error("[voice/confirm_booking] RPC error:", rpcErr);
    const errObj = rpcErr as { code?: string; message?: string };
    // P0002 = no_data_found (slot conflict)
    if (errObj.code === "P0002" || errObj.code === "23P01") {
      return NextResponse.json({ error: "slot_conflict", message: "Time slot is no longer available." }, { status: 409 });
    }
    return NextResponse.json({ error: "booking_failed", detail: errObj.message }, { status: 500 });
  }

  // RPC returns jsonb: { success, booking_id, ... } or { success: false, code: ... }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as any;
  if (!result?.success) {
    const code = result?.code ?? "unknown";
    if (code === "pricing_changed") {
      const changed = parsePublicBookingPricingQuote(result.quote, {
        resolvedStaffId,
        resolvedStaffName,
      });
      if (!changed) {
        return NextResponse.json({ error: "pricing_unavailable" }, { status: 503 });
      }
      return NextResponse.json({
        success: false,
        error: "pricing_changed",
        requires_price_confirmation: true,
        quote: toVoicePendingPricing(changed),
        message: "The price changed before booking. Read back the updated total and ask the customer to confirm again.",
      }, { status: 409 });
    }
    return NextResponse.json({ error: "booking_failed", code }, { status: 409 });
  }

  const bookingId = result.booking_id ?? null;
  if (bookingId) {
    scheduleVoiceBookingReconciliation({
      supabase,
      salonId: String(salon.id),
      bookingId,
      sessionId,
      serviceId,
      serviceName: (service as { name: string }).name,
      customerName,
      customerPhone,
      resolvedStaffName,
      startUtcIso,
      upsellAccepted: args.upsell_accepted === true,
    });
  }

  // `say_this` is the closing sentence, assembled here from what was actually
  // written to the database. Three prompt rewrites failed to get the agent to
  // state these details — it kept announcing the closing instead of delivering
  // it. Composing it server-side removes the judgement call.
  //
  // Built from the resolved values (staff especially — the salon may assign
  // someone other than whoever was discussed), so it cannot drift from reality.
  // The text is on its way (sent in the background); the agent then asks whether
  // it arrived, per the closing rule.
  const staffPart = resolvedStaffName ? ` with ${resolvedStaffName}` : "";
  const sayThis =
    `All set! I have you booked for ${(service as { name: string }).name} on ${date} at ${timeSlot}${staffPart}.` +
    " I'm texting your confirmation now — you should get it in a moment.";

  return NextResponse.json({
    success:      true,
    bookingId,
    serviceName:  (service as { name: string }).name,
    date,
    timeSlot,
    staffName:    resolvedStaffName ?? null,
    customerName,
    customerPhone,
    smsSent:      "sending",
    say_this:     sayThis,
  });
}

// ─── cancel_booking ──────────────────────────────────────────────────────────
// Cancel an existing booking by setting status = 'cancelled'.
//
// Two input modes:
//   A) booking_id provided  → cancel immediately (trust that AI already confirmed verbally)
//   B) customer_phone only  → phone lookup mode: find upcoming booking(s) and return
//      details WITHOUT cancelling (confirmation_required: true). AI must read back
//      the booking to the customer, get verbal OK, then call again with booking_id.
//
// This eliminates the "AI skips find_booking → passes phone as booking_id" bug.
type VoiceCancelSalon = {
  id: string;
  timezone?: string | null;
  currency_code?: string | null;
  self_cancel_fee_enabled?: boolean | null;
  self_cancel_window_hours?: number | null;
  self_cancel_fee_percent?: number | null;
  noshow_fee_percent?: number | null;
};

type VoiceCancelBooking = {
  start_time_utc: string;
  noshow_card_id?: string | null;
  noshow_consent_at?: string | null;
  noshow_fee_cents?: number | null;
  noshow_charge_status?: string | null;
  self_cancel_fee_locked_at?: string | null;
  self_cancel_fee_locked_cents?: number | null;
};

function voiceSalonLatePolicy(salon: VoiceCancelSalon): LateCancellationSalonPolicy {
  return {
    selfCancelFeeEnabled: salon.self_cancel_fee_enabled ?? false,
    selfCancelWindowHours: salon.self_cancel_window_hours ?? 24,
    selfCancelFeePercent: salon.self_cancel_fee_percent ?? null,
    noShowFeePercent: salon.noshow_fee_percent ?? null,
  };
}

function voiceBookingLatePolicy(
  booking: VoiceCancelBooking,
): LateCancellationBookingPolicy {
  return {
    startTimeUtc: booking.start_time_utc,
    noShowFeeCents: booking.noshow_fee_cents ?? null,
    noShowCardId: booking.noshow_card_id ?? null,
    noShowConsentAt: booking.noshow_consent_at ?? null,
    noShowChargeStatus: booking.noshow_charge_status ?? null,
    selfCancelFeeLockedAt: booking.self_cancel_fee_locked_at ?? null,
    selfCancelFeeLockedCents: booking.self_cancel_fee_locked_cents ?? null,
  };
}

function isExplicitFeeAcknowledgement(utterance: string | null): boolean {
  if (!utterance) return false;
  const normalized = utterance
    .trim()
    .toLocaleLowerCase()
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ");
  return new Set([
    "yes",
    "yes please",
    "i agree",
    "that's okay",
    "thats okay",
    "charge it",
    "ok",
    "okay",
    "đồng ý",
    "tôi đồng ý",
    "dạ",
    "vâng",
    "được",
    "thu đi",
    "sí",
    "si",
    "de acuerdo",
    "acepto",
    "oui",
    "d'accord",
    "j'accepte",
    "是",
    "可以",
    "同意",
    "好的",
  ]).has(normalized);
}

const LATE_FEE_CHALLENGE_TTL_MS = 5 * 60_000;

function utteranceFingerprint(utterance: string | null): string {
  return crypto
    .createHash("sha256")
    .update(utterance?.trim() ?? "")
    .digest("base64url");
}

function issueLateFeeChallenge(input: {
  bookingId: string;
  feeCents: number;
  sessionId: string | null;
  currentUtterance: string | null;
}): string | null {
  const secret = process.env.VOICE_BRIDGE_SECRET?.trim();
  if (!secret) return null;
  const payload = Buffer.from(
    JSON.stringify({
      bookingId: input.bookingId,
      feeCents: input.feeCents,
      sessionId: input.sessionId ?? "",
      issuedAt: Date.now(),
      priorUtterance: utteranceFingerprint(input.currentUtterance),
    }),
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function validateLateFeeChallenge(input: {
  token: string | null;
  bookingId: string;
  feeCents: number;
  sessionId: string | null;
  currentUtterance: string | null;
}): boolean {
  const secret = process.env.VOICE_BRIDGE_SECRET?.trim();
  if (!secret || !input.token || !input.currentUtterance) return false;
  const [payload, suppliedSignature, ...extra] = input.token.split(".");
  if (!payload || !suppliedSignature || extra.length > 0) return false;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
  } catch {
    return false;
  }
  if (
    supplied.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(supplied, expectedSignature)
  ) {
    return false;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
      bookingId?: unknown;
      feeCents?: unknown;
      sessionId?: unknown;
      issuedAt?: unknown;
      priorUtterance?: unknown;
    };
    const ageMs = Date.now() - Number(parsed.issuedAt);
    return (
      parsed.bookingId === input.bookingId &&
      parsed.feeCents === input.feeCents &&
      parsed.sessionId === (input.sessionId ?? "") &&
      Number.isFinite(ageMs) &&
      ageMs >= 0 &&
      ageMs <= LATE_FEE_CHALLENGE_TTL_MS &&
      parsed.priorUtterance !== utteranceFingerprint(input.currentUtterance) &&
      isExplicitFeeAcknowledgement(input.currentUtterance)
    );
  } catch {
    return false;
  }
}

function stableVoiceCancelRequestId(bookingId: string): string {
  const bytes = crypto.createHash("sha256")
    .update(`nailiq:voice-cancel:v1:${bookingId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function handleCancelBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
  callerVerifiedPhone: string | null,
  trustedUserUtterance: string | null,
) {
  const bookingId     = args.booking_id     as string | undefined;
  const customerPhone = args.customer_phone as string | undefined;
  const reason        = (args.reason as string | undefined) ?? "customer_request";
  const groupIdArg    = args.group_id     as string | undefined;

  // At least one identifier is required. group_id counts: it is how the model
  // asks for a whole-party cancel after the phone lookup hands it one.
  if (!bookingId && !customerPhone && !groupIdArg) {
    return NextResponse.json(
      { error: "missing_booking_id_or_phone",
        hint: "Provide booking_id (if known), group_id (to cancel a whole party), or customer_phone to look up the booking." },
      { status: 400 },
    );
  }

  // Load salon → needed for both paths
  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone, currency_code, self_cancel_fee_enabled, self_cancel_window_hours, self_cancel_fee_percent, noshow_fee_percent")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  const cancelSalon = salon as VoiceCancelSalon;
  const tz = cancelSalon.timezone ?? "America/Los_Angeles";
  const latePolicy = voiceSalonLatePolicy(cancelSalon);
  const currency = cancelSalon.currency_code ?? "USD";
  const lateFeeAcknowledged = args.late_fee_acknowledged === true;
  const lateFeeConfirmationToken =
    typeof args.late_fee_confirmation_token === "string"
      ? args.late_fee_confirmation_token
      : null;

  // ── Path A: group_id → cancel the WHOLE party ───────────────────────────────
  // Checked FIRST, and before the phone lookup: the phone branch below returns on
  // every path, so while this sat after it there was no argument combination that
  // could reach it — whole-party cancel was unreachable code. The phone branch's
  // own hint tells the model to come back with group_id, so that instruction had
  // nowhere to land.
  if (!bookingId && groupIdArg) {
    // Fetch the WHOLE party, cancelled rows included: only the active rows get
    // cancelled, but the phone we verify against may sit on a row that is
    // already cancelled (e.g. the organizer dropped out first).
    const { data: groupRows, error: grpErr } = await supabase
      .from("bookings")
      .select("id, status, client_phone, is_group_organizer, start_time_utc, noshow_card_id, noshow_consent_at, noshow_fee_cents, noshow_charge_status, self_cancel_fee_locked_at, self_cancel_fee_locked_cents")
      .eq("salon_id", salon.id)
      .eq("group_id", groupIdArg);

    const party = (groupRows ?? []) as (VoiceCancelBooking & {
      id: string;
      status: string;
      client_phone: string | null;
      is_group_organizer: boolean | null;
    })[];
    const active = party.filter((r) => r.status !== "cancelled");

    if (grpErr || active.length === 0) {
      return NextResponse.json({ error: "group_not_found_or_already_cancelled" }, { status: 404 });
    }

    // Identity gate (ported from #781 — it landed in route.ts, which this module
    // replaced). Cancelling a whole party is the most destructive thing the
    // receptionist can do, and the phone branch above hands out `group_id` with
    // a hint spelling out the full-cancel call, so without this anyone who saw
    // a party's id could wipe it.
    //
    // Verify against the organizer's phone: in a group booking only member 0
    // supplies a real number, guest rows are frequently blank — so a "first
    // row" fallback would hand requirePhoneVerified an empty string and break
    // legitimate cancels (107 of 231 production group rows have no usable phone).
    const usablePhone = (p: string | null): boolean =>
      typeof p === "string" && p.replace(/\D/g, "").length >= PHONE_SUFFIX_MIN_DIGITS;
    const ownerPhone =
      party.find((r) => r.is_group_organizer && usablePhone(r.client_phone))?.client_phone
      ?? party.find((r) => usablePhone(r.client_phone))?.client_phone
      ?? null;

    if (!ownerPhone) {
      return NextResponse.json({
        error: "group_not_verifiable",
        hint: "This party has no phone number on file, so I can't verify who it belongs to. Ask the customer to contact the salon directly.",
      });
    }

    const gate = await requirePhoneVerified(supabase, salon.id, ownerPhone, {
      otpSessionId: args.otp_session_id as string | undefined,
      callerVerifiedPhone,
    });
    if (!gate.ok) return NextResponse.json({ error: gate.error, hint: gate.hint });

    const chargeableLateMembers = active.filter((row) =>
      evaluateLateCancellationPolicy({
        booking: voiceBookingLatePolicy(row),
        salon: latePolicy,
      }).willCharge,
    );
    if (chargeableLateMembers.length > 0) {
      return NextResponse.json({
        error: "late_fee_requires_staff",
        fee_confirmation_required: true,
        chargeable_count: chargeableLateMembers.length,
        currency,
        hint:
          "This group cancellation includes card charges. Do not cancel it by voice; ask the customer to contact the salon so staff can review the whole party and choose charge or waive.",
      });
    }

    const ids = active.map((r) => r.id);
    const { error: cancelErr } = await supabase
      .from("bookings")
      .update({ status: "cancelled" })
      .in("id", ids);

    if (cancelErr) {
      return NextResponse.json({ error: "cancel_failed", detail: cancelErr.message }, { status: 500 });
    }

    // Audit log — one entry per booking in the group
    ids.forEach((id) =>
      void logBookingEvent({
        bookingId: id,
        salonId: String(salon.id),
        actorUserId: null,
        actorRole: "system",
        eventType: "booking_cancelled",
        payload: { reason: "voice_ai_group_cancel", group_id: groupIdArg },
      }),
    );

    // Owner/admin "cancelled" alert — one email for the group (first booking).
    if (ids[0]) {
      after(() =>
        sendOwnerBookingNotification({
          salonId: String(salon.id),
          bookingId: ids[0],
          event: "cancel",
        }),
      );
    }

    return NextResponse.json({
      success:        true,
      cancelled_count: ids.length,
      group_id:        groupIdArg,
      message: `Đã huỷ thành công ${ids.length} lịch trong nhóm.`,
    });
  }

  // ── Path B: phone lookup (no booking_id, no group_id) ───────────────────────
  if (!bookingId && !groupIdArg && customerPhone) {
    const last9 = phoneSuffixOrNull(customerPhone);
    if (!last9) return NextResponse.json(PHONE_TOO_SHORT);
    const now = new Date().toISOString();

    // Limit 20 — group bookings create one row per member (8-person group = 8 rows).
    // Old limit of 3 caused "only 3 cancelled out of 8" for group bookings.
    // Include staff join so AI can read individual member slots for partial cancellation.
    const { data: phoneRows } = await supabase
      .from("bookings")
      .select("id, group_id, client_name, start_time_utc, status, noshow_card_id, noshow_consent_at, noshow_fee_cents, noshow_charge_status, self_cancel_fee_locked_at, self_cancel_fee_locked_cents, services!bookings_service_id_fkey(name), staff!bookings_staff_id_fkey(name)")
      .eq("salon_id", salon.id)
      .ilike("client_phone", `%${last9}`)
      .gte("start_time_utc", now)
      .neq("status", "cancelled")
      .order("start_time_utc", { ascending: true })
      .limit(20);

    if (!phoneRows || phoneRows.length === 0) {
      return NextResponse.json({
        error:   "booking_not_found",
        message: "Không tìm thấy lịch hẹn nào sắp tới cho số điện thoại này.",
      }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formatRow = (r: Record<string, any>) => {
      const svcRaw  = r.services as { name?: string } | { name?: string }[] | null;
      const svcName = (Array.isArray(svcRaw) ? svcRaw[0]?.name : svcRaw?.name) ?? "Unknown";
      // Staff join returns a single object (many-to-one FK)
      const staffRaw  = r.staff as { name?: string } | null;
      const staffName = staffRaw?.name ?? null;
      const localTime = new Date(r.start_time_utc as string).toLocaleString("en-US", {
        timeZone: tz, weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      });
      const fee = evaluateLateCancellationPolicy({
        booking: voiceBookingLatePolicy(r as VoiceCancelBooking),
        salon: latePolicy,
      });
      return {
        booking_id:   r.id as string,
        group_id:     (r.group_id as string | null) ?? null,
        service_name: svcName,
        staff_name:   staffName,
        date_time:    localTime,
        status:       r.status as string,
        client_name:  r.client_name as string,
        late_cancel_fee: fee.willCharge
          ? {
              confirmation_required: true,
              amount_cents: fee.feeCents,
              currency,
              policy_locked_by_reschedule: fee.policyLockedByReschedule,
            }
          : null,
      };
    };

    const rows = phoneRows.map(formatRow);

    // Detect group bookings: all rows sharing the same non-null group_id
    const firstGroupId = rows[0]?.group_id ?? null;
    const allSameGroup = firstGroupId !== null && rows.every((r) => r.group_id === firstGroupId);

    if (allSameGroup) {
      // Group booking — let the customer choose full or partial cancellation.
      // Each row in `bookings` includes service_name, staff_name, date_time so the
      // AI can read individual member slots for partial cancellation.
      return NextResponse.json({
        confirmation_required: true,
        is_group_booking:      true,
        group_id:              firstGroupId,
        group_size:            rows.length,
        bookings:              rows,
        hint:
          `GROUP BOOKING of ${rows.length} people. ` +
          `STEP 1 — Ask: "Bạn muốn huỷ cả nhóm ${rows.length} người, hay chỉ một số người?" ` +
          `FULL CANCEL: call cancel_booking with group_id="${firstGroupId}" — cancels all ${rows.length} at once. ` +
          `PARTIAL CANCEL: read each member's slot (e.g. "Guest 1: Pedicure lúc 12:00 với Jenny"), ` +
          `ask which ones to cancel, then call cancel_booking(booking_id) for each confirmed cancellation individually. ` +
          `After partial cancel: confirm total cancelled (e.g. "Đã huỷ 2 người. ${rows.length - 2} người còn lại giữ nguyên lịch.").`,
      });
    }

    if (rows.length > 1) {
      // Multiple independent bookings — AI must ask which to cancel
      return NextResponse.json({
        confirmation_required: true,
        multiple_bookings:     true,
        bookings:              rows,
        hint: "Multiple upcoming bookings found. Read them back to the customer, ask which one to cancel, then call cancel_booking(booking_id) with their choice.",
      });
    }

    // Exactly one individual booking — return for verbal confirmation before cancelling
    return NextResponse.json({
      confirmation_required: true,
      booking:               rows[0]!,
      hint: "Read this booking back to the customer and ask them to confirm cancellation. Then call cancel_booking(booking_id) with the booking_id above to execute.",
    });
  }

  // ── Path C: booking_id provided → cancel that one booking ───────────────────
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, salon_id, status, client_name, client_phone, group_id, start_time_utc, noshow_card_id, noshow_consent_at, noshow_fee_cents, noshow_charge_status, self_cancel_fee_locked_at, self_cancel_fee_locked_cents, services!bookings_service_id_fkey(name)")
    .eq("id", bookingId!)
    .eq("salon_id", salon.id)
    .single();

  if (!booking) return NextResponse.json({ error: "booking_not_found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bk = booking as any as {
    id: string; status: string; client_name: string; client_phone: string;
    group_id: string | null;
    start_time_utc: string;
    noshow_card_id: string | null;
    noshow_consent_at: string | null;
    noshow_fee_cents: number | null;
    noshow_charge_status: string | null;
    self_cancel_fee_locked_at: string | null;
    self_cancel_fee_locked_cents: number | null;
    services: { name: string } | { name: string }[] | null;
  };
  const serviceName = Array.isArray(bk.services)
    ? (bk.services[0]?.name ?? "Unknown")
    : (bk.services?.name ?? "Unknown");

  if (bk.status === "cancelled") {
    return NextResponse.json({ error: "already_cancelled" }, { status: 409 });
  }

  // Identity gate — verify against the phone that OWNS this booking (never a
  // number the caller merely spoke). This is what stops a caller cancelling
  // someone else's appointment.
  const gate = await requirePhoneVerified(supabase, salon.id, bk.client_phone, {
    otpSessionId: args.otp_session_id as string | undefined,
    callerVerifiedPhone,
  });
  if (!gate.ok) return NextResponse.json({ error: gate.error, hint: gate.hint });

  const feePolicy = evaluateLateCancellationPolicy({
    booking: voiceBookingLatePolicy(bk),
    salon: latePolicy,
  });
  // A group member/organizer token is an RSVP for that person's own spot and
  // must never inherit the individual booking late-fee path.
  const individualFeeWillCharge = bk.group_id == null && feePolicy.willCharge;
  if (individualFeeWillCharge && !lateFeeAcknowledged) {
    const confirmationToken = issueLateFeeChallenge({
      bookingId: bookingId!,
      feeCents: feePolicy.feeCents,
      sessionId,
      currentUtterance: trustedUserUtterance,
    });
    return NextResponse.json({
      error: "late_fee_confirmation_required",
      fee_confirmation_required: true,
      amount_cents: feePolicy.feeCents,
      currency,
      late_fee_confirmation_token: confirmationToken,
      policy_locked_by_reschedule: feePolicy.policyLockedByReschedule,
      hint:
        "Tell the customer the exact late-cancellation fee and ask for a clear yes. Only then call cancel_booking again with late_fee_acknowledged=true.",
    });
  }
  if (
    individualFeeWillCharge &&
    lateFeeAcknowledged &&
    !validateLateFeeChallenge({
      token: lateFeeConfirmationToken,
      bookingId: bookingId!,
      feeCents: feePolicy.feeCents,
      sessionId,
      currentUtterance: trustedUserUtterance,
    })
  ) {
    return NextResponse.json({
      error: "late_fee_confirmation_not_verified",
      fee_confirmation_required: true,
      amount_cents: feePolicy.feeCents,
      currency,
      hint:
        "The server did not receive a trusted, explicit yes from the customer. Do not cancel or charge; ask again or transfer to salon staff.",
    });
  }

  const localTime = new Date(bk.start_time_utc).toLocaleString("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });

  const minted = await mintBookingManagementCapability({
    salonId: String(salon.id),
    bookingId: bookingId!,
    action: "cancel",
    minExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }, supabase);
  if (!minted.ok) {
    return NextResponse.json({ error: "cancel_failed", code: minted.code }, { status: 503 });
  }
  if (minted.capability.scopeKind === "organizer_whole_party") {
    return NextResponse.json({ error: "cancel_failed", code: "group_scope_requires_staff" }, { status: 409 });
  }
  const cancelled = await cancelBookingWithManagementCapability({
    tokenId: minted.capability.tokenId,
    requestId: stableVoiceCancelRequestId(bookingId!),
  }, supabase);
  if (!cancelled.ok) {
    return NextResponse.json({ error: "cancel_failed", code: cancelled.code }, { status: 409 });
  }
  const committed = cancelled.result;
  const chargeableCommitted = committed.scopeKind === "booking_own" &&
    committed.rsvpSemantic === null && committed.cancelPreview?.willCharge === true;
  let feeStatus: "succeeded" | "pending_provider" | "unknown" | "definite_failure" | "not_applicable" =
    "not_applicable";
  if (chargeableCommitted) {
    const charge = await chargeNoShowFee(bookingId!, {
      note: "Late cancellation fee",
      amountCentsOverride: committed.cancelPreview!.feeCents,
      operationKind: "late_cancel_charge",
      occurrenceVersion: committed.transitionVersion ?? undefined,
    });
    feeStatus = charge.status;
  }
  const feeCharged = feeStatus === "succeeded";

  void logBookingEvent({
    bookingId: bookingId!,
    salonId: String(salon.id),
    actorUserId: null,
    actorRole: "system",
    eventType: "booking_cancelled",
    payload: {
      reason: "voice_ai_cancel",
      late: committed.cancelPreview?.withinWindow ?? feePolicy.withinWindow,
      policy_locked_by_reschedule:
        committed.cancelPreview?.policyLockedByReschedule ?? feePolicy.policyLockedByReschedule,
      fee_decision: chargeableCommitted
        ? feeStatus
        : feePolicy.withinWindow
          ? "not_chargeable"
          : "not_applicable",
      fee_cents: chargeableCommitted ? committed.cancelPreview!.feeCents : 0,
      transition_version: committed.transitionVersion,
    },
  });

  // Owner/admin "cancelled" alert (opt-in, fire-and-forget).
  after(() =>
    sendOwnerBookingNotification({
      salonId: String(salon.id),
      bookingId: bookingId!,
      event: "cancel",
    }),
  );

  // Update voice session (best-effort)
  if (sessionId) {
    try {
      await supabase
        .from("voice_ai_sessions")
        .update({ status: "completed" })
        .eq("id", sessionId);
    } catch { /* best-effort */ }
  }

  return NextResponse.json({
    success:     true,
    bookingId,
    serviceName,
    dateTime:    localTime,
    clientName:  bk.client_name,
    reason,
    feeCharged,
    feeCents: chargeableCommitted ? committed.cancelPreview!.feeCents : 0,
    currency,
    feeStatus,
    feeFailed: chargeableCommitted && feeStatus === "definite_failure",
    paymentPending: feeStatus === "pending_provider" || feeStatus === "unknown",
    message: chargeableCommitted
      ? feeCharged
        ? "Lịch hẹn đã được hủy và phí hủy trễ đã được thu thành công."
        : feeStatus === "definite_failure"
          ? "Lịch hẹn đã được hủy nhưng thu phí bị từ chối. Nhân viên cần kiểm tra."
          : "Lịch hẹn đã được hủy; trạng thái phí đang được đối soát. Không thu lại."
      : "Lịch hẹn đã được hủy thành công.",
  });
}

// ─── find_booking ────────────────────────────────────────────────────────────
// Look up upcoming bookings for a customer by phone number.
// Used when the customer wants to reschedule in a new session.
async function handleFindBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
) {
  const customerPhone = args.customer_phone as string | undefined;
  if (!customerPhone) {
    return NextResponse.json({ error: "missing_customer_phone" }, { status: 400 });
  }

  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  const last9 = phoneSuffixOrNull(customerPhone);
  if (!last9) return NextResponse.json(PHONE_TOO_SHORT);

  const now = new Date().toISOString();

  // Single query: phone suffix match on upcoming non-cancelled bookings
  const { data: phoneRows } = await supabase
    .from("bookings")
    .select("id, start_time_utc, end_time_utc, status, client_name, services!bookings_service_id_fkey(name)")
    .eq("salon_id", salon.id)
    .ilike("client_phone", `%${last9}`)
    .gte("start_time_utc", now)
    .neq("status", "cancelled")
    .order("start_time_utc", { ascending: true })
    .limit(3);

  if (!phoneRows || phoneRows.length === 0) {
    return NextResponse.json({
      bookings: [],
      message:  "Không tìm thấy lịch hẹn nào sắp tới cho số điện thoại này.",
    });
  }

  const tz = (salon as { timezone?: string }).timezone ?? "America/Los_Angeles";
  const formatted = phoneRows.map((b) => {
    const start = new Date(b.start_time_utc as string);
    const localStr = start.toLocaleString("en-US", {
      timeZone: tz, weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svcRaw = (b as any).services as { name?: string } | { name?: string }[] | null;
    const svcName = (Array.isArray(svcRaw) ? svcRaw[0]?.name : svcRaw?.name) ?? "Unknown service";
    return {
      booking_id:   b.id,
      service_name: svcName,
      date_time:    localStr,
      status:       b.status,
      client_name:  b.client_name,
    };
  });

  return NextResponse.json({ bookings: formatted });
}

// ─── reschedule_booking ──────────────────────────────────────────────────────
// UPDATE an existing booking to a new date/time.
// Preserves booking_id, history, and deposits.
async function handleRescheduleBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
  callerVerifiedPhone: string | null,
) {
  const bookingId  = args.booking_id    as string | undefined;
  const newDate    = args.new_date      as string | undefined;  // YYYY-MM-DD
  const newSlot    = args.new_time_slot as string | undefined;  // "3:00 PM"
  const staffArg   = args.staff_id      as string | undefined;

  if (!bookingId || !newDate || !newSlot || !staffArg) {
    return NextResponse.json({ error: "missing_required_fields" }, { status: 400 });
  }

  // Load salon
  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone, self_cancel_fee_enabled, self_cancel_window_hours, self_cancel_fee_percent, noshow_fee_percent")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  // Load existing booking — verify it belongs to this salon
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, salon_id, service_id, staff_id, start_time_utc, end_time_utc, status, client_name, client_phone, noshow_fee_cents, self_cancel_fee_locked_at, self_cancel_fee_locked_cents, schedule_model")
    .eq("id", bookingId)
    .eq("salon_id", salon.id)
    .single();

  if (!booking) return NextResponse.json({ error: "booking_not_found" }, { status: 404 });
  if ((booking as { schedule_model?: unknown }).schedule_model === "segments_v1") {
    return NextResponse.json(
      {
        error: "sequence_reschedule_requires_human_review",
        message: "This multi-service booking must be rescheduled as one complete sequence.",
      },
      { status: 409 },
    );
  }
  if ((booking as { status: string }).status === "cancelled") {
    return NextResponse.json({ error: "booking_already_cancelled" }, { status: 409 });
  }

  // Identity gate — verify against the phone that OWNS this booking.
  const gate = await requirePhoneVerified(
    supabase,
    salon.id,
    (booking as { client_phone: string }).client_phone,
    { otpSessionId: args.otp_session_id as string | undefined, callerVerifiedPhone },
  );
  if (!gate.ok) return NextResponse.json({ error: gate.error, hint: gate.hint });

  // Load service for duration
  const { data: service } = await supabase
    .from("services")
    .select("id, name, duration_minutes")
    .eq("id", (booking as { service_id: string }).service_id)
    .single();
  if (!service) return NextResponse.json({ error: "service_not_found" }, { status: 404 });

  // Resolve staff: keep same if "any" or "same", else use provided ID
  const currentStaffId = (booking as { staff_id: string | null }).staff_id;
  let resolvedStaffId = currentStaffId;
  if (staffArg !== "any" && staffArg !== "same" && staffArg !== BOOKING_ANY_STAFF_ID) {
    resolvedStaffId = staffArg;
  }

  // Convert new date + time slot → UTC (DST-safe)
  const timezone = (salon as { timezone?: string }).timezone ?? "America/Los_Angeles";
  const slotMins = parseSlotLabelToMinutes(newSlot);
  if (slotMins === null) {
    return NextResponse.json({ error: "invalid_time_slot_format", received: newSlot }, { status: 400 });
  }
  const svc = service as { duration_minutes: number; name: string };
  const endMins = slotMins + svc.duration_minutes;

  let newStartUtc: string;
  let newEndUtc: string;
  try {
    newStartUtc = salonWallTimeToUtcIso(newDate, slotMins, timezone);
    newEndUtc   = salonWallTimeToUtcIso(newDate, endMins,  timezone);
  } catch (e) {
    return NextResponse.json({ error: "time_conversion_failed", detail: String(e) }, { status: 400 });
  }

  // Conflict check — exclude THIS booking from the check
  // (its current slot will be freed when we move it)
  const { data: conflicts } = await supabase
    .from("bookings")
    .select("id")
    .eq("salon_id", salon.id)
    .eq("staff_id", resolvedStaffId ?? "")
    .neq("id", bookingId)
    .not("status", "in", `("cancelled","waiting")`)
    .lt("start_time_utc", newEndUtc)
    .gt("end_time_utc", newStartUtc)
    .limit(1);

  if (conflicts && conflicts.length > 0) {
    return NextResponse.json({
      error:   "slot_conflict",
      message: "Khung giờ mới không còn trống. Vui lòng chọn giờ khác.",
    }, { status: 409 });
  }

  // UPDATE booking — preserve ID, history, deposits
  const oldStart = (booking as { start_time_utc: string }).start_time_utc;
  const rescheduleSalon = salon as VoiceCancelSalon;
  const rescheduleBooking = booking as {
    noshow_fee_cents?: number | null;
    self_cancel_fee_locked_at?: string | null;
    self_cancel_fee_locked_cents?: number | null;
  };
  const lateCancelLockPatch = buildLateCancellationLockPatch({
    previousStartTimeUtc: oldStart,
    noShowFeeCents: rescheduleBooking.noshow_fee_cents ?? null,
    existingLockedAt: rescheduleBooking.self_cancel_fee_locked_at ?? null,
    existingLockedCents: rescheduleBooking.self_cancel_fee_locked_cents ?? null,
    salon: voiceSalonLatePolicy(rescheduleSalon),
    reason: "voice_reschedule",
  });
  const { error: updateErr } = await supabase
    .from("bookings")
    .update({
      start_time_utc:            newStartUtc,
      end_time_utc:              newEndUtc,
      ...(resolvedStaffId ? { staff_id: resolvedStaffId } : {}),
      rescheduled_from_time_utc: oldStart,
      rescheduled_at:            new Date().toISOString(),
      rescheduled_by:            "voice",
      customer_transition_email_requested: true,
      customer_transition_email_not_before: new Date().toISOString(),
      ...(lateCancelLockPatch ?? {}),
    } as never)
    .eq("id", bookingId);

  if (updateErr) {
    console.error("[voice/reschedule_booking] update error:", updateErr);
    return NextResponse.json({ error: "reschedule_failed", detail: updateErr.message }, { status: 500 });
  }

  void logBookingEvent({
    bookingId,
    salonId: String(salon.id),
    actorUserId: null,
    actorRole: "system",
    eventType: "booking_rescheduled",
    payload: {
      reason: "voice_ai_reschedule",
      previous_start_utc: oldStart,
      new_start_utc: newStartUtc,
      late_cancel_policy_locked: Boolean(
        lateCancelLockPatch || rescheduleBooking.self_cancel_fee_locked_at,
      ),
    },
  });

  // Owner/admin "rescheduled" alert (opt-in, fire-and-forget).
  after(() =>
    sendOwnerBookingNotification({
      salonId: String(salon.id),
      bookingId,
      event: "reschedule",
      previousStartUtc: oldStart,
      changedBy: "voice_ai",
      changedFields:
        resolvedStaffId && resolvedStaffId !== currentStaffId
          ? ["time", "staff"]
          : ["time"],
    }),
  );

  // Update voice session if we have one
  if (sessionId) {
    try {
      await supabase
        .from("voice_ai_sessions")
        .update({ booking_id: bookingId })
        .eq("id", sessionId);
    } catch { /* best-effort */ }
  }

  return NextResponse.json({
    success:     true,
    bookingId,
    serviceName: svc.name,
    newDate,
    newTimeSlot: newSlot,
    clientName:  (booking as { client_name: string }).client_name,
    lateCancelPolicyLocked: Boolean(
      lateCancelLockPatch || rescheduleBooking.self_cancel_fee_locked_at,
    ),
    message:     "Lịch hẹn đã được dời thành công. Booking ID giữ nguyên.",
  });
}

// ─── join_waitlist ───────────────────────────────────────────────────────────
// Add a customer to the booking waitlist for a service on a given date when no
// slot is available. Mirrors the online waitlist path (submitPublicWaitlistEntry)
// but runs server-side with the service-role client. Writes via the same
// create_public_waitlist_entry RPC, so voice entries land in the Receptionist
// Center waitlist panel and the auto-fill/notify pipeline exactly like online
// ones. Records interest only — never creates a booking.
async function handleJoinWaitlist(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
) {
  const serviceId     = args.service_id     as string | undefined;
  const date          = args.date           as string | undefined; // YYYY-MM-DD
  const customerName  = args.customer_name  as string | undefined;
  const customerPhone = args.customer_phone as string | undefined;
  const staffId       = (args.staff_id      as string | undefined) ?? BOOKING_ANY_STAFF_ID;
  const preferredTime = (args.preferred_time as string | undefined) ?? "";

  if (!serviceId || !date || !customerName || !customerPhone) {
    return NextResponse.json(
      { error: "missing_required_args: service_id, date, customer_name, customer_phone" },
      { status: 400 },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "invalid_date: expected YYYY-MM-DD" }, { status: 400 });
  }

  const phoneOk = validateGuestPhone(customerPhone);
  if (!phoneOk.ok) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
  }
  const nameTrimmed = customerName.trim();
  if (!isValidCustomerName(nameTrimmed)) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }

  // Load salon → id; also fetch service for a friendly read-back + ownership check.
  const { data: salon } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  const { data: service } = await supabase
    .from("services")
    .select("name")
    .eq("id", serviceId)
    .eq("salon_id", salon.id)
    .single();
  if (!service) return NextResponse.json({ error: "service_not_found" }, { status: 404 });

  const staffUuid =
    staffId === BOOKING_ANY_STAFF_ID || staffId === "any" || !staffId.trim()
      ? null
      : staffId;

  const { data: rpcRows, error: rpcErr } = await supabase.rpc(
    "create_public_waitlist_entry",
    {
      p_salon_id:             salon.id,
      p_service_id:           serviceId,
      p_staff_id:             staffUuid,
      p_booking_date:         date,
      p_preferred_slot_label: preferredTime,
      p_client_name:          nameTrimmed,
      p_client_phone:         phoneOk.digits,
      // Same semantic reason the online flow uses when the wanted slot is full,
      // so the waitlist loader/UI treats voice entries identically.
      p_source:               "slot_unavailable",
      p_client_email:         null,
    },
  );

  if (rpcErr) {
    console.error("[voice/join_waitlist] RPC error:", rpcErr);
    return NextResponse.json({ error: "waitlist_failed", detail: rpcErr.message }, { status: 500 });
  }

  const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const waitlistId =
    row && typeof row === "object" && "id" in row && row.id != null
      ? String((row as { id: unknown }).id)
      : "";
  if (!waitlistId) {
    return NextResponse.json({ error: "waitlist_empty" }, { status: 500 });
  }

  return NextResponse.json({
    success:     true,
    waitlistId,
    serviceName: (service as { name: string }).name,
    date,
    preferredTime: preferredTime || null,
    message:
      "Added to the waitlist. The customer will get an SMS if a matching slot opens up. " +
      "This is NOT a confirmed booking — tell them you'll notify them if something frees up.",
  });
}

// ═══════════════════════════════════════════════════════════════════
// GROUP BOOKING TOOLS
// ═══════════════════════════════════════════════════════════════════

// ─── Shared helpers ──────────────────────────────────────────────

/** Parse "HH:MM" (24-hour) → minutes from midnight.  Returns null if malformed. */
function parseHm24(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** UTC ms → salon-local "HH:MM" (24h) string. */
function utcMsToSalonHm24(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour:     "2-digit",
    minute:   "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const hh = parts.find((p) => p.type === "hour")?.value   ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

/** Return the weekday key ("mon"…"sun") for a YYYY-MM-DD date. */
const DAY_KEYS_BY_IDX: readonly DayKey[] = ["sun","mon","tue","wed","thu","fri","sat"];
function dayKeyForYmd(ymd: string): DayKey | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const idx = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).getUTCDay();
  return DAY_KEYS_BY_IDX[idx] ?? null;
}

// ─── Shared context loader ───────────────────────────────────────

type ServiceInfo = {
  id:        string;
  name:      string;
  totalMin:  number;   // duration + buffer
  bufferMin: number;   // per-service buffer ("Chuẩn bị") — drives inter-wave gap
  serviceCompletionMin: number;
  priceCents: number | null;
};

type GroupCtx = {
  salonId:         string;
  timezone:        string;
  openingWeek:     OpeningHoursWeek;
  bookingClosedDates: unknown;
  dayHours:        { open: string; close: string; closed: boolean };
  resolvedMembers: ResolvedMember[];
  staffList:       StaffRow[];
  staffById:       Map<string, StaffRow>;
  capability:      StaffCapabilityMap;
  existing:        ExistingBooking[];
  serviceById:     Map<string, ServiceInfo>;
};

/**
 * Loads and validates everything a group scheduler call needs:
 * salon, services, staff, capability map, and existing occupancy for `dateYmd`.
 * Returns a structured error string if anything is missing/invalid.
 */
async function loadGroupCtx(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  serviceAssignments: { service_id: string; count: number }[],
  dateYmd: string,
): Promise<GroupCtx | { error: string; status: number }> {
  // 1. Salon
  const { data: salonRaw } = await supabase
    .from("salons")
    .select("id, timezone, opening_hours, booking_closed_dates")
    .eq("slug", salonSlug)
    .single();
  if (!salonRaw) return { error: "salon_not_found", status: 404 };
  const salon = salonRaw as unknown as {
    id: string;
    timezone?: string;
    opening_hours?: unknown;
    booking_closed_dates?: unknown;
  };
  const timezone = (typeof salon.timezone === "string" && salon.timezone.trim())
    ? salon.timezone.trim()
    : "America/Vancouver";

  // 2. Opening hours
  const openingWeek = parseOpeningHours(salon.opening_hours);
  if (!openingWeek) return { error: "invalid_opening_hours", status: 400 };
  const dayKey = dayKeyForYmd(dateYmd);
  const dayHours = dayKey ? openingWeek[dayKey] : null;
  if (!dayHours || dayHours.closed) return { error: "salon_closed_on_this_day", status: 409 };
  if (
    Array.isArray(salon.booking_closed_dates) &&
    salon.booking_closed_dates.some((value) => String(value) === dateYmd)
  ) {
    return { error: "salon_closed_on_this_day", status: 409 };
  }

  // 3. Expand service_assignments → flat service-id list (validates counts)
  const expandedServiceIds: string[] = [];
  for (const { service_id, count } of serviceAssignments) {
    if (!service_id || typeof count !== "number" || count < 1 || !Number.isInteger(count)) {
      return { error: "invalid_service_assignment: service_id required and count must be integer ≥ 1", status: 400 };
    }
    for (let i = 0; i < count; i++) expandedServiceIds.push(service_id);
  }
  const totalMembers = expandedServiceIds.length;
  if (totalMembers < 2 || totalMembers > 20) {
    return { error: "group_size_must_be_2_to_20", status: 400 };
  }

  // 4. Load services
  const uniqueIds = [...new Set(expandedServiceIds)];
  const { data: svcRows } = await supabase
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes, price_cents")
    .in("id", uniqueIds)
    .eq("salon_id", salon.id)
    .is("deleted_at", null);

  const serviceById = new Map<string, ServiceInfo>();
  for (const r of svcRows ?? []) {
    const timing = computeBookingTiming({
      durationMinutes: r.duration_minutes,
      bufferMinutes: r.buffer_minutes,
    });
    serviceById.set(String(r.id), {
      id:         String(r.id),
      name:       String(r.name ?? ""),
      totalMin:   timing.blockMinutes,
      bufferMin:  Number(r.buffer_minutes) || 0,
      serviceCompletionMin: timing.serviceCompletionMinutes,
      priceCents: r.price_cents != null ? Number(r.price_cents) : null,
    });
  }
  for (const id of uniqueIds) {
    if (!serviceById.has(id)) return { error: `service_not_found: ${id}`, status: 404 };
  }

  // 5. Build resolvedMembers (no preferred staff in voice group flow)
  const resolvedMembers: ResolvedMember[] = expandedServiceIds.map((svcId, i) => {
    const svc = serviceById.get(svcId)!;
    return {
      index:           i,
      name:            `Guest ${i + 1}`,
      serviceId:       svcId,
      serviceName:     svc.name,
      totalMinutes:    svc.totalMin,
      bufferMinutes:   svc.bufferMin,
      priceCents:      svc.priceCents,
      preferredStaffId: null,
    };
  });

  // 6. Staff
  const { data: staffRows } = await supabase
    .from("staff")
    .select("id, name")
    .eq("salon_id", salon.id)
    .eq("status", "active")
    .is("deleted_at", null);
  const staffList: StaffRow[] = (staffRows ?? []).map((s) => ({
    id:   String(s.id),
    name: String(s.name ?? ""),
  }));
  // Phase 6: a group LARGER than the staff count is no longer rejected here —
  // the wave scheduler serves it across multiple time waves. Only reject when the
  // salon has no active staff at all (nothing can be scheduled).
  if (staffList.length === 0) {
    return { error: "no_active_staff", status: 409 };
  }
  const staffById = new Map<string, StaffRow>();
  for (const s of staffList) staffById.set(s.id, s);

  // 7. Staff capability
  const { data: capRows } = await supabase
    .from("staff_services")
    .select("staff_id, service_id")
    .in("staff_id", staffList.map((s) => s.id));
  const capability: StaffCapabilityMap =
    capRows && capRows.length > 0
      ? buildCapabilityMap(capRows.map((r) => ({ staff_id: String(r.staff_id), service_id: String(r.service_id) })))
      : null; // null = all staff can do all services (backward-compat)

  // 8. Existing bookings for the day
  const { startUtc, endUtc } = salonDayRangeUtc(dateYmd, timezone);
  const { data: occRows } = await supabase.rpc("public_booking_occupancy_for_range", {
    p_salon_id: salon.id,
    p_start:    startUtc,
    p_end:      endUtc,
  });
  const existing: ExistingBooking[] = ((occRows ?? []) as Array<{
    staff_id: string;
    start_time_utc: string;
    end_time_utc: string;
  }>).flatMap((row) => {
    if (!row.staff_id) return [];
    const startMs = Date.parse(row.start_time_utc);
    const endMs   = Date.parse(row.end_time_utc);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    return [{ staffId: String(row.staff_id), startMs, endMs }];
  });

  return {
    salonId:         String(salon.id),
    timezone,
    openingWeek,
    bookingClosedDates: salon.booking_closed_dates,
    dayHours,
    resolvedMembers,
    staffList,
    staffById,
    capability,
    existing,
    serviceById,
  };
}

// ─── get_group_available_slots ───────────────────────────────────

/**
 * Return up to 3 voice-friendly group arrangements around `target_time`.
 * For sync_start: scans ±90 min around target, returns start-aligned options.
 * For sync_finish: delegates to findFinishArrangementsInWindow.
 */
async function handleGetGroupAvailableSlots(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
) {
  // 1. Parse args
  const serviceAssignments = args.service_assignments as { service_id: string; count: number }[] | undefined;
  const dateYmd   = args.date        as string | undefined;
  const mode      = ((args.mode as string | undefined) ?? "sync_start") as GroupSyncMode;
  const targetRaw = args.target_time as string | undefined;

  if (!Array.isArray(serviceAssignments) || serviceAssignments.length === 0) {
    return NextResponse.json({ error: "missing_service_assignments" }, { status: 400 });
  }
  if (!dateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
    return NextResponse.json({ error: "invalid_date: expected YYYY-MM-DD" }, { status: 400 });
  }
  if (!targetRaw) {
    return NextResponse.json({ error: "missing_target_time: expected HH:MM (24h)" }, { status: 400 });
  }
  const targetMin = parseHm24(targetRaw);
  if (targetMin === null) {
    return NextResponse.json({ error: "invalid_target_time: expected HH:MM format like 14:00" }, { status: 400 });
  }

  // 2. Load scheduling context
  const ctxOrErr = await loadGroupCtx(supabase, salonSlug, serviceAssignments, dateYmd);
  if ("error" in ctxOrErr) {
    return NextResponse.json({ error: ctxOrErr.error }, { status: ctxOrErr.status });
  }
  const ctx = ctxOrErr;

  const openMin  = parseHm24(ctx.dayHours.open)  ?? 0;
  const closeMin = parseHm24(ctx.dayHours.close) ?? 0;

  // 3. Find arrangements
  let arrangements: GroupArrangement[] = [];

  if (mode === "sync_finish") {
    // Use the finish-aligned search from core
    const finishMs  = Date.parse(salonWallTimeToUtcIso(dateYmd, targetMin, ctx.timezone));
    const dayOpenMs = Date.parse(salonWallTimeToUtcIso(dateYmd, openMin,   ctx.timezone));
    const dayCloseMs = Date.parse(salonWallTimeToUtcIso(dateYmd, closeMin, ctx.timezone));
    arrangements = findFinishArrangementsInWindow({
      targetFinishMs:  finishMs,
      dayOpenMs,
      dayCloseMs,
      date:            dateYmd,
      timezone:        ctx.timezone,
      resolvedMembers: ctx.resolvedMembers,
      staffList:       ctx.staffList,
      staffById:       ctx.staffById,
      capability:      ctx.capability,
      existing:        ctx.existing,
    });
  } else {
    // sync_start: scan ±90 min around target_time, collect up to 3 distinct arrangements
    const SEARCH_RADIUS_MIN = 90;
    const winStart = Math.max(openMin, targetMin - SEARCH_RADIUS_MIN);
    const winEnd   = Math.min(closeMin, targetMin + SEARCH_RADIUS_MIN);
    const maxMemberMin = ctx.resolvedMembers.reduce((acc, m) => Math.max(acc, m.totalMinutes), 0);

    for (let mm = winStart; mm <= winEnd && arrangements.length < 3; mm += SLOT_STEP_MIN) {
      const anchorMs  = Date.parse(salonWallTimeToUtcIso(dateYmd, mm, ctx.timezone));
      const dayCloseMs = Date.parse(salonWallTimeToUtcIso(dateYmd, closeMin, ctx.timezone));
      // Skip anchors where the longest service would go past closing
      if (Number.isFinite(dayCloseMs) && anchorMs + maxMemberMin * 60_000 > dayCloseMs) continue;
      const result = tryAlignedArrangement(
        anchorMs,
        ctx.resolvedMembers,
        ctx.staffList,
        ctx.staffById,
        ctx.capability,
        ctx.existing,
        false, // voice doesn't enforce preferred staff
      );
      if (!result) continue;
      const arr = buildArrangement("best", result, ctx.resolvedMembers, ctx.staffById, ctx.timezone);
      // Deduplicate by group start time
      if (!arrangements.some((a) => a.groupStartMs === arr.groupStartMs)) {
        arrangements.push(arr);
      }
    }
  }

  // ── Wave fallback (Phase 6, sync_start only) ──────────────────────────────
  // No simultaneous arrangement exists in the ±90 window — the party is larger
  // than the salon can serve at once. Offer a multi-wave split starting at the
  // requested time instead of returning "no availability".
  if (arrangements.length === 0 && mode === "sync_start") {
    const anchorMs   = Date.parse(salonWallTimeToUtcIso(dateYmd, targetMin, ctx.timezone));
    const dayCloseMs = Date.parse(salonWallTimeToUtcIso(dateYmd, closeMin,  ctx.timezone));
    // Discovery path: forward-scan from the requested time so a group whose
    // requested slot is full is still offered the earliest later wave window
    // today, instead of "no availability" while the afternoon sits open.
    const waveRaw = findEarliestWaveArrangement(
      anchorMs, ctx.resolvedMembers, ctx.staffList, ctx.staffById,
      ctx.capability, ctx.existing, dayCloseMs,
    );
    if (waveRaw && waveRaw.assignments.length === ctx.resolvedMembers.length) {
      const waveArr = buildWaveArrangement(waveRaw, ctx.resolvedMembers, ctx.staffById, ctx.timezone);
      if (waveArr.isWaveBooking) {
        return NextResponse.json({
          arrangements: [{
            index:        0,
            isWaveBooking: true,
            waveCount:    waveArr.waveCount,
            startDisplay: waveArr.groupStartDisplay,
            endDisplay:   waveArr.groupEndDisplay,
            startTime:    utcMsToSalonHm24(waveArr.groupStartMs, ctx.timezone), // pass back as `time`
            waves:        waveArr.waves.map((w) => ({
              waveNumber:   w.waveNumber,
              startTime:    utcMsToSalonHm24(w.startMs, ctx.timezone),
              startDisplay: w.startDisplay,
              endDisplay:   w.endDisplay,
              memberCount:  w.memberCount,
            })),
            summary:      waveArr.summary,
          }],
          count:        1,
          date:         dateYmd,
          mode,
          totalMembers: ctx.resolvedMembers.length,
          isWaveOption: true,
          hint:
            "WAVE option for a large group (more guests than available staff). Explain simply: " +
            "the party is too big to all start together, so it's split into waves. Say the wave " +
            "start times and counts (from `waves`). Do NOT read individual staff assignments. If the " +
            "customer agrees, call confirm_group_booking with the SAME date and time (the wave-1 start).",
        });
      }
    }
  }

  // ── sync_finish large group: waves not supported this phase ────────────────
  if (arrangements.length === 0 && mode === "sync_finish") {
    return NextResponse.json({
      slots:        [],
      count:        0,
      date:         dateYmd,
      mode,
      totalMembers: ctx.resolvedMembers.length,
      message:
        "Finish together is not available for this large group. Try arrive together or a different time.",
    });
  }

  if (arrangements.length === 0) {
    return NextResponse.json({
      slots:        [],
      count:        0,
      date:         dateYmd,
      mode,
      totalMembers: ctx.resolvedMembers.length,
      message:      "No group slots available at the requested time. Please try a different time or date.",
    });
  }

  // 4. Format for voice — never read individual assignments aloud
  const totalMembers = ctx.resolvedMembers.length;
  const voiceArrangements = arrangements.map((arr, i) => {
    // The AI will say "Option 1: everyone arrives at 10:00 AM, done by 11:30 AM"
    const startTime = utcMsToSalonHm24(arr.groupStartMs, ctx.timezone);
    const endTime   = utcMsToSalonHm24(arr.groupEndMs,   ctx.timezone);
    const summary =
      mode === "sync_finish"
        ? `${totalMembers} people finish together at ${arr.groupEndDisplay}. Services start as early as ${arr.groupStartDisplay}.`
        : `${totalMembers} people arrive and start together at ${arr.groupStartDisplay}, done by ${arr.groupEndDisplay}.`;
    return {
      index:            i,
      startDisplay:     arr.groupStartDisplay,
      endDisplay:       arr.groupEndDisplay,
      startTime,  // HH:MM 24h — pass back in confirm_group_booking
      endTime,
      summary,
    };
  });

  return NextResponse.json({
    arrangements: voiceArrangements,
    count:        voiceArrangements.length,
    date:         dateYmd,
    mode,
    totalMembers,
    hint:         "Present at most 2 options to the customer. Say the time clearly. When confirmed, call confirm_group_booking.",
  });
}

// ─── confirm_group_booking ───────────────────────────────────────

type VoiceGroupReplayResult =
  | { kind: "none" }
  | { kind: "conflict" }
  | { kind: "current_state"; status: string | null }
  | {
      kind: "replayed";
      groupId: string;
      bookingIds: string[];
      pricing: NonNullable<ReturnType<typeof parseGroupBookingPricingQuote>>;
      bookings: GroupBookingCreateServerRequest["bookings"];
    }
  | { kind: "unavailable" };

function voiceLocalYmdHm(utcIso: string, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utcIso));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)?.value ?? "";
    return {
      ymd: `${part("year")}-${part("month")}-${part("day")}`,
      hm: `${part("hour")}:${part("minute")}`,
    };
  } catch {
    return null;
  }
}

function sameVoiceGroupServiceCounts(
  serviceIds: readonly string[],
  requested: readonly { service_id: string; count: number }[],
) {
  const actual = new Map<string, number>();
  for (const id of serviceIds) actual.set(id, (actual.get(id) ?? 0) + 1);
  const expected = new Map<string, number>();
  for (const entry of requested) {
    expected.set(entry.service_id, (expected.get(entry.service_id) ?? 0) + entry.count);
  }
  return actual.size === expected.size &&
    [...actual].every(([id, count]) => expected.get(id) === count);
}

/** Exact response-loss replay before loading fresh group availability. */
async function replayCommittedVoiceGroup(args: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  salonId: string;
  timezone: string;
  idempotencyKey: string;
  serviceAssignments: { service_id: string; count: number }[];
  dateYmd: string;
  chosenTime: string;
  mode: GroupSyncMode;
  organizerPhone: string;
  confirmedPricingFingerprint: string;
}): Promise<VoiceGroupReplayResult> {
  const { data: organizerRaw, error: organizerError } = await args.supabase
    .from("bookings")
    .select("id, group_id, public_booking_pricing_snapshot")
    .eq("salon_id", args.salonId)
    .eq("idempotency_key", args.idempotencyKey)
    .eq("is_group_organizer", true)
    .maybeSingle();
  if (organizerError) return { kind: "unavailable" };
  if (!organizerRaw) return { kind: "none" };
  const snapshot = (organizerRaw as { public_booking_pricing_snapshot?: unknown })
    .public_booking_pricing_snapshot;
  const pricing = parseGroupBookingPricingQuote(snapshot, { voucherCode: null });
  const raw = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : null;
  const groupId = typeof raw?.group_id === "string" ? raw.group_id : "";
  const bookingIds = Array.isArray(raw?.booking_ids)
    ? raw.booking_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (
    !pricing ||
    pricing.pricingFingerprint !== args.confirmedPricingFingerprint ||
    !groupId ||
    organizerRaw.group_id !== groupId ||
    bookingIds.length !== pricing.groupSize ||
    !sameVoiceGroupServiceCounts(
      pricing.memberQuotes.map((member) => member.serviceId),
      args.serviceAssignments,
    )
  ) return { kind: "conflict" };

  const { data: rowsRaw, error: rowsError } = await args.supabase
    .from("bookings")
    .select(
      "id, status, group_id, service_id, staff_id, client_name, client_phone, client_email, client_notes, start_time_utc, end_time_utc, staff_requested_by_client, wave_number, seat_together, client_locale, resource_id",
    )
    .eq("salon_id", args.salonId)
    .in("id", bookingIds);
  if (rowsError || !Array.isArray(rowsRaw)) return { kind: "unavailable" };
  const byId = new Map(rowsRaw.map((row) => [String(row.id), row]));
  const bookings: GroupBookingCreateServerRequest["bookings"] = [];
  for (let index = 0; index < bookingIds.length; index++) {
    const row = byId.get(bookingIds[index]);
    const member = pricing.memberQuotes[index];
    if (!row || !member || row.group_id !== groupId) return { kind: "conflict" };
    if (row.status !== "confirmed") {
      return { kind: "current_state", status: row.status ?? null };
    }
    if (
      row.service_id !== member.serviceId ||
      row.staff_id !== member.staffId ||
      row.start_time_utc !== member.startTimeUtc ||
      row.end_time_utc !== member.endTimeUtc
    ) {
      return { kind: "current_state", status: row.status ?? null };
    }
    if (
      row.client_name !== `Guest ${index + 1}` ||
      row.client_phone !== (index === 0 ? args.organizerPhone : null) ||
      row.client_email != null ||
      row.client_notes !== "Voice group booking" ||
      row.staff_requested_by_client !== false ||
      row.seat_together !== false ||
      row.client_locale != null ||
      row.resource_id != null ||
      member.addonServiceIds.length !== 0
    ) return { kind: "conflict" };
    bookings.push({
      serviceId: member.serviceId,
      staffId: member.staffId,
      startTimeUtc: member.startTimeUtc,
      endTimeUtc: member.endTimeUtc,
      addonServiceIds: [],
      clientName: `Guest ${index + 1}`,
      clientPhone: index === 0 ? args.organizerPhone : null,
      clientEmail: null,
      clientNotes: "Voice group booking",
      staffRequestedByClient: false,
      waveNumber: Number(row.wave_number ?? 1),
      seatTogether: false,
      clientLocale: null,
      resourceId: null,
    });
  }
  const starts = bookings.map((booking) => voiceLocalYmdHm(booking.startTimeUtc, args.timezone));
  const ends = bookings.map((booking) => voiceLocalYmdHm(booking.endTimeUtc, args.timezone));
  if (starts.some((value) => value?.ymd !== args.dateYmd) || ends.some((value) => value == null)) {
    return { kind: "conflict" };
  }
  const anchor = args.mode === "sync_finish"
    ? ends.reduce((latest, value) => value!.hm > latest ? value!.hm : latest, "00:00")
    : starts.reduce((earliest, value) => value!.hm < earliest ? value!.hm : earliest, "23:59");
  if (anchor !== args.chosenTime) return { kind: "conflict" };

  const created = await createGroupBookingsAuthoritative({
    salonId: args.salonId,
    bookings,
    voucherCode: null,
    applyEmailDiscount: false,
    idempotencyKey: args.idempotencyKey,
    expectedPricingFingerprint: pricing.pricingFingerprint,
  });
  if (!created.ok) {
    return created.code === "idempotency_conflict"
      ? { kind: "conflict" }
      : { kind: "unavailable" };
  }
  if (
    !created.idempotent ||
    created.groupId !== groupId ||
    created.bookingIds.length !== bookingIds.length ||
    created.bookingIds.some((id, index) => id !== bookingIds[index])
  ) return { kind: "conflict" };
  return {
    kind: "replayed",
    groupId,
    bookingIds,
    pricing: created.pricing,
    bookings,
  };
}

/**
 * Re-runs the scheduler at the chosen time, obtains a server-authoritative
 * quote, then creates the group only after the caller confirms that exact
 * total. A committed response-loss retry is recovered before availability.
 */
async function handleConfirmGroupBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
  baseUrl: string,
  callerVerifiedPhone: string | null,
  trustedUserUtterance: string | null,
) {
  // 1. Parse args
  let serviceAssignments = args.service_assignments as { service_id: string; count: number }[] | undefined;
  const dateYmd         = args.date           as string | undefined;
  const chosenTime      = args.time           as string | undefined;   // HH:MM 24h
  const mode = parseVoiceGroupMode(args.mode);
  const organizerName   = args.organizer_name  as string | undefined;
  const organizerPhone  = args.organizer_phone as string | undefined;
  const confirmedPricingFingerprint = String(
    args.confirmed_pricing_fingerprint ?? "",
  ).trim().toLowerCase();
  const hasConfirmedFingerprint = /^[a-f0-9]{64}$/.test(confirmedPricingFingerprint);
  const callerConfirmedPrice =
    hasConfirmedFingerprint && isClearVoicePricingConfirmation(trustedUserUtterance);
  if (!mode) {
    return NextResponse.json({ error: "invalid_group_mode" }, { status: 400 });
  }

  if (!Array.isArray(serviceAssignments) || serviceAssignments.length === 0) {
    return NextResponse.json({ error: "missing_service_assignments" }, { status: 400 });
  }
  if (
    serviceAssignments.some(
      (entry) =>
        !entry ||
        typeof entry.service_id !== "string" ||
        !Number.isInteger(entry.count) ||
        entry.count < 1,
    ) ||
    serviceAssignments.reduce((sum, entry) => sum + entry.count, 0) < 2 ||
    serviceAssignments.reduce((sum, entry) => sum + entry.count, 0) > 20
  ) {
    return NextResponse.json({ error: "invalid_service_assignments" }, { status: 400 });
  }
  const serviceCounts = new Map<string, number>();
  for (const entry of serviceAssignments) {
    const serviceId = entry.service_id.trim().toLowerCase();
    serviceCounts.set(serviceId, (serviceCounts.get(serviceId) ?? 0) + entry.count);
  }
  serviceAssignments = [...serviceCounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([service_id, count]) => ({ service_id, count }));
  if (!dateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (!chosenTime) {
    return NextResponse.json({ error: "missing_time: pass the chosen HH:MM from get_group_available_slots" }, { status: 400 });
  }
  const chosenMin = parseHm24(chosenTime);
  if (chosenMin === null) {
    return NextResponse.json({ error: "invalid_time: expected HH:MM (24h)" }, { status: 400 });
  }
  const canonicalChosenTime = `${String(Math.floor(chosenMin / 60)).padStart(2, "0")}:${String(chosenMin % 60).padStart(2, "0")}`;
  if (!organizerName?.trim()) {
    return NextResponse.json({ error: "missing_organizer_name" }, { status: 400 });
  }
  if (!organizerPhone?.trim()) {
    return NextResponse.json({ error: "missing_organizer_phone" }, { status: 400 });
  }

  // 2. Validate phone
  const phoneResult = validateGuestPhone(organizerPhone.trim());
  if (!phoneResult.ok) {
    return NextResponse.json({ error: "invalid_organizer_phone", detail: "Phone number format not recognised." }, { status: 400 });
  }
  const phoneDigits = phoneResult.digits;

  // 3. Resolve only tenant identity/timezone first. A response-loss replay must
  // happen before the scheduler reloads occupancy/capability and sees its own
  // committed rows as unavailable.
  const { data: salonIdentity } = await supabase
    .from("salons")
    .select("id, timezone")
    .eq("slug", salonSlug)
    .maybeSingle();
  if (!salonIdentity?.id || !salonIdentity.timezone) {
    return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
  }
  const gate = await requirePhoneVerified(supabase, salonIdentity.id, phoneDigits, {
    otpSessionId: args.otp_session_id as string | undefined,
    callerVerifiedPhone,
  });
  if (!gate.ok) return NextResponse.json({ error: gate.error, hint: gate.hint });

  const idempotencyKey = voiceGroupBookingLogicalIdempotencyKey({
    sessionId,
    salonId: String(salonIdentity.id),
    serviceAssignments: serviceAssignments.map((entry) => ({
      serviceId: entry.service_id,
      count: entry.count,
    })),
    date: dateYmd,
    time: canonicalChosenTime,
    mode,
    organizerName: organizerName.trim(),
    organizerPhone: phoneDigits,
  });
  const replay: VoiceGroupReplayResult = callerConfirmedPrice
    ? await replayCommittedVoiceGroup({
        supabase,
        salonId: String(salonIdentity.id),
        timezone: salonIdentity.timezone,
        idempotencyKey,
        serviceAssignments,
        dateYmd,
        chosenTime: canonicalChosenTime,
        mode,
        organizerPhone: phoneDigits,
        confirmedPricingFingerprint,
      })
    : { kind: "none" };
  if (replay.kind === "conflict") {
    return NextResponse.json({ success: false, error: "idempotency_conflict" }, { status: 409 });
  }
  if (replay.kind === "current_state") {
    return NextResponse.json({
      success: false,
      error: "group_booking_current_state",
      current_status: replay.status,
    }, { status: 409 });
  }
  if (replay.kind === "unavailable") {
    return NextResponse.json({ error: "group_booking_replay_unavailable" }, { status: 503 });
  }
  if (replay.kind === "replayed") {
    const earliest = replay.bookings.reduce((value, booking) =>
      booking.startTimeUtc < value ? booking.startTimeUtc : value,
    replay.bookings[0]!.startTimeUtc);
    const latest = replay.bookings.reduce((value, booking) =>
      booking.endTimeUtc > value ? booking.endTimeUtc : value,
    replay.bookings[0]!.endTimeUtc);
    const link = await createPartyLink({
      groupId: replay.groupId,
      salonId: String(salonIdentity.id),
      bookingIds: replay.bookingIds,
      mode,
      groupStartUtcIso: earliest,
      baseUrl,
      organizerName: organizerName.trim(),
      organizerPhone: phoneDigits,
    }).catch(() => null);
    await supabase
      .from("bookings")
      .update({ source: "voice", booking_channel: "voice" } as never)
      .in("id", replay.bookingIds);
    if (sessionId) {
      await supabase.from("voice_ai_sessions").update({ status: "completed" }).eq("id", sessionId);
    }
    let smsSent = false;
    if (replay.bookingIds[0]) {
      try {
        const { handleBookingProtection } = await import(
          "@/shared/noshow/handleBookingProtection"
        );
        await handleBookingProtection(replay.bookingIds[0], String(salonIdentity.id), "voice");
      } catch { /* best-effort */ }
      after(() => sendOwnerBookingNotification({
        salonId: String(salonIdentity.id),
        bookingId: replay.bookingIds[0],
        event: "new",
      }));
      try {
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
        const response = await fetch(`${appUrl}/api/booking/sms-confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingId: replay.bookingIds[0],
            salonId: String(salonIdentity.id),
            clientPhone: phoneDigits,
            clientName: organizerName.trim(),
            serviceName: `Group of ${replay.bookingIds.length}`,
            startTimeUtc: earliest,
          }),
        });
        const body = await response.json().catch(() => null) as { ok?: unknown } | null;
        smsSent = response.ok && body?.ok === true;
      } catch { /* durable claim/retry remains authoritative */ }
    }
    return NextResponse.json({
      ok: true,
      idempotent: true,
      groupId: replay.groupId,
      bookingIds: replay.bookingIds,
      partyLinkUrl: link?.ok ? link.url : null,
      smsSent,
      pricing: toVoicePendingGroupPricing(replay.pricing),
      groupStartTime: voiceLocalYmdHm(earliest, salonIdentity.timezone)?.hm ?? canonicalChosenTime,
      groupEndTime: voiceLocalYmdHm(latest, salonIdentity.timezone)?.hm ?? canonicalChosenTime,
      date: dateYmd,
      totalMembers: replay.bookingIds.length,
      organizerName: organizerName.trim(),
      message: `Group booking confirmed for ${replay.bookingIds.length} people.`,
    });
  }

  // Fresh intent: now load scheduling context and availability.
  const ctxOrErr = await loadGroupCtx(supabase, salonSlug, serviceAssignments, dateYmd);
  if ("error" in ctxOrErr) {
    return NextResponse.json({ error: ctxOrErr.error }, { status: ctxOrErr.status });
  }
  const ctx = ctxOrErr;

  // 4. Re-run scheduler at the chosen anchor to get concrete staff assignments
  //    (Ensures we pick up any bookings created since get_group_available_slots was called)
  const anchorMs   = Date.parse(salonWallTimeToUtcIso(dateYmd, chosenMin, ctx.timezone));
  const openMin    = parseHm24(ctx.dayHours.open)  ?? 0;
  const closeMin   = parseHm24(ctx.dayHours.close) ?? 0;
  const dayOpenMs  = Date.parse(salonWallTimeToUtcIso(dateYmd, openMin,  ctx.timezone));
  const dayCloseMs = Date.parse(salonWallTimeToUtcIso(dateYmd, closeMin, ctx.timezone));

  let finalArrangement: GroupArrangement | null = null;
  // Unified assignment list — each carries waveNumber (1 for normal bookings,
  // 2/3… for later waves of a large group split across time).
  let finalAssignments: WaveRawAssignment[] = [];

  if (mode === "sync_finish") {
    // For sync_finish the chosen time is the finish time. Wave splitting is NOT
    // supported for sync_finish this phase (get_group_available_slots already
    // returns the "use arrive together" message for large finish-together groups).
    const finishResults = findFinishArrangementsInWindow({
      targetFinishMs:  anchorMs,
      dayOpenMs,
      dayCloseMs,
      date:            dateYmd,
      timezone:        ctx.timezone,
      resolvedMembers: ctx.resolvedMembers,
      staffList:       ctx.staffList,
      staffById:       ctx.staffById,
      capability:      ctx.capability,
      existing:        ctx.existing,
    });
    if (finishResults.length === 0) {
      return NextResponse.json({
        ok:     false,
        reason: "slot_no_longer_available",
        message: "The requested group time is no longer available. Please call get_group_available_slots again to find the next available slot.",
      }, { status: 409 });
    }
    finalArrangement = finishResults[0]!;
    finalAssignments = finalArrangement.assignments.map((a) => ({
      memberIdx:  a.memberIndex,
      staffId:    a.staffId,
      startMs:    Date.parse(a.startUtcIso),
      endMs:      Date.parse(a.endUtcIso),
      waveNumber: 1,
    }));
  } else {
    // sync_start: try the whole group simultaneously first (unchanged behaviour).
    const aligned = tryAlignedArrangement(
      anchorMs,
      ctx.resolvedMembers,
      ctx.staffList,
      ctx.staffById,
      ctx.capability,
      ctx.existing,
      false,
    );
    if (aligned) {
      finalArrangement = buildArrangement("best", aligned, ctx.resolvedMembers, ctx.staffById, ctx.timezone);
      finalAssignments = aligned.assignments.map((a) => ({ ...a, waveNumber: 1 }));
    } else {
      // Wave fallback (Phase 6): the group can't all start at once → split into waves.
      const waveRaw = tryWaveArrangement(
        anchorMs, ctx.resolvedMembers, ctx.staffList, ctx.staffById,
        ctx.capability, ctx.existing, dayCloseMs,
      );
      if (waveRaw && waveRaw.assignments.length === ctx.resolvedMembers.length) {
        finalArrangement = buildWaveArrangement(waveRaw, ctx.resolvedMembers, ctx.staffById, ctx.timezone);
        finalAssignments = waveRaw.assignments;
      } else {
        return NextResponse.json({
          ok:     false,
          reason: "slot_no_longer_available",
          message: "The requested group time is no longer available. Please call get_group_available_slots again to find the next available slot.",
        }, { status: 409 });
      }
    }
  }

  // Final write-time hours gate. `sync_start` intentionally re-runs the fast
  // aligned scheduler here; that primitive only checks capacity/conflicts, so
  // without this policy check a crafted Voice/SMS confirmation could anchor a
  // group before opening or after closing.
  const finalHoursCheck = checkGroupWithinOpeningHours({
    openingHoursRaw: ctx.openingWeek,
    bookingClosedDatesRaw: ctx.bookingClosedDates,
    members: finalAssignments.map((assignment) => {
      const member =
        ctx.resolvedMembers.find((candidate) => candidate.index === assignment.memberIdx) ??
        ctx.resolvedMembers[assignment.memberIdx]!;
      const service = ctx.serviceById.get(member.serviceId)!;
      return {
        dateYmd,
        startMinutes:
          parseHm24(utcMsToSalonHm24(assignment.startMs, ctx.timezone)) ?? -1,
        serviceCompletionMinutes: service.serviceCompletionMin,
      };
    }),
  });
  if (!finalHoursCheck.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: "outside_hours",
        member_number: finalHoursCheck.memberIndex + 1,
        message:
          "That group time is outside the salon's opening hours. Please call get_group_available_slots again.",
      },
      { status: 409 },
    );
  }

  // 5. Build the canonical server-only request. Guest numbering follows wave
  // order so wave 1 = Guest 1…k, wave 2 = Guest k+1…; only the organizer row
  // carries the verified phone.
  const orderedAssignments = finalAssignments
    .slice()
    .sort((a, b) => a.waveNumber - b.waveNumber || a.memberIdx - b.memberIdx);
  const canonicalBookings = orderedAssignments.map((a, idx) => {
    const member = ctx.resolvedMembers.find((m) => m.index === a.memberIdx) ?? ctx.resolvedMembers[idx]!;
    return {
      serviceId: member.serviceId,
      staffId: a.staffId,
      startTimeUtc: new Date(a.startMs).toISOString(),
      endTimeUtc: new Date(a.endMs).toISOString(),
      addonServiceIds: [],
      clientName: `Guest ${idx + 1}`,
      clientPhone: idx === 0 ? phoneDigits : null,
      clientEmail: null,
      clientNotes: "Voice group booking",
      staffRequestedByClient: false,
      waveNumber: a.waveNumber,
      seatTogether: false,
      clientLocale: null,
      resourceId: null,
    };
  });

  // 6. Quote first and require a second tool call carrying the exact fingerprint
  // after a clear caller readback confirmation.
  const quoted = await resolveGroupBookingQuote({
    salonId: ctx.salonId,
    bookings: canonicalBookings,
    voucherCode: null,
    applyEmailDiscount: false,
  });
  if (!quoted.ok) {
    return NextResponse.json({ error: "group_pricing_unavailable" }, { status: 503 });
  }
  if (!callerConfirmedPrice) {
    return NextResponse.json({
      ok: false,
      error:
        confirmedPricingFingerprint && !hasConfirmedFingerprint
          ? "pricing_changed"
          : "pricing_confirmation_required",
      booking_created: false,
      requires_price_confirmation: true,
      quote: toVoicePendingGroupPricing(quoted.quote),
      message:
        "Read back the exact group total and currency. Ask for a clear yes, then call confirm_group_booking again with this exact confirmed_pricing_fingerprint.",
    });
  }
  const created = await createGroupBookingsAuthoritative({
    salonId: ctx.salonId,
    bookings: canonicalBookings,
    voucherCode: null,
    applyEmailDiscount: false,
    idempotencyKey,
    // Use what the caller confirmed, not the just-refreshed quote. A change
    // returns pricing_changed with zero writes and requires another readback.
    expectedPricingFingerprint: confirmedPricingFingerprint,
  });
  if (!created.ok) {
    if (created.code === "pricing_changed" && created.quote) {
      return NextResponse.json({
        ok: false,
        error: "pricing_changed",
        booking_created: false,
        requires_price_confirmation: true,
        quote: toVoicePendingGroupPricing(created.quote),
        message:
          "The group price changed before booking. Read back the updated total and ask the customer to confirm again.",
      }, { status: 409 });
    }
    if (created.code === "slot_conflict") {
      return NextResponse.json({
        ok: false,
        reason: "slot_conflict",
        message: "A booking conflict occurred. Please call get_group_available_slots again.",
      }, { status: 409 });
    }
    if (created.code === "monthly_booking_limit_reached") {
      return NextResponse.json({ ok: false, reason: created.code }, { status: 409 });
    }
    return NextResponse.json({ error: "group_booking_failed", code: created.code }, { status: 409 });
  }

  const groupId = created.groupId;
  const bookingIds = created.bookingIds;

  // 7. Stamp source = "voice" on all created bookings (best-effort)
  if (bookingIds.length > 0) {
    try {
      await supabase
        .from("bookings")
        .update({ source: "voice", booking_channel: "voice" } as never)
        .in("id", bookingIds);
    } catch { /* best-effort */ }
    bookingIds.forEach((id) =>
      void logBookingEvent({
        bookingId: id,
        salonId: ctx.salonId,
        actorUserId: null,
        actorRole: "system",
        eventType: "booking_created",
        payload: { source: "voice_group", memberCount: bookingIds.length },
      }),
    );
    // Unified no-show protection gate — runs AI agent when opted-in, falls
    // back to hard rules otherwise.  Flag the lead (only it carries a phone).
    try {
      const { handleBookingProtection } = await import(
        "@/shared/noshow/handleBookingProtection"
      );
      await handleBookingProtection(bookingIds[0], ctx.salonId, "voice");
    } catch { /* best-effort */ }
    // Owner/admin "new booking" alert — one email for the group (first booking).
    if (bookingIds[0]) {
      after(() =>
        sendOwnerBookingNotification({
          salonId: ctx.salonId,
          bookingId: bookingIds[0],
          event: "new",
        }),
      );
    }
  }

  // 8. Create Party Link (best-effort — failure doesn't break the booking)
  let partyLinkUrl: string | null = null;
  try {
    const groupStartUtcIso = new Date(finalArrangement.groupStartMs).toISOString();
    const linkResult = await createPartyLink({
      groupId,
      salonId:         ctx.salonId,
      bookingIds,
      mode,
      groupStartUtcIso,
      baseUrl,
      organizerName:   organizerName!.trim(),
      organizerPhone:  phoneDigits,
    });
    if (linkResult.ok) partyLinkUrl = linkResult.url;
  } catch {
    // Party Link creation failing must not break the group booking confirmation.
    console.warn("[voice/confirm_group_booking] Party Link creation failed (non-fatal).");
  }

  // 9. Link to voice_ai_session (best-effort)
  if (sessionId) {
    try {
      await supabase
        .from("voice_ai_sessions")
        .update({ status: "completed" })
        .eq("id", sessionId);
    } catch { /* best-effort */ }
  }

  // 10. Send ONE confirmation SMS to the ORGANIZER — AWAITED so we report the
  //     real result. Previously group bookings sent NO SMS at all, yet the UI
  //     claimed "SMS sent". We mirror the individual-booking confirmation: a
  //     single SMS to the organizer (the only person whose phone we collected).
  //     Guests have placeholder names/no phones, so they are never messaged here.
  //     SMS failure never fails the booking.
  const totalMembers = ctx.resolvedMembers.length;
  let smsSent = false;
  const firstBookingId = bookingIds[0] ?? null;
  if (firstBookingId) {
    try {
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
      const smsRes = await fetch(`${appUrl}/api/booking/sms-confirm`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId:    firstBookingId,
          salonId:      ctx.salonId,
          clientPhone:  phoneDigits,
          clientName:   organizerName!.trim(),
          serviceName:  `Group of ${totalMembers}`,
          startTimeUtc: new Date(finalArrangement.groupStartMs).toISOString(),
        }),
      });
      const smsJson = await smsRes.json().catch(() => ({})) as { ok?: boolean; error?: string };
      smsSent = smsRes.ok && smsJson.ok === true;
      if (!smsSent) {
        console.warn("[voice/confirm_group_booking] confirmation SMS not sent:", smsJson.error ?? `http_${smsRes.status}`);
      }
    } catch (e: unknown) {
      console.error("[voice/confirm_group_booking] sms-confirm dispatch failed", e);
      smsSent = false;
    }
  }

  return NextResponse.json({
    ok:                true,
    groupId,
    bookingIds,
    partyLinkUrl,
    smsSent,
    pricing: toVoicePendingGroupPricing(created.pricing),
    // Phase 6 wave info — true + waveCount>1 when the large group was split.
    isWaveBooking:     finalArrangement.isWaveBooking,
    waveCount:         finalArrangement.waveCount,
    waves:             finalArrangement.waves.map((w) => ({
      waveNumber:   w.waveNumber,
      startDisplay: w.startDisplay,
      endDisplay:   w.endDisplay,
      memberCount:  w.memberCount,
    })),
    groupStartDisplay: finalArrangement.groupStartDisplay,
    groupEndDisplay:   finalArrangement.groupEndDisplay,
    groupStartTime:    utcMsToSalonHm24(finalArrangement.groupStartMs, ctx.timezone),
    groupEndTime:      utcMsToSalonHm24(finalArrangement.groupEndMs,   ctx.timezone),
    date:              dateYmd,
    totalMembers,
    organizerName:     organizerName!.trim(),
    message:           finalArrangement.isWaveBooking
      ? `Group booking confirmed for ${totalMembers} people across ${finalArrangement.waveCount} waves. Party link is ready to share.`
      : (partyLinkUrl
          ? `Group booking confirmed for ${totalMembers} people. Party link is ready to share.`
          : `Group booking confirmed for ${totalMembers} people.`),
    hint: finalArrangement.isWaveBooking
      ? "WAVE booking confirmed. Tell the organizer their group is split into waves (say each wave's start time and guest count from `waves`). Do NOT read individual staff assignments. Mention the party link will be shared."
      : "Do NOT read individual staff assignments aloud. Tell the customer the group start time, end time, and that the party link will be shared with the group organizer.",
  });
}

// ─── lookup_customer ─────────────────────────────────────────────────────────
// The "memory" tool: given a phone number, return what THIS salon already knows
// about the caller so the receptionist can greet them by name, offer their usual
// service/staff, and avoid allergens. Reads only — never mutates.
//
// Privacy rules enforced here, in code, NOT left to the model:
//
//  • Tenant scoping. `client_profiles` is a GLOBAL, phone-keyed table with no
//    salon_id (see migration 20260618140000_winback.sql), and we read it with
//    the service-role client, so RLS offers no backstop. Matching on phone alone
//    would turn this tool into a cross-tenant oracle: salon A could resolve any
//    phone on the platform to a real person's name and visit history, and learn
//    that they are somebody's customer. So a profile is only ever used after a
//    booking at THIS salon confirms the relationship. No local booking →
//    known:false, exactly as if they were new.
//
//    That check also closes a consent hole: `customer_preferences` is
//    salon-scoped, so for a stranger's profile it comes back null, which made
//    `consent_ai_personalization === false` evaluate false and fall into the
//    FULL personalization branch — the people with no relationship to the salon
//    were the ones getting no consent protection at all.
//
//  • No internal metrics reach the model. is_vip, lifetime spend, no_show_count
//    and owner notes are never selected. `client_ai_summaries.summary_text` is
//    deliberately NOT returned either: it is generated from a staff-facing
//    prompt that includes VIP status, lifetime spend and no-show rate
//    (loadClientProfile360Action.ts), so handing it to a model that speaks to
//    the customer would read their own risk score back to them.
//
//  • consent_ai_personalization === false → name only, nothing else.
async function handleLookupCustomer(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
) {
  const customerPhone = args.customer_phone as string | undefined;
  if (!customerPhone) {
    return NextResponse.json({ error: "missing_customer_phone" }, { status: 400 });
  }

  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  const last9 = phoneSuffixOrNull(customerPhone);
  if (!last9) {
    return NextResponse.json({
      known: false,
      hint:  "Phone number too short to look up. Continue the normal flow.",
    });
  }

  const NOT_KNOWN = {
    known: false,
    hint:  "New customer — ask for their name and continue the normal booking flow. Do not mention that you looked them up.",
  };

  const { data: profiles } = await supabase
    .from("client_profiles")
    .select("id, name, phone, visit_count, last_service_date, preferred_staff_id")
    .ilike("phone", `%${last9}`)
    .is("deleted_at", null)
    .limit(1);
  const profile = profiles?.[0];
  if (!profile) return NextResponse.json(NOT_KNOWN);

  // Tenant gate — the profile is global, so prove the relationship is ours
  // before any of it is spoken aloud.
  const { count: localBookings } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", salon.id)
    .eq("client_profile_id", profile.id)
    .is("deleted_at", null);
  if (!localBookings) return NextResponse.json(NOT_KNOWN);

  // Record who called on the session row (eval/analytics loop) — best-effort.
  if (sessionId) {
    try {
      await supabase
        .from("voice_ai_sessions")
        .update({ client_phone: customerPhone.replace(/\D/g, ""), client_name: profile.name ?? null })
        .eq("id", sessionId);
    } catch { /* best-effort */ }
  }

  const [prefsRes, patternRes] = await Promise.all([
    supabase
      .from("customer_preferences")
      .select("allergies, favorite_colors, favorite_styles, preferred_language, consent_ai_personalization")
      .eq("salon_id", salon.id)
      .eq("client_profile_id", profile.id)
      .maybeSingle(),
    supabase
      .from("customer_booking_patterns")
      .select("usual_service_ids, usual_staff_id, recurring_weekday, recurring_hour, pattern_confidence")
      .eq("salon_id", salon.id)
      .eq("client_profile_id", profile.id)
      .maybeSingle(),
  ]);

  const prefs = prefsRes.data as {
    allergies: string[] | null;
    favorite_colors: string[] | null;
    favorite_styles: string[] | null;
    preferred_language: string | null;
    consent_ai_personalization: boolean | null;
  } | null;

  // Explicit opt-out of AI personalization → greet by name, nothing else.
  if (prefs?.consent_ai_personalization === false) {
    return NextResponse.json({
      known:         true,
      customer_name: profile.name,
      hint:          "Greet by name only. This customer opted out of AI personalization — do NOT reference history or preferences.",
    });
  }

  const pattern = patternRes.data as {
    usual_service_ids: string[] | null;
    usual_staff_id: string | null;
    recurring_weekday: number | null;
    recurring_hour: number | null;
    pattern_confidence: number | null;
  } | null;

  // Resolve usual service names + usual/preferred staff name.
  let usualServices: { id: string; name: string }[] = [];
  if (pattern?.usual_service_ids?.length) {
    const { data: svcRows } = await supabase
      .from("services")
      .select("id, name")
      .eq("salon_id", salon.id)
      .in("id", pattern.usual_service_ids)
      .is("deleted_at", null);
    usualServices = (svcRows ?? []).map((s) => ({ id: s.id, name: s.name }));
  }

  let usualStaff: { id: string; name: string } | null = null;
  // `preferred_staff_id` rides on the GLOBAL profile row, so it can point at
  // another salon's employee. Scoping the lookup to this salon means a foreign
  // id simply resolves to null instead of offering a competitor's staff name.
  const staffId = pattern?.usual_staff_id ?? profile.preferred_staff_id ?? null;
  if (staffId) {
    const { data: st } = await supabase
      .from("staff")
      .select("id, name")
      .eq("id", staffId)
      .eq("salon_id", salon.id)
      .eq("status", "active")
      .is("deleted_at", null)
      .maybeSingle();
    if (st) usualStaff = { id: st.id, name: st.name };
  }

  return NextResponse.json({
    known:           true,
    customer_name:   profile.name,
    visit_count:     localBookings,
    is_regular:      localBookings >= 3,
    last_visit:      profile.last_service_date ?? null,
    usual_services:  usualServices,
    usual_staff:     usualStaff,
    allergies:       prefs?.allergies ?? [],
    favorite_colors: prefs?.favorite_colors ?? [],
    favorite_styles: prefs?.favorite_styles ?? [],
    preferred_language: prefs?.preferred_language ?? null,
    hint:
      "Returning customer — greet them warmly BY NAME. If usual_services/usual_staff exist, offer them first " +
      "(e.g. 'Chị làm gel với Vy như mọi lần không?'). Use allergies only to steer away from allergens — " +
      "never recite the list. NEVER mention visit counts, spend, internal notes, or that you 'looked them up'.",
  });
}

// ─── leave_message_for_owner ─────────────────────────────────────────────────
// Escalation path: when the customer needs something beyond the receptionist's
// tools (complaint, refund, special request), take a message. Durable log row
// first (ai_actions_log — visible in the dashboard), then owner alert via the
// salon's configured channel (email / SMS / both). Alert failure never fails the
// tool: the logged row is the source of truth.
//
// Two abuse controls, because this tool spends real money (Twilio/Resend) and is
// reachable from surfaces with no authentication:
//   • the message is truncated ONCE, before both the log row and the alert. The
//     original capped only the log row and interpolated the raw string into the
//     alert body, so a 3,000-character message became ~20 billed SMS segments.
//   • a per-salon hourly quota, counted off the durable log rows themselves so
//     it survives restarts and cannot be reset by minting a new session id.
const ESCALATION_MAX_CHARS = 1000;
const ESCALATION_MAX_PER_SALON_PER_HOUR = 10;

async function handleLeaveMessageForOwner(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
) {
  const rawMessage    = (args.message        as string | undefined)?.trim();
  const customerName  = (args.customer_name  as string | undefined)?.trim() ?? "";
  const customerPhone = (args.customer_phone as string | undefined)?.trim() ?? "";
  const urgency       = args.urgency === "urgent" ? "urgent" : "normal";

  if (!rawMessage) return NextResponse.json({ error: "missing_message" }, { status: 400 });
  const message = rawMessage.slice(0, ESCALATION_MAX_CHARS);

  const { data: salon } = await supabase
    .from("salons")
    .select("id, name")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentCount } = await supabase
    .from("ai_actions_log")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", salon.id)
    .eq("action_type", "customer_message_escalation")
    .gte("created_at", oneHourAgo);

  if ((recentCount ?? 0) >= ESCALATION_MAX_PER_SALON_PER_HOUR) {
    // Deliberately a soft, non-error response: the caller may well be a real
    // customer with a real complaint, and the receptionist should stay helpful
    // rather than surface a system limit.
    return NextResponse.json({
      success: false,
      throttled: true,
      hint:
        "The salon has received a lot of messages in the past hour. Apologise, and ask the customer to call the salon directly or try again later. Do NOT retry this tool.",
    });
  }

  let logged = false;
  try {
    const { error } = await supabase.from("ai_actions_log").insert({
      salon_id:    salon.id,
      agent:       "receptionist",
      action_type: "customer_message_escalation",
      payload: {
        customer_name:    customerName || null,
        customer_phone:   customerPhone || null,
        message,
        urgency,
        voice_session_id: sessionId,
      },
    });
    logged = !error;
  } catch { /* fall through to the alert */ }

  if (!logged) {
    return NextResponse.json({
      success: false,
      error: "message_not_saved",
      hint:
        "Apologise that the message could not be saved. Do not say it was sent or passed to the owner. " +
        "Ask the customer to call the salon directly or try again later.",
    }, { status: 500 });
  }

  try {
    const { sendOwnerAlert } = await import("@/shared/ai/sendOwnerAlert");
    const flag = urgency === "urgent" ? "🔴 KHẨN — " : "";
    await sendOwnerAlert(String(salon.id), {
      subject:  `${flag}Lời nhắn từ khách qua AI Tiếp tân${customerName ? ` — ${customerName}` : ""}`,
      bodyText:
        `Khách: ${customerName || "(không rõ tên)"}\n` +
        `SĐT: ${customerPhone || "(chưa cung cấp)"}\n` +
        `Nội dung: ${message}\n\n` +
        `— Ghi nhận bởi AI Tiếp tân (voice/chat).`,
    });
  } catch (e) {
    console.error("[leave_message_for_owner] owner alert failed", e);
  }

  return NextResponse.json({
    success: true,
    logged: true,
    saved_to: "Dashboard > Nhật ký hoạt động > AI",
    hint:
      "Tell the customer their message was saved for the salon staff. Do not claim the owner was " +
      "notified, and do not promise an exact response time. Staff can review it in Dashboard > " +
      "Nhật ký hoạt động > AI.",
  });
}
