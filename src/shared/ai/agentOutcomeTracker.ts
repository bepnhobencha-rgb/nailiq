import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  decideOutcomeResolution,
  outcomeDeadline,
  OUTCOME_WINDOW_DAYS,
  sortLatestActionFirst,
} from "@/shared/ai/outcomeAttribution";

/**
 * Outcome Tracker — did Minh's action actually bring the client back?
 *
 * Runs daily at 09:00 salon time. Finds pending actions sent 7-60 days ago,
 * checks if the client has a new booking afterward → marks converted / no_conversion.
 *
 * Window per agent (days to wait before declaring no_conversion):
 *   winback    21d — lapsed regulars take a few weeks to decide
 *   rebook     14d — rhythm-based, shorter window
 *   first_visit 28d — new clients need more time
 *   vip_care   30d — milestone messages, relaxed window
 */

const TRACKABLE_AGENTS = Object.keys(OUTCOME_WINDOW_DAYS);

type TrackableAction = {
  id: string;
  agent: string;
  action_type: string;
  target_id: string | null;
  created_at: string;
  payload: Record<string, unknown> | null;
};

function cleanPhone(value: unknown): string {
  return String(value ?? "").trim();
}

function phoneIdentity(value: unknown): string {
  return cleanPhone(value).replace(/\D/g, "");
}

function chunks<T>(values: T[], size = 100): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}

async function loadHistoricalTargetPhones(
  salonId: string,
  actions: TrackableAction[],
): Promise<Map<string, string>> {
  const db = createServiceRoleClient();
  const phoneByActionId = new Map<string, string>();

  const byAgent = (agent: string) =>
    actions.filter(
      (action) =>
        action.agent === agent &&
        !cleanPhone(action.payload?.phone) &&
        action.target_id,
    );
  const winbackActions = [...byAgent("winback"), ...byAgent("rebook")];
  const firstVisitActions = byAgent("first_visit");
  const vipActions = byAgent("vip_care");

  if (winbackActions.length > 0) {
    const ids = [...new Set(winbackActions.map((action) => action.target_id!))];
    const results = await Promise.all(
      chunks(ids).map((batch) =>
        db
          .from("winback_suggestions" as never)
          .select("id, client_phone")
          .eq("salon_id" as never, salonId)
          .in("id" as never, batch),
      ),
    );
    for (const result of results) {
      if (result.error) throw new Error(result.error.message);
    }
    const data = results.flatMap((result) => result.data ?? []);
    const phones = new Map(
      ((data ?? []) as Array<{ id: string; client_phone: string }>).map(
        (row) => [row.id, cleanPhone(row.client_phone)],
      ),
    );
    for (const action of winbackActions) {
      const phone = phones.get(action.target_id!);
      if (phone) phoneByActionId.set(action.id, phone);
    }
  }

  if (firstVisitActions.length > 0) {
    const ids = [
      ...new Set(firstVisitActions.map((action) => action.target_id!)),
    ];
    const results = await Promise.all(
      chunks(ids).map((batch) =>
        db
          .from("first_visit_sequences" as never)
          .select("id, client_phone")
          .eq("salon_id" as never, salonId)
          .in("id" as never, batch),
      ),
    );
    for (const result of results) {
      if (result.error) throw new Error(result.error.message);
    }
    const data = results.flatMap((result) => result.data ?? []);
    const phones = new Map(
      ((data ?? []) as Array<{ id: string; client_phone: string }>).map(
        (row) => [row.id, cleanPhone(row.client_phone)],
      ),
    );
    for (const action of firstVisitActions) {
      const phone = phones.get(action.target_id!);
      if (phone) phoneByActionId.set(action.id, phone);
    }
  }

  if (vipActions.length > 0) {
    const ids = [...new Set(vipActions.map((action) => action.target_id!))];
    const results = await Promise.all(
      chunks(ids).map((batch) =>
        db
          .from("client_profiles" as never)
          .select("id, phone")
          .in("id" as never, batch),
      ),
    );
    for (const result of results) {
      if (result.error) throw new Error(result.error.message);
    }
    const data = results.flatMap((result) => result.data ?? []);
    const phones = new Map(
      ((data ?? []) as Array<{ id: string; phone: string }>).map((row) => [
        row.id,
        cleanPhone(row.phone),
      ]),
    );
    for (const action of vipActions) {
      const phone = phones.get(action.target_id!);
      if (phone) phoneByActionId.set(action.id, phone);
    }
  }

  return phoneByActionId;
}

/**
 * Resolve an action's historical phone to the salon's current canonical
 * profile. Identity review intentionally keeps the old phone in action logs,
 * so conversion measurement must follow the active alias rather than split the
 * same person into two outcomes.
 */
