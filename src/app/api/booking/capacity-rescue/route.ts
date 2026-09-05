import { NextResponse, type NextRequest } from "next/server";

import { capacityRescueRequestSchema } from "@/shared/booking/capacityRescueRequestSchema";
import { verifyIndividualWaitlistAvailability } from "@/shared/booking/verifyIndividualWaitlistAvailability";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";

export const dynamic = "force-dynamic";

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return false;
  }
  const allowed = new Set([request.nextUrl.origin]);
  for (const value of [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
    process.env.VERCEL_BRANCH_URL
      ? `https://${process.env.VERCEL_BRANCH_URL}`
      : null,
  ]) {
    if (!value) continue;
    try {
      allowed.add(new URL(value).origin);
    } catch {
      // A malformed deployment value is never an authorization grant.
    }
  }
  return allowed.has(origin);
}

async function rateLimitAllowed(key: string): Promise<boolean | null> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "rate_limit_hit",
      { p_key: key, p_limit: 20, p_window_seconds: 300 },
    );
    return error || typeof data !== "boolean" ? null : data;
  } catch {
    return null;
  }
}

function response(body: object, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function recordApplicationDecision(input: {
  salonId: string;
  requestId: string;
  requestKind: "individual" | "sequence" | "group";
  serviceId: string;
  staffId: string | null;
  bookingDateYmd: string;
  preferredSlotLabel: string | null;
  outcome: "slot_available" | "availability_unverified";
}) {
  try {
    await createServiceRoleClient()
      .from("capacity_rescue_decision_events")
      .insert({
        salon_id: input.salonId,
        request_id: input.requestId,
        decision_source: "application_precheck",
        request_kind: input.requestKind,
        service_id: input.serviceId,
        staff_id: input.staffId,
        booking_date: input.bookingDateYmd,
        preferred_slot_label: input.preferredSlotLabel,
        outcome: input.outcome,
        reason_code: input.outcome,
        app_version: process.env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
      });
  } catch {
    // Decision evidence is best-effort; it must never weaken the fail-closed
    // booking response or expose customer PII through error logging.
  }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request))
    return response({ ok: false, code: "forbidden" }, 403);

  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length < 0 || length > 16_384) {
    return response({ ok: false, code: "invalid_request" }, 400);
  }

  const allowed = await rateLimitAllowed(
    `capacity-rescue:ip:${clientIp(request)}`,
  );
  if (allowed === null) {
    return response({ ok: false, code: "availability_unverified" }, 503);
  }
  if (!allowed) return response({ ok: false, code: "rate_limited" }, 429);

  const parsed = capacityRescueRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return response({ ok: false, code: "invalid_request" }, 400);

  const input = parsed.data;
  const phone = validateGuestPhone(input.clientPhone);
  if (!phone.ok || !isValidCustomerName(input.clientName)) {
    return response({ ok: false, code: "invalid_request" }, 400);
  }

  const db = createServiceRoleClient();
  const { data: salon, error: salonError } = await db
    .from("salons")
    .select("id, slug")
    .eq("id", input.salonId)
    .maybeSingle();
  if (salonError || !salon || typeof salon.slug !== "string") {
    return response({ ok: false, code: "availability_unverified" }, 503);
  }

  // Resolve an exact request-ID retry before rechecking live capacity. A slot
  // may have opened after the first durable insert; the original receipt must
  // still win, and a changed payload must never reuse that receipt.
  const { data: existing, error: existingError } = await db
    .from("booking_waitlist_entries")
    .select(
      "id, status, request_kind, booking_date, preferred_slot_label, party_size, client_name, client_phone, client_email, client_locale, intent_json",
    )
    .eq("salon_id", input.salonId)
    .eq("request_id", input.requestId)
    .maybeSingle();
  if (existingError) {
    return response({ ok: false, code: "availability_unverified" }, 503);
  }
  if (existing) {
    const samePayload =
      existing.request_kind === input.requestKind &&
      String(existing.booking_date).slice(0, 10) === input.bookingDateYmd &&
      (existing.preferred_slot_label || null) === input.preferredSlotLabel &&
      Number(existing.party_size) === input.partySize &&
      String(existing.client_name).trim() === input.clientName.trim() &&
      String(existing.client_phone).replace(/\D/g, "") === phone.digits &&
      String(existing.client_email).trim().toLowerCase() ===
        input.clientEmail.trim().toLowerCase() &&
      String(existing.client_locale) === input.clientLocale &&
      stableJson(existing.intent_json) === stableJson(input.intent);
    if (!samePayload) {
      return response({ ok: false, code: "request_id_conflict" }, 409);
    }
    if (!["waiting", "review_required", "notified"].includes(existing.status)) {
      return response({ ok: false, code: "request_already_resolved" }, 409);
    }
    return response(
      {
        ok: true,
        outcome:
          input.requestKind === "individual"
            ? input.intent.source === "booking_conflict"
              ? "booking_conflict"
              : "slot_unavailable"
            : "capacity_unavailable",
        receipt: {
          requestId: existing.id,
          status: existing.status,
          createdNew: false,
        },
      },
      200,
    );
  }

  if (input.requestKind === "individual") {
    const availability = await verifyIndividualWaitlistAvailability({
      salonSlug: salon.slug,
      salonId: input.salonId,
      serviceId: input.primaryServiceId,
      staffId: input.staffId,
      bookingDateYmd: input.bookingDateYmd,
      preferredSlotLabel: input.preferredSlotLabel,
    });
    if (availability.outcome === "availability_unverified") {
      await recordApplicationDecision({
        salonId: input.salonId,
        requestId: input.requestId,
        requestKind: input.requestKind,
        serviceId: input.primaryServiceId,
        staffId: input.staffId,
        bookingDateYmd: input.bookingDateYmd,
        preferredSlotLabel: input.preferredSlotLabel,
        outcome: availability.outcome,
      });
      return response({ ok: false, code: "availability_unverified" }, 503);
    }
    if (availability.outcome === "slot_available") {
      await recordApplicationDecision({
        salonId: input.salonId,
        requestId: input.requestId,
        requestKind: input.requestKind,
        serviceId: input.primaryServiceId,
        staffId: input.staffId,
        bookingDateYmd: input.bookingDateYmd,
        preferredSlotLabel: input.preferredSlotLabel,
        outcome: availability.outcome,
      });
      return response(
        {
          ok: false,
          code: "slot_available",
          slotLabel: availability.slotLabel,
        },
        409,
      );
    }
  }

  const { data, error } = await db.rpc(
    "create_public_capacity_rescue_request_v2" as never,
    {
      p_salon_id: input.salonId,
      p_request_id: input.requestId,
      p_request_kind: input.requestKind,
      p_primary_service_id: input.primaryServiceId,
      p_staff_id: input.staffId,
      p_booking_date: input.bookingDateYmd,
      p_preferred_slot_label: input.preferredSlotLabel ?? "",
      p_party_size: input.partySize,
      p_client_name: input.clientName.trim(),
      p_client_phone: phone.digits,
      p_client_email: input.clientEmail.trim().toLowerCase(),
      p_client_locale: input.clientLocale,
      p_intent_json: input.intent,
      p_app_version: process.env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
    } as never,
  );
  if (error) return response({ ok: false, code: "request_failed" }, 503);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return response({ ok: false, code: "request_failed" }, 503);
  }
  const raw = row as Record<string, unknown>;
  if (raw.guard_outcome === "availability_unverified") {
    return response({ ok: false, code: "availability_unverified" }, 503);
  }
  if (raw.guard_outcome === "slot_available") {
    return response(
      {
        ok: false,
        code: "slot_available",
        ...(typeof raw.slot_label === "string"
          ? { slotLabel: raw.slot_label }
          : {}),
      },
      409,
    );
  }
  if (
    typeof raw.id !== "string" ||
    !["waiting", "review_required", "notified"].includes(String(raw.status)) ||
    !["slot_unavailable", "capacity_not_applicable"].includes(
      String(raw.guard_outcome),
    )
  ) {
    return response({ ok: false, code: "request_failed" }, 503);
  }

  return response(
    {
      ok: true,
      outcome:
        input.requestKind === "individual"
          ? input.intent.source === "booking_conflict"
            ? "booking_conflict"
            : "slot_unavailable"
          : "capacity_unavailable",
      receipt: {
        requestId: raw.id,
        status: raw.status,
        createdNew: raw.created_new === true,
      },
    },
    200,
  );
}
