import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

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

const WINDOW_DAYS: Record<string, number> = {
  winback: 21,
  rebook: 14,
  first_visit: 28,
  vip_care: 30,
};

const TRACKABLE_AGENTS = Object.keys(WINDOW_DAYS);

type TrackableAction = {
  id: string;
  agent: string;
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

  const { data: actions } = await db
    .from("ai_actions_log" as never)
    .select("id, agent, target_id, created_at, payload")
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

  if (!actions?.length) return;

  const typedActions = actions as TrackableAction[];
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

  for (const row of typedActions) {
    const phone = targetPhoneByActionId.get(row.id) ?? "";
    if (!phone) continue;

    const sentAt = new Date(row.created_at);
    const windowDays = WINDOW_DAYS[row.agent] ?? 21;
    const deadline = new Date(sentAt.getTime() + windowDays * 86_400_000);

    // Check if client booked after the message was sent
    let bookingQuery = db
      .from("bookings")
      .select("id")
      .eq("salon_id", salonId)
      .gte("created_at", sentAt.toISOString())
      .not("status", "in", '("cancelled","cancelled_before_window","no_show")')
      .limit(1);
    const canonicalProfileId = canonicalProfiles.get(phoneIdentity(phone));
    bookingQuery = canonicalProfileId
      ? bookingQuery.eq("client_profile_id", canonicalProfileId)
      : bookingQuery.eq("client_phone", phone);
    const { data: booking } = await bookingQuery.maybeSingle();

    if (booking) {
      await db
        .from("ai_actions_log" as never)
        .update({
          outcome: "converted",
          outcome_at: now.toISOString(),
          outcome_booking_id: (booking as { id: string }).id,
        } as never)
        .eq("id", row.id);
    } else if (now >= deadline) {
      await db
        .from("ai_actions_log" as never)
        .update({
          outcome: "no_conversion",
          outcome_at: now.toISOString(),
        } as never)
        .eq("id", row.id);
    }
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

  const { data } = await db
    .from("ai_actions_log" as never)
    .select("agent, outcome")
    .eq("salon_id", salonId)
    .in("agent", TRACKABLE_AGENTS)
    // See runOutcomeTracker: real send types vary; only skipped_no_channel is a
    // non-send, so exclude that rather than an "action_type = sent" that matches
    // nothing.
    .neq("action_type", "skipped_no_channel")
    .not("outcome", "is", null)
    .gte("created_at", since);

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
