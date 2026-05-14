import * as Sentry from "@sentry/nextjs";
import {
  ConflictCheckBooking,
  checkBookingConflict,
} from "@/shared/lib/conflictCheck";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { salonDayRangeUtc, salonToday, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import { createClient } from "@/shared/lib/supabase/client";

/**
 * Group booking submission — 2–4 friends/family booking together.
 *
 * Each member becomes its own `bookings` row, all sharing a `group_id`
 * UUID. Insert is atomic via the `insert_group_bookings` PostgreSQL
 * function (migration 20260512200000) — if member N conflicts, the
 * whole transaction rolls back and the client sees a structured
 * `slot_conflict` with the index list of conflicting members.
 *
 * Reuses (DOES NOT reimplement):
 *   - `salonWallTimeToUtcIso` for date+time → UTC conversion
 *     (DST-safe binary search; handles every salon timezone)
 *   - `checkBookingConflict` for app-level pre-flight check (same
 *     contract as `submitPublicBooking.ts`)
 *   - `bookings_no_overlap` GIST EXCLUDE constraint as DB-level
 *     guard against true races; the RPC translates 23P01 → the
 *     `slot_conflict` error code
 *   - `idempotency_key` UNIQUE index for double-submit protection;
 *     the RPC translates 23505 → `duplicate_submission`
 *
 * Out of scope (Phase 2+ tracked in CLAUDE.md):
 *   - Splitting a group into individuals post-confirm
 *   - Merging individuals into a group
 *   - Walk-in queue integration
 *   - Editing one member's slot after the group is confirmed
 *     (individual edit still works via the existing single-booking
 *     edit path; that's not part of this action)
 */

export type GroupBookingMember = {
  name: string;
  phone: string;
  email?: string | null;
  notes?: string | null;
  serviceId: string;
  /** UUID or the "any" sentinel — Phase 1 requires explicit staff for
   * each member so cross-member conflict detection is deterministic.
   * If the spec ever supports "any" inside a group, the picker must
   * run server-side after the per-member checks. */
  staffId: string;
  /** YYYY-MM-DD in salon-local time (not UTC). */
  date: string;
  /** HH:MM (24h) in salon-local time. */
  time: string;
};

export type GroupBookingParams = {
  shopSlug: string;
  members: GroupBookingMember[];
  /** Client-generated UUID (crypto.randomUUID()). Submitting the same
   * key a second time hits the UNIQUE constraint and returns
   * `duplicate_submission` rather than creating a second group. */
  idempotencyKey: string;
  /** Task #09-11 honeypot. Optional; matches the public booking
   *  contract. UI plumbing in `BookingGroupFlow.tsx` is TODO —
   *  accepting the field now means a future hidden input there can
   *  ship as a UI-only change. Empty / unset = pass-through to the
   *  real flow. */
  clientWebsite?: string;
};

export type GroupBookingResult =
  | { ok: true; groupId: string; bookingIds: string[] }
  | {
      ok: false;
      reason: "slot_conflict";
      conflictingMembers: number[];
      /** P1.6 — distinguishes "two members in this group collided
       * with each other" from "another customer just took that
       * slot". UI copy differs: cross-member asks the user to pick
       * a different staff/time within the group, external blames
       * the race and asks for a different time entirely. The DB-
       * level race always surfaces as `external` because we can't
       * attribute the lost slot to a specific in-group pair. */
      conflictKind: "cross_member" | "external";
    }
  | {
      ok: false;
      reason:
        | "duplicate_submission"
        | "salon_paused"
        | "salon_not_found"
        | "salon_closed_day"
        | "invalid_input"
        | "invalid_group_size"
        // Task #04-C — `service_not_found` / `staff_not_found` are
        // retained for backward-compat with any external caller
        // that may already pattern-match on them. New code paths
        // (Task #04-C FIX 12 / FIX 13) prefer the more specific
        // `_unavailable` reasons below, which carry `memberIndex`
        // so the UI can recover (auto re-run scheduler for staff,
        // navigate to step 2 with highlight for service).
        | "service_not_found"
        | "staff_not_found"
        | "past_date"
        | "server_error"
        // P1 #18–#20 (QA re-sweep 2026-05-12) — granular validation
        // reasons so the UI can show "phone format wrong" / "email
        // format wrong" etc. instead of the catch-all
        // "couldn't book". Each maps 1:1 onto a copy key in
        // `groupBooking.bookingErrors.*`. `invalid_input` is kept as
        // a defensive fallback for inputs that fail before per-member
        // validation (idempotency key, members array shape).
        | "invalid_name"
        | "invalid_phone"
        | "invalid_email"
        | "invalid_time"
        | "invalid_date"
        // Task #04-C FIX 12 — staff was deleted / inactivated
        // between the user picking an arrangement and submitting.
        // Recoverable by re-running the scheduler.
        | "staff_unavailable"
        // Task #04-C FIX 13 — service was soft-deleted between
        // step 2 and submit. Recoverable only by sending the user
        // back to step 2 to pick a different service.
        | "service_unavailable";
      /** 1-indexed member number for granular per-member errors so
       *  the UI can say "Person 2 has an invalid phone". `null` when
       *  the error is global (e.g. invalid group size). */
      memberNumber?: number | null;
      /** 0-indexed member position — same as `memberNumber - 1`,
       *  surfaced specifically for `staff_unavailable` /
       *  `service_unavailable` where the UI needs to operate on the
       *  member array (highlight a card / pre-select a member for
       *  re-pick). */
      memberIndex?: number | null;
    };

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

function parseHmToMinutes(hm: string): number | null {
  const m = HHMM_RE.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function fail(
  reason: Exclude<
    Extract<GroupBookingResult, { ok: false }>["reason"],
    "slot_conflict"
  >,
  memberNumber: number | null = null,
): GroupBookingResult {
  return { ok: false, reason, memberNumber };
}

export async function submitGroupBooking(
  params: GroupBookingParams,
): Promise<GroupBookingResult> {
  const scope = Sentry.getCurrentScope();
  scope.setTag("booking.flow", "submit_group_booking");
  scope.setTag("salon.slug", params.shopSlug);

  // Task #09-11 — honeypot guard. Mirrors `submitPublicBooking`.
  // `BookingGroupFlow.tsx` does not yet render a hidden input that
  // sets this field, so today the branch never fires from the real
  // UI — accepting the field positions the server side to short-
  // circuit silently as soon as the UI plumbing lands.
  if ((params.clientWebsite ?? "").trim().length > 0) {
    Sentry.captureMessage("group booking honeypot tripped", {
      level: "info",
      tags: {
        "booking.flow": "submit_group_booking",
        "booking.honeypot": "tripped",
        "salon.slug": params.shopSlug,
      },
    });
    return {
      ok: true,
      groupId: `bot-${Date.now()}`,
      bookingIds: [],
    };
  }

  // 1. Surface-level validation -------------------------------------
  // QA P1.G5: raised cap 4 → 8 (wedding parties, family groups).
  // DB function enforces the same range; this client-side check
  // gives a faster reject before the RPC round-trip.
  if (!Array.isArray(params.members) || params.members.length < 2 || params.members.length > 8) {
    return fail("invalid_group_size");
  }
  if (typeof params.idempotencyKey !== "string" || params.idempotencyKey.trim().length === 0) {
    return fail("invalid_input");
  }
  // P1 #20 (QA re-sweep 2026-05-12) — granular per-field reasons.
  // Each branch identifies the failing FIELD and the 1-indexed
  // MEMBER number so the UI can render copy like "Person 2 has an
  // invalid phone" instead of "couldn't book the group".
  for (let i = 0; i < params.members.length; i++) {
    const m = params.members[i];
    const memberNumber = i + 1;
    const nameTrim = (m.name ?? "").trim();
    if (nameTrim.length === 0 || nameTrim.length > BOOKING_GUEST_NAME_MAX) {
      return fail("invalid_name", memberNumber);
    }
    if (!isValidCustomerName(nameTrim)) {
      return fail("invalid_name", memberNumber);
    }
    const phoneOk = validateGuestPhone(m.phone ?? "");
    if (!phoneOk.ok) {
      return fail("invalid_phone", memberNumber);
    }
    const emailRaw = (m.email ?? "").trim();
    if (emailRaw.length > 0 && !isValidEmailFormat(emailRaw)) {
      return fail("invalid_email", memberNumber);
    }
    if (parseHmToMinutes(m.time ?? "") === null) {
      return fail("invalid_time", memberNumber);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date ?? "")) {
      return fail("invalid_date", memberNumber);
    }
  }

  const supabase = createClient();

  // 2. Salon ---------------------------------------------------------
  // `profile_complete` is the single source of truth for "salon
  // accepting bookings" (see submitPublicBooking.ts:173 and
  // loadBookingServices.ts where `acceptingBookings` is derived
  // from this column).
  const { data: salonRaw, error: salonErr } = await supabase
    .from("salons")
    .select("id, profile_complete, opening_hours, timezone, booking_closed_dates")
    .eq("slug", params.shopSlug)
    .maybeSingle();

  if (salonErr || !salonRaw) return fail("salon_not_found");
  const salonRow = salonRaw as unknown as {
    id: string;
    profile_complete?: unknown;
    opening_hours?: unknown;
    timezone?: unknown;
    booking_closed_dates?: unknown;
  };
  if (!salonRow.profile_complete) return fail("salon_paused");

  // Task #04-C (post #04-B cleanup) — `salons.timezone` is NOT NULL
  // (migration 20260512600000_timezone_required). The legacy
  // `?? "UTC"` fallback was dead code that, before the constraint,
  // would have silently produced 8-hour-offset bookings. We now
  // hard-fail with `server_error` rather than risk wrong slot
  // math; the constraint makes this unreachable in normal flow.
  const timezone =
    typeof salonRow.timezone === "string" && salonRow.timezone.trim().length > 0
      ? salonRow.timezone.trim()
      : null;
  if (timezone === null) {
    Sentry.captureMessage("submitGroupBooking timezone missing on salon row", {
      level: "error",
      extra: { salon_id: salonRow.id, slug: params.shopSlug },
    });
    return fail("server_error");
  }

  const closedYmdSet = parseBookingClosedDateSet(salonRow.booking_closed_dates);
  for (const m of params.members) {
    if (closedYmdSet.has(m.date)) return fail("salon_closed_day");
  }

  // P1.2 — past-date guard, mirrors submitPublicBooking.ts:199. The
  // client also `min`-bounds the date input, but a manually-crafted
  // payload bypasses that. Compares YMD strings in salon timezone to
  // avoid server-tz drift.
  const todayYmd = salonToday(timezone);
  for (const m of params.members) {
    if (m.date < todayYmd) return fail("past_date");
  }

  scope.setTag("salon.id", String(salonRow.id));
  scope.setTag("group.size", String(params.members.length));

  // 3. Services ------------------------------------------------------
  const serviceIds = Array.from(new Set(params.members.map((m) => m.serviceId)));
  const { data: services, error: svcErr } = await supabase
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes, price_cents")
    .in("id", serviceIds)
    .eq("salon_id", salonRow.id)
    .is("deleted_at" as never, null);
  if (svcErr) return fail("server_error");
  const serviceById = new Map<string, {
    id: string;
    duration: number;
    buffer: number;
    priceCents: number | null;
  }>();
  for (const s of services ?? []) {
    serviceById.set(String(s.id), {
      id: String(s.id),
      duration: Number(s.duration_minutes) || 0,
      buffer: Number(s.buffer_minutes) || 0,
      priceCents: s.price_cents != null ? Number(s.price_cents) : null,
    });
  }
  // Task #04-C FIX 13 — pinpoint which member's service vanished.
  // The select above already filtered `deleted_at IS NULL`, so a
  // missing id means the service was soft-deleted between step 2
  // and submit. UI navigates back to step 2 + highlights the
  // affected card.
  for (let i = 0; i < params.members.length; i++) {
    const m = params.members[i];
    if (!serviceById.has(m.serviceId)) {
      return {
        ok: false,
        reason: "service_unavailable",
        memberNumber: i + 1,
        memberIndex: i,
      };
    }
  }

  // 4. Staff ---------------------------------------------------------
  const staffIds = Array.from(new Set(params.members.map((m) => m.staffId)));
  const { data: staffRows, error: staffErr } = await supabase
    .from("staff")
    .select("id")
    .in("id", staffIds)
    .eq("salon_id", salonRow.id)
    .eq("status", "active")
    .is("deleted_at" as never, null);
  if (staffErr) return fail("server_error");
  const staffSet = new Set((staffRows ?? []).map((s) => String(s.id)));
  // Task #04-C FIX 12 — pinpoint which member's preferred staff
  // disappeared between arrangement-pick and submit. The select
  // above filtered `status='active'` + `deleted_at IS NULL`, so a
  // missing id means the staff was deleted, paused, or marked
  // inactive in the meantime. UI auto re-runs the scheduler so the
  // remaining members get fresh staff suggestions.
  for (let i = 0; i < params.members.length; i++) {
    const m = params.members[i];
    if (!staffSet.has(m.staffId)) {
      return {
        ok: false,
        reason: "staff_unavailable",
        memberNumber: i + 1,
        memberIndex: i,
      };
    }
  }

  // 5. Resolve each member's UTC range -------------------------------
  // Salon-local YYYY-MM-DD + HH:MM → UTC ISO via the existing
  // DST-safe helper. We avoid `new Date(local)` math here — that path
  // uses the SERVER's timezone, not the salon's.
  type Resolved = {
    member: GroupBookingMember;
    startUtcIso: string;
    endUtcIso: string;
    startMs: number;
    endMs: number;
    durationMin: number;
    bufferMin: number;
    priceCents: number | null;
  };
  const resolved: Resolved[] = [];
  for (const m of params.members) {
    const svc = serviceById.get(m.serviceId)!;
    const totalMin = svc.duration + svc.buffer;
    const startMinutes = parseHmToMinutes(m.time)!;
    const startUtcIso = salonWallTimeToUtcIso(m.date, startMinutes, timezone);
    const startMs = Date.parse(startUtcIso);
    const endMs = startMs + totalMin * 60_000;
    resolved.push({
      member: m,
      startUtcIso,
      endUtcIso: new Date(endMs).toISOString(),
      startMs,
      endMs,
      durationMin: svc.duration,
      bufferMin: svc.buffer,
      priceCents: svc.priceCents,
    });
  }

  // 6. Cross-member conflict check (app-level pre-flight) ------------
  // Two members on the same staff with overlapping ranges = conflict.
  // The DB GIST constraint also catches this at insert time; we run
  // the app check first so we can return a structured list of
  // conflicting indices for the UI to highlight.
  //
  // P1.6 — track in-group conflicts separately from external ones so
  // the UI can show distinct copy. In-group: "two members chose the
  // same staff". External: "another customer just took it".
  const crossMemberConflicts = new Set<number>();
  const externalConflicts = new Set<number>();
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (resolved[i].member.staffId !== resolved[j].member.staffId) continue;
      if (
        intervalsOverlapMs(
          resolved[i].startMs,
          resolved[i].endMs,
          resolved[j].startMs,
          resolved[j].endMs,
        )
      ) {
        crossMemberConflicts.add(i);
        crossMemberConflicts.add(j);
      }
    }
  }

  // 7. Per-member conflict vs existing bookings ----------------------
  // Load occupancy for every salon day involved in the group, then
  // run `checkBookingConflict` per member — the exact same helper
  // single bookings use.
  const distinctDays = Array.from(new Set(params.members.map((m) => m.date)));
  const occByStaff = new Map<string, ConflictCheckBooking[]>();
  for (const ymd of distinctDays) {
    const { startUtc, endUtc } = salonDayRangeUtc(ymd, timezone);
    const { data: rows } = await supabase
      .from("bookings")
      .select("id, staff_id, start_time_utc, end_time_utc, status, client_name")
      .eq("salon_id", salonRow.id)
      .gte("start_time_utc", startUtc)
      .lt("start_time_utc", endUtc);
    for (const row of rows ?? []) {
      const sid = row.staff_id == null ? "" : String(row.staff_id);
      if (!sid) continue;
      const arr = occByStaff.get(sid) ?? [];
      arr.push({
        id: String(row.id),
        staff_id: sid,
        start_time_utc: row.start_time_utc as string | null,
        end_time_utc: row.end_time_utc as string | null,
        status: String(row.status ?? ""),
        client_name: String(row.client_name ?? ""),
      });
      occByStaff.set(sid, arr);
    }
  }

  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    const occ = occByStaff.get(r.member.staffId) ?? [];
    const conflict = checkBookingConflict({
      staffId: r.member.staffId,
      startUtcIso: r.startUtcIso,
      endUtcIso: r.endUtcIso,
      existingBookings: occ,
    });
    if (conflict !== null) externalConflicts.add(i);
  }

  if (crossMemberConflicts.size > 0 || externalConflicts.size > 0) {
    // Cross-member is the more actionable category — surface it
    // first if both are present. The UI highlights all conflicting
    // indices regardless.
    const all = new Set([...crossMemberConflicts, ...externalConflicts]);
    return {
      ok: false,
      reason: "slot_conflict",
      conflictingMembers: Array.from(all).sort((a, b) => a - b),
      conflictKind: crossMemberConflicts.size > 0 ? "cross_member" : "external",
    };
  }

  // 8. Atomic RPC insert ---------------------------------------------
  // RPC owns the transaction boundary. Single-key idempotency: the
  // same `idempotencyKey` is stamped on every member so a re-submit
  // of the exact same payload hits the partial UNIQUE on member 1
  // and the function returns `duplicate_submission`.
  const idem = params.idempotencyKey;
  const payload = resolved.map((r) => {
    const phoneOk = validateGuestPhone(r.member.phone);
    const phoneDigits = phoneOk.ok ? phoneOk.digits : r.member.phone;
    const emailRaw = (r.member.email ?? "").trim();
    const notesRaw = (r.member.notes ?? "").trim();
    return {
      salon_id: salonRow.id,
      staff_id: r.member.staffId,
      service_id: r.member.serviceId,
      client_name: r.member.name.trim(),
      client_phone: phoneDigits,
      client_email: emailRaw.length > 0 ? emailRaw : null,
      client_notes: notesRaw.length > 0 ? notesRaw : null,
      start_time_utc: r.startUtcIso,
      end_time_utc: r.endUtcIso,
      price_cents: r.priceCents,
      staff_requested_by_client: true,
      idempotency_key: idem,
    };
  });

  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    "insert_group_bookings",
    { p_bookings: payload },
  );

  if (rpcErr) {
    Sentry.captureException(rpcErr, {
      tags: {
        "booking.rpc": "insert_group_bookings",
        "booking.flow": "group",
      },
      extra: { code: rpcErr.code, message: rpcErr.message },
    });
    // 23P01 / 23505 should be caught inside the RPC and surface as
    // structured JSON; if they reach here it means the RPC itself
    // didn't trap them (e.g. older deployed version).
    if (rpcErr.code === "23P01") {
      // DB-level race → another customer took it. Can't attribute
      // to a specific in-group pair, so kind = external.
      return {
        ok: false,
        reason: "slot_conflict",
        conflictingMembers: [],
        conflictKind: "external",
      };
    }
    if (rpcErr.code === "23505") return fail("duplicate_submission");
    return fail("server_error");
  }

  const result = rpcData as
    | {
        success?: boolean;
        code?: string;
        group_id?: string;
        booking_ids?: string[];
      }
    | null;
  if (!result || typeof result !== "object") return fail("server_error");
  if (result.success === false) {
    const code = result.code ?? "";
    if (code === "slot_conflict") {
      // DB-level race → another customer took it. Can't attribute
      // to a specific in-group pair, so kind = external.
      return {
        ok: false,
        reason: "slot_conflict",
        conflictingMembers: [],
        conflictKind: "external",
      };
    }
    if (code === "duplicate_submission") return fail("duplicate_submission");
    if (code === "invalid_group_size") return fail("invalid_group_size");
    Sentry.captureMessage("insert_group_bookings unknown error code", {
      level: "error",
      extra: { code },
    });
    return fail("server_error");
  }
  if (
    result.success !== true ||
    typeof result.group_id !== "string" ||
    !Array.isArray(result.booking_ids)
  ) {
    return fail("server_error");
  }

  // Task #04-D FIX 15 — client_profiles upsert parity. The
  // individual flow (submitPublicBooking.ts:554) upserts the
  // guest into `client_profiles` so:
  //   - the receptionist phone-lookup card shows them as a
  //     returning customer next visit,
  //   - `visit_count` + `last_service_date` feed the owner's
  //     reports, and
  //   - `preferred_staff_id` powers the "Often with X" hint.
  // Group bookings used to skip this entirely — each member
  // landed in `bookings` but never appeared in `client_profiles`,
  // so a group customer looked brand-new on their next visit and
  // their revenue didn't roll up. We mirror the individual flow
  // exactly: best-effort post-RPC upsert; failures are Sentry'd
  // but never propagate back to the customer (booking is already
  // confirmed; profile bookkeeping must not break confirmation).
  //
  // Dedup by phone digits so a parent booking under their own
  // number for a child (same phone, different member rows)
  // upserts only once. First member with that phone wins for
  // `name`/`preferred_staff_id`.
  try {
    const byPhoneDigits = new Map<
      string,
      { name: string; staffId: string }
    >();
    for (const r of resolved) {
      const v = validateGuestPhone(r.member.phone);
      if (!v.ok) continue;
      if (byPhoneDigits.has(v.digits)) continue;
      byPhoneDigits.set(v.digits, {
        name: r.member.name.trim(),
        staffId: r.member.staffId,
      });
    }

    const nowIso = new Date().toISOString();
    const profileOps = Array.from(byPhoneDigits.entries()).map(
      async ([digits, info]) => {
        const { data: existingProfile } = await supabase
          .from("client_profiles")
          .select("visit_count")
          .eq("phone", digits)
          .is("deleted_at" as never, null)
          .maybeSingle();

        const nextVisits = (existingProfile?.visit_count ?? 0) + 1;

        const { error: profileUpsertErr } = await supabase
          .from("client_profiles")
          .upsert(
            {
              phone: digits,
              name: info.name,
              preferred_staff_id: info.staffId,
              last_service_date: nowIso,
              visit_count: nextVisits,
            },
            { onConflict: "phone" },
          );

        if (profileUpsertErr) {
          const err = new Error(profileUpsertErr.message);
          err.name = "ClientProfilesUpsertError";
          Sentry.captureException(err, {
            tags: {
              "booking.rpc": "client_profiles",
              "booking.rpc.failure": "upsert_best_effort",
              "booking.flow": "group",
            },
            extra: { message: profileUpsertErr.message },
          });
        }
      },
    );
    await Promise.all(profileOps);
  } catch {
    /* booking succeeded; profile update is best-effort */
  }

  // Task #04-D FIX 02 — atomic-rollback observability. The RPC
  // is wrapped in a single PL/pgSQL transaction so the only ways
  // we should see a length mismatch here are:
  //   (a) the RPC was redeployed with a different contract and
  //       the client didn't get the version bump, or
  //   (b) a future RPC author breaks atomicity (e.g. catches a
  //       per-row exception inside the loop).
  // Both are silent-data-loss bugs from the customer's POV —
  // they see "booking confirmed for 4" but only 3 rows exist.
  // Sentry capture surfaces the drift; we still return ok so the
  // confirmation page renders for the rows that did land.
  if (result.booking_ids.length !== params.members.length) {
    Sentry.captureMessage("group_booking_partial_rollback", {
      level: "error",
      tags: {
        "booking.rpc": "insert_group_bookings",
        "booking.flow": "group",
      },
      extra: {
        groupId: result.group_id,
        successCount: result.booking_ids.length,
        totalCount: params.members.length,
        salonId: salonRow.id,
        slug: params.shopSlug,
      },
    });
  }

  return {
    ok: true,
    groupId: result.group_id,
    bookingIds: result.booking_ids.map((s) => String(s)),
  };
}
