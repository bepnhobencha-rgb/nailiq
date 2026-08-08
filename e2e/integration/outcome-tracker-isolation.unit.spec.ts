import { randomUUID } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

// `server-only` is a Next.js boundary marker. This suite deliberately invokes
// the server module in Node against a throwaway Supabase database.
vi.mock("server-only", () => ({}));

const runIntegration =
  process.env.RUN_OUTCOME_TRACKER_INTEGRATION === "1";

const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

describe.runIf(runIntegration)("Outcome Tracker tenant isolation", () => {
  test("attributes only the requested QA salon and creates no outbound work", async () => {
    const { assertNotProductionFromEnv } = await import(
      "../helpers/guardProduction"
    );
    assertNotProductionFromEnv();

    const [{ createClient }, { cleanupTestSalon, seedTestSalon }] =
      await Promise.all([
        import("@supabase/supabase-js"),
        import("../helpers/db"),
      ]);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("Local Supabase URL and service-role key are required");
    }

    const db = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const qaSlug = "e2e-outcome-isolation-qa";
    const controlSlug = "e2e-outcome-isolation-control";

    await Promise.all([
      cleanupTestSalon(qaSlug),
      cleanupTestSalon(controlSlug),
    ]);

    try {
      const [qaSalon, controlSalon] = await Promise.all([
        seedTestSalon({
          slug: qaSlug,
          name: "E2E Outcome Isolation QA",
          phone: "+15555550201",
        }),
        seedTestSalon({
          slug: controlSlug,
          name: "E2E Outcome Isolation Control",
          phone: "+15555550202",
        }),
      ]);

      const getServiceId = async (salonId: string) => {
        const { data, error } = await db
          .from("services")
          .select("id")
          .eq("salon_id", salonId)
          .limit(1)
          .single();
        if (error || !data) throw error ?? new Error("Missing test service");
        return data.id;
      };
      const [qaServiceId, controlServiceId] = await Promise.all([
        getServiceId(qaSalon.salonId),
        getServiceId(controlSalon.salonId),
      ]);

      const phoneConverted = "+1 555-555-2201";
      const phoneExpired = "+1 555-555-2202";
      const phoneLate = "+1 555-555-2203";
      const phoneLastTouch = "+1 555-555-2204";

      const ids = {
        convertedAction: randomUUID(),
        expiredAction: randomUUID(),
        lateAction: randomUUID(),
        olderTouchAction: randomUUID(),
        newerTouchAction: randomUUID(),
        convertedBooking: randomUUID(),
        lateBooking: randomUUID(),
        lastTouchBooking: randomUUID(),
        controlAction: randomUUID(),
        controlBooking: randomUUID(),
      };

      const { error: qaActionsError } = await db.from("ai_actions_log").insert([
        {
          id: ids.convertedAction,
          salon_id: qaSalon.salonId,
          agent: "winback",
          action_type: "sent_sms",
          payload: { phone: phoneConverted },
          created_at: daysAgo(10),
        },
        {
          id: ids.expiredAction,
          salon_id: qaSalon.salonId,
          agent: "rebook",
          action_type: "sent_sms",
          payload: { phone: phoneExpired },
          created_at: daysAgo(20),
        },
        {
          id: ids.lateAction,
          salon_id: qaSalon.salonId,
          agent: "winback",
          action_type: "sent_email",
          payload: { phone: phoneLate },
          created_at: daysAgo(30),
        },
        {
          id: ids.olderTouchAction,
          salon_id: qaSalon.salonId,
          agent: "winback",
          action_type: "sent_sms",
          payload: { phone: phoneLastTouch },
          created_at: daysAgo(10),
        },
        {
          id: ids.newerTouchAction,
          salon_id: qaSalon.salonId,
          agent: "winback",
          action_type: "sent_sms",
          payload: { phone: phoneLastTouch },
          created_at: daysAgo(8),
        },
      ]);
      if (qaActionsError) throw qaActionsError;

      const { error: controlActionError } = await db
        .from("ai_actions_log")
        .insert({
          id: ids.controlAction,
          salon_id: controlSalon.salonId,
          agent: "winback",
          action_type: "sent_sms",
          // Same identity as the QA converted action: salon_id must still win.
          payload: { phone: phoneConverted },
          created_at: daysAgo(10),
        });
      if (controlActionError) throw controlActionError;

      const bookingStart = new Date(Date.now() + DAY_MS).toISOString();
      const bookingEnd = new Date(Date.now() + DAY_MS + 45 * 60_000).toISOString();
      const { error: qaBookingsError } = await db.from("bookings").insert([
        {
          id: ids.convertedBooking,
          salon_id: qaSalon.salonId,
          service_id: qaServiceId,
          client_name: "QA Converted",
          client_phone: phoneConverted,
          start_time_utc: bookingStart,
          end_time_utc: bookingEnd,
          status: "confirmed",
          created_at: daysAgo(9),
        },
        {
          id: ids.lateBooking,
          salon_id: qaSalon.salonId,
          service_id: qaServiceId,
          client_name: "QA After Deadline",
          client_phone: phoneLate,
          start_time_utc: bookingStart,
          end_time_utc: bookingEnd,
          status: "confirmed",
          // Winback deadline was 9 days ago; this booking must not convert it.
          created_at: daysAgo(5),
        },
        {
          id: ids.lastTouchBooking,
          salon_id: qaSalon.salonId,
          service_id: qaServiceId,
          client_name: "QA Last Touch",
          client_phone: phoneLastTouch,
          start_time_utc: bookingStart,
          end_time_utc: bookingEnd,
          status: "confirmed",
          created_at: daysAgo(7),
        },
      ]);
      if (qaBookingsError) throw qaBookingsError;

      const { error: controlBookingError } = await db.from("bookings").insert({
        id: ids.controlBooking,
        salon_id: controlSalon.salonId,
        service_id: controlServiceId,
        client_name: "Control Customer",
        client_phone: phoneConverted,
        start_time_utc: bookingStart,
        end_time_utc: bookingEnd,
        status: "confirmed",
        created_at: daysAgo(9),
      });
      if (controlBookingError) throw controlBookingError;

      const snapshotSalon = async (salonId: string) => {
        const [actions, bookings] = await Promise.all([
          db
            .from("ai_actions_log")
            .select("*")
            .eq("salon_id", salonId)
            .order("id"),
          db.from("bookings").select("*").eq("salon_id", salonId).order("id"),
        ]);
        if (actions.error) throw actions.error;
        if (bookings.error) throw bookings.error;
        return { actions: actions.data, bookings: bookings.data };
      };

      const outboundTables = [
        "booking_notifications",
        "scheduled_notifications",
        "otp_send_log",
        "campaign_schedules",
        "voice_ai_sessions",
        "ai_execution_jobs",
      ] as const;
      const globalOutboundTables = [
        "email_otp_codes",
        "phone_otp_sessions",
        "otps",
      ] as const;
      const snapshotOutbound = async () => {
        const scoped = await Promise.all(
          outboundTables.flatMap((table) =>
            [qaSalon.salonId, controlSalon.salonId].map(async (salonId) => {
              const { count, error } = await db
                .from(table)
                .select("*", { count: "exact", head: true })
                .eq("salon_id", salonId);
              if (error) throw error;
              return [`${table}:${salonId}`, count ?? 0] as const;
            }),
          ),
        );
        const global = await Promise.all(
          globalOutboundTables.map(async (table) => {
            const { count, error } = await db
              .from(table)
              .select("*", { count: "exact", head: true });
            if (error) throw error;
            return [table, count ?? 0] as const;
          }),
        );
        return Object.fromEntries([...scoped, ...global]);
      };

      const controlBefore = await snapshotSalon(controlSalon.salonId);
      const outboundBefore = await snapshotOutbound();
      expect(Object.values(outboundBefore).every((count) => count === 0)).toBe(
        true,
      );

      const { runOutcomeTracker } = await import(
        "@/shared/ai/agentOutcomeTracker"
      );
      await runOutcomeTracker(qaSalon.salonId);

      const { data: resolved, error: resolvedError } = await db
        .from("ai_actions_log")
        .select("id, outcome, outcome_booking_id")
        .eq("salon_id", qaSalon.salonId)
        .in("id", [
          ids.convertedAction,
          ids.expiredAction,
          ids.lateAction,
          ids.olderTouchAction,
          ids.newerTouchAction,
        ]);
      if (resolvedError) throw resolvedError;
      const byId = new Map(resolved.map((row) => [row.id, row]));

      expect(byId.get(ids.convertedAction)).toMatchObject({
        outcome: "converted",
        outcome_booking_id: ids.convertedBooking,
      });
      expect(byId.get(ids.expiredAction)).toMatchObject({
        outcome: "no_conversion",
        outcome_booking_id: null,
      });
      expect(byId.get(ids.lateAction)).toMatchObject({
        outcome: "no_conversion",
        outcome_booking_id: null,
      });
      expect(byId.get(ids.newerTouchAction)).toMatchObject({
        outcome: "converted",
        outcome_booking_id: ids.lastTouchBooking,
      });
      expect(byId.get(ids.olderTouchAction)).toMatchObject({
        outcome: null,
        outcome_booking_id: null,
      });

      const qaAfterFirstRun = await snapshotSalon(qaSalon.salonId);
      await runOutcomeTracker(qaSalon.salonId);

      expect(await snapshotSalon(qaSalon.salonId)).toEqual(qaAfterFirstRun);
      expect(await snapshotSalon(controlSalon.salonId)).toEqual(controlBefore);
      expect(await snapshotOutbound()).toEqual(outboundBefore);
    } finally {
      await Promise.all([
        cleanupTestSalon(qaSlug),
        cleanupTestSalon(controlSlug),
      ]);
    }
  }, 30_000);
});