async function loadCanonicalProfilesByPhone(
  salonId: string,
  phones: string[],
): Promise<Map<string, string>> {
  const db = createServiceRoleClient();
  const normalized = [
    ...new Set(phones.map(phoneIdentity).filter((phone) => phone.length > 0)),
  ];
  const lookupPhones = [
    ...new Set(
      phones
        .map(cleanPhone)
        .filter((phone) => phone.length > 0)
        .concat(normalized),
    ),
  ];
  const profileByPhone = new Map<string, string>();
  if (normalized.length === 0) return profileByPhone;

  const [profileResults, aliasResults] = await Promise.all([
    Promise.all(
      chunks(lookupPhones).map((batch) =>
        db.from("client_profiles").select("id, phone").in("phone", batch),
      ),
    ),
    Promise.all(
      chunks(lookupPhones).map((batch) =>
        db
          .from("salon_client_identity_aliases" as never)
          .select("alias_phone, canonical_profile_id")
          .eq("salon_id" as never, salonId)
          .eq("active" as never, true)
          .in("alias_phone" as never, batch),
      ),
    ),
  ]);

  for (const result of [...profileResults, ...aliasResults]) {
    if (result.error) throw new Error(result.error.message);
  }

  for (const row of profileResults.flatMap((result) => result.data ?? [])) {
    const key = phoneIdentity(row.phone);
    if (key) profileByPhone.set(key, String(row.id));
  }
  // An active salon alias always wins over the global profile owning that
  // phone. The global row remains intact for other salons.
  for (const row of aliasResults.flatMap(
    (result) => result.data ?? [],
  ) as Array<{
    alias_phone: string;
    canonical_profile_id: string;
  }>) {
    const key = phoneIdentity(row.alias_phone);
    if (key) profileByPhone.set(key, row.canonical_profile_id);
  }

  return profileByPhone;
}

export async function runOutcomeTracker(salonId: string): Promise<void> {
  const db = createServiceRoleClient();

  // Actions sent 7–60 days ago with no outcome yet
  const cutoffOld = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const cutoffNew = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const { data: actions, error: actionsError } = await db
    .from("ai_actions_log" as never)
    .select("id, agent, action_type, target_id, created_at, payload")
    .eq("salon_id", salonId)
    .in("agent", TRACKABLE_AGENTS)
    // A row = a message that actually went out. No agent ever writes the literal
    // "sent"; each logs a real send type (sent_sms/sent_email, warmth_sent,
    // step{N}_sent, birthday, milestone_{N}, vip_inactive). The only non-send
    // marker across the trackable agents is skipped_no_channel, so exclude that
    // instead of matching a type that never exists (which resolved zero rows and
    // silently kept conversion at 0 forever).
    .neq("action_type", "skipped_no_channel")
    .is("outcome", null)
    .gte("created_at", cutoffOld)
    .lte("created_at", cutoffNew);

  if (actionsError) throw new Error(actionsError.message);

  if (!actions?.length) return;

  // Last-touch attribution: process the newest outreach first so one booking
  // cannot be credited to every earlier message in the same nurture sequence.
  const typedActions = sortLatestActionFirst(actions as TrackableAction[]);
  const historicalPhones = await loadHistoricalTargetPhones(
    salonId,
    typedActions,
  );
  const targetPhoneByActionId = new Map(
    typedActions.map((action) => [
      action.id,
      cleanPhone(action.payload?.phone) ||
        historicalPhones.get(action.id) ||
        "",
    ]),
  );
  const canonicalProfiles = await loadCanonicalProfilesByPhone(salonId, [
    ...targetPhoneByActionId.values(),
  ]);
  const now = new Date();

  const { data: priorAttributions, error: priorAttributionsError } = await db
    .from("ai_actions_log" as never)
    .select("outcome_booking_id")
    .eq("salon_id", salonId)
    .in("agent", TRACKABLE_AGENTS)
    .eq("outcome", "converted")
    .not("outcome_booking_id", "is", null)
    .gte("created_at", cutoffOld);
  if (priorAttributionsError) throw new Error(priorAttributionsError.message);
  const attributedBookingIds = new Set(
    ((priorAttributions ?? []) as Array<{ outcome_booking_id: string | null }>)
      .map((row) => row.outcome_booking_id)
      .filter((id): id is string => Boolean(id)),
  );
  const nextNewerTouchByIdentity = new Map<string, string>();

  for (const row of typedActions) {
    const phone = targetPhoneByActionId.get(row.id) ?? "";
    if (!phone) {
      const deadline =
        new Date(row.created_at).getTime() +
        (OUTCOME_WINDOW_DAYS[row.agent] ?? 21) * 86_400_000;
      if (now.getTime() >= deadline) {
        const { data: existingGap, error: gapReadError } = await db
          .from("ai_actions_log" as never)
          .select("id")
          .eq("salon_id", salonId)
          .eq("agent", "outcome_tracker")
          .eq("action_type", "identity_unavailable")
          .eq("target_id", row.id)
          .limit(1)
          .maybeSingle();
        if (gapReadError) throw new Error(gapReadError.message);
        if (!existingGap) {
          const { error: gapWriteError } = await db
            .from("ai_actions_log" as never)
            .insert({
              salon_id: salonId,
              agent: "outcome_tracker",
              action_type: "identity_unavailable",
              target_id: row.id,
              payload: {
                source_agent: row.agent,
                source_action_type: row.action_type,
                source_created_at: row.created_at,
                reason: "historical_identity_missing",
              },
              undo_deadline: null,
            } as never);
          if (gapWriteError) throw new Error(gapWriteError.message);
        }
      }
      continue;
    }

    const sentAt = new Date(row.created_at);
    const identity = phoneIdentity(phone);
    const canonicalProfileId = canonicalProfiles.get(identity);
    const deadline = outcomeDeadline(row.agent, row.created_at);
    const nextNewerTouch = nextNewerTouchByIdentity.get(identity) ?? null;
    const queryUpperBound =
      nextNewerTouch && new Date(nextNewerTouch) < deadline
        ? { value: nextNewerTouch, inclusive: false }
        : { value: deadline.toISOString(), inclusive: true };
    const bookingQueries = [];
    if (canonicalProfileId) {
      let profileQuery = db
          .from("bookings")
          .select("id, created_at")
          .eq("salon_id", salonId)
          .eq("client_profile_id", canonicalProfileId)
          .gte("created_at", sentAt.toISOString())
          .not("status", "in", '("cancelled","cancelled_before_window","no_show")')
          .order("created_at", { ascending: true })
          .limit(20);
      profileQuery = queryUpperBound.inclusive
        ? profileQuery.lte("created_at", queryUpperBound.value)
        : profileQuery.lt("created_at", queryUpperBound.value);
      bookingQueries.push(profileQuery);
    }
    const lookupPhones = [...new Set([phone, phoneIdentity(phone)].filter(Boolean))];
    let phoneQuery = db
        .from("bookings")
        .select("id, created_at")
        .eq("salon_id", salonId)
        .in("client_phone", lookupPhones)
        .gte("created_at", sentAt.toISOString())
        .not("status", "in", '("cancelled","cancelled_before_window","no_show")')
        .order("created_at", { ascending: true })
        .limit(20);
    phoneQuery = queryUpperBound.inclusive
      ? phoneQuery.lte("created_at", queryUpperBound.value)
      : phoneQuery.lt("created_at", queryUpperBound.value);
    bookingQueries.push(phoneQuery);
    const bookingResults = await Promise.all(bookingQueries);
    for (const result of bookingResults) {
      if (result.error) throw new Error(result.error.message);
    }
    const booking = bookingResults
      .flatMap((result) => result.data ?? [])
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .find((candidate) => !attributedBookingIds.has(candidate.id)) ?? null;
    const bookingId = booking?.id ?? null;
    const resolution = decideOutcomeResolution({
      agent: row.agent,
      sentAt: row.created_at,
      candidateBookingId: bookingId,
      bookingAlreadyAttributed: Boolean(
        bookingId && attributedBookingIds.has(bookingId),
      ),
      now,
    });

    if (resolution === "converted" && bookingId) {
      const { error: updateError } = await db
        .from("ai_actions_log" as never)
        .update({
          outcome: "converted",
          outcome_at: now.toISOString(),
          outcome_booking_id: bookingId,
        } as never)
        .eq("id", row.id);
      if (updateError) throw new Error(updateError.message);
      attributedBookingIds.add(bookingId);
    } else if (resolution === "no_conversion") {
      const { error: updateError } = await db
        .from("ai_actions_log" as never)
        .update({
          outcome: "no_conversion",
          outcome_at: now.toISOString(),
        } as never)
        .eq("id", row.id);
      if (updateError) throw new Error(updateError.message);
    }
    nextNewerTouchByIdentity.set(identity, row.created_at);
    // else: window not yet expired — leave NULL, check again tomorrow
  }
}

/** Aggregated conversion stats for the last 30 days — used in digest context. */
export type OutcomeStats = {
  agent: string;
  label: string;
  sent: number;
  converted: number;
  pct: number;
};

const AGENT_LABELS: Record<string, string> = {
  winback: "Kéo Về",
  rebook: "Nhịp Tim",
  first_visit: "Lần đầu",
  vip_care: "VIP Care",
};

export async function getOutcomeStats(
  salonId: string,
): Promise<OutcomeStats[]> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const { data, error } = await db
    .from("ai_actions_log" as never)
    .select("agent, outcome")
    .eq("salon_id", salonId)
    .in("agent", TRACKABLE_AGENTS)
    // See runOutcomeTracker: real send types vary; only skipped_no_channel is a
    // non-send, so exclude that rather than an "action_type = sent" that matches
    // nothing.
    .neq("action_type", "skipped_no_channel")
    .not("outcome", "is", null)
    .gte("outcome_at", since);

  if (error) throw new Error(error.message);

  const map = new Map<string, { sent: number; converted: number }>();
  for (const r of (data ?? []) as { agent: string; outcome: string }[]) {
    if (!map.has(r.agent)) map.set(r.agent, { sent: 0, converted: 0 });
    const s = map.get(r.agent)!;
    s.sent++;
    if (r.outcome === "converted") s.converted++;
  }

  return Array.from(map.entries()).map(([agent, s]) => ({
    agent,
    label: AGENT_LABELS[agent] ?? agent,
    sent: s.sent,
    converted: s.converted,
    pct: s.sent > 0 ? Math.round((s.converted / s.sent) * 100) : 0,
  }));
}
