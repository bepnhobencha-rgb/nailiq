/**
 * Manual smoke — `loadReceptionistCenterData.ts` queries + mapping via service role.
 * Injects `deps.resolveWrite` so Node/tsx skips Next cookies (same rationale as receptionistActions.smoke).
 *
 * Paste `HARDCODED_DEV_SALON_ID` OR set `.env.local`: `NAILIQ_SMOKE_SALON_ID`, `NAILIQ_SMOKE_SLUG`.
 *
 * Run: `npx tsx src/shared/dashboard/__tests__/loadReceptionistCenterData.smoke.ts`
 */
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

import { createServiceRoleClient } from "../../lib/supabase/serviceRole";
import { salonToday } from "../../lib/salonTime";
import { loadReceptionistCenterData } from "../loadReceptionistCenterData";
import { parseStaffNotificationSettings } from "../staffNotificationSettings";

/** Dev tenant UUID — optional if slug/env resolution finds a salon. */
const HARDCODED_DEV_SALON_ID = "";

const RESOLVE_SLUG = process.env.NAILIQ_SMOKE_SLUG?.trim() || "nailiq-demo-slug";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

type SalonMeta = { id: string; slug: string; timezone: string };

function toSalonMeta(
  raw: {
    id: string;
    slug: unknown;
    timezone: unknown;
  } | null,
): SalonMeta | null {
  if (!raw?.id) return null;
  const slug =
    typeof raw.slug === "string" && raw.slug.trim() !== ""
      ? raw.slug.trim()
      : null;
  const timezone =
    typeof raw.timezone === "string" && raw.timezone.trim() !== ""
      ? raw.timezone.trim()
      : null;
  if (!slug || !timezone) return null;
  return { id: String(raw.id), slug, timezone };
}

async function resolveSalonMeta(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<SalonMeta> {
  const pinned =
    process.env.NAILIQ_SMOKE_SALON_ID?.trim() || HARDCODED_DEV_SALON_ID.trim();

  let row: SalonMeta | null = null;

  if (pinned && UUID_RE.test(pinned)) {
    const { data, error } = await supabase
      .from("salons")
      .select("id, slug, timezone")
      .eq("id", pinned)
      .maybeSingle();

    assert(
      !error,
      `[smoke] salon by id failed: ${error?.message}`,
    );

    row = toSalonMeta(data as { id: string; slug: unknown; timezone: unknown } | null);
  }

  if (!row) {
    const { data, error } = await supabase
      .from("salons")
      .select("id, slug, timezone")
      .eq("slug", RESOLVE_SLUG)
      .maybeSingle();

    assert(
      !error,
      `[smoke] salon by slug failed: ${error?.message}`,
    );
    row = toSalonMeta(data as { id: string; slug: unknown; timezone: unknown } | null);
  }

  if (!row) {
    const { data: earliest, error: anyErr } = await supabase
      .from("salons")
      .select("id, slug, timezone")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    console.warn(
      `[smoke] slug '${RESOLVE_SLUG}' not found — using earliest salon row. Pin with NAILIQ_SMOKE_SALON_ID or HARDCODED_DEV_SALON_ID.`,
    );
    row = anyErr ? null : toSalonMeta(earliest as { id: string; slug: unknown; timezone: unknown } | null);

    assert(row, `resolve salon: ${anyErr?.message ?? "no salons in DB"}`);
  }

  return row;
}

function writeCtxDeps(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  slugMustMatch: string,
) {
  return async (slug: string) => {
    if (slug !== slugMustMatch) return null;
    return {
      salon: { id: salonId },
      kind: "demo_cookie" as const,
      supabase,
    };
  };
}

let pass = 0;
let failed = 0;

async function smoke(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(e);
  }
}

async function main() {
  assert(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
    "Missing NEXT_PUBLIC_SUPABASE_URL (.env.local)",
  );
  assert(
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
    "Missing SUPABASE_SERVICE_ROLE_KEY (.env.local)",
  );

  const supabase = createServiceRoleClient();
  const salon = await resolveSalonMeta(supabase);
  const deps = writeCtxDeps(supabase, salon.id, salon.slug);

  const today = salonToday(salon.timezone);

  await smoke("1. Load dev salon — today succeeds, staff/services arrays exist", async () => {
    const r = await loadReceptionistCenterData(salon.slug, today, { resolveWrite: deps });
    assert(r.ok === true, JSON.stringify(r));
    const d = r.data;
    assert(Array.isArray(d.staff), "staff must be array");
    assert(Array.isArray(d.services), "services must be array");
    assert(d.services.length >= 1, "expected ≥1 service for useful dev tenant");
    assert(d.staff.length >= 1, "expected ≥1 staff row for useful dev tenant");
  });

  await smoke("2. Invalid date format → invalid_date", async () => {
    const r = await loadReceptionistCenterData("any-slug", "2026/05/02");
    assert(!r.ok && r.error === "invalid_date", JSON.stringify(r));
  });

  await smoke("3. No dashboard ctx (nonexistent slug resolver) → unauthorized", async () => {
    const r = await loadReceptionistCenterData(salon.slug, today, {
      resolveWrite: async () => null,
    });
    assert(!r.ok && r.error === "unauthorized", JSON.stringify(r));
  });

  await smoke(
    "4. bookingsForDay excludes waiting/cancelled",
    async () => {
      const res = await loadReceptionistCenterData(salon.slug, today, { resolveWrite: deps });
      assert(res.ok, JSON.stringify(res));
      for (const b of res.data.bookingsForDay) {
        assert(
          b.status !== "waiting" && b.status !== "cancelled",
          `illegal status row ${b.id}: ${b.status}`,
        );
      }
    },
  );

  await smoke("5. walkinQueue matches DB walk-in+waiting FIFO", async () => {
    const res = await loadReceptionistCenterData(salon.slug, today, { resolveWrite: deps });
    assert(res.ok, JSON.stringify(res));

    const { data: canon, error } = await supabase
      .from("bookings")
      .select("id")
      .eq("salon_id", salon.id)
      .eq("source", "walkin")
      .eq("status", "waiting")
      .order("joined_queue_at", { ascending: true })
      .not("joined_queue_at", "is", null);

    assert(!error && canon, `[smoke] canonical queue fetch: ${error?.message}`);

    const loaderIds =
      res.ok ? res.data.walkinQueue.filter((x) => x.joined_queue_at?.trim()).map((x) => x.id) : [];
    const canonicalIds =
      canon?.map((row) => String(row.id)).filter(Boolean) ?? [];

    assert(
      JSON.stringify(loaderIds) === JSON.stringify(canonicalIds),
      `queue mismatch: loader=${loaderIds.join(",")} canon=${canonicalIds.join(",")}`,
    );

    if (res.ok) {
      for (const row of res.data.walkinQueue) {
        assert(row.joined_queue_at?.trim(), "joined_queue_at missing on queue row");

        const { data: bk, error: be } = await supabase
          .from("bookings")
          .select("source, status")
          .eq("id", row.id)
          .maybeSingle();

        assert(!be && bk, `booking ${row.id}: ${be?.message}`);
        assert(
          bk?.source === "walkin" && bk?.status === "waiting",
          `booking ${row.id}: source/status ${bk?.source} ${bk?.status}`,
        );
      }
    }
  });

  await smoke("6. pre-fetched salon preserves receptionist config parity", async () => {
    const { data, error } = await supabase
      .from("salons")
      .select(
        "id, name, slug, timezone, dashboard_modules, dashboard_preset, dashboard_density, currency_code, walkin_auto_assign, queue_display_mode, basic_mode_forced, opening_hours, staff_notification_settings, default_notification_locale, auto_no_show_minutes" as never,
      )
      .eq("id", salon.id)
      .maybeSingle();

    assert(!error && data, `[smoke] prefetch salon config: ${error?.message}`);
    const prefetched = data as unknown as {
      id: string;
      name: string;
      slug: string;
      timezone: string;
      dashboard_modules: unknown;
      dashboard_preset: unknown;
      dashboard_density: unknown;
      currency_code: unknown;
      walkin_auto_assign: unknown;
      queue_display_mode: unknown;
      basic_mode_forced: unknown;
      opening_hours: unknown;
      staff_notification_settings: unknown;
      default_notification_locale: unknown;
      auto_no_show_minutes: unknown;
    };
    const res = await loadReceptionistCenterData(salon.slug, today, {
      resolveWrite: deps,
      preFetchedSalon: prefetched,
    });

    assert(res.ok, JSON.stringify(res));
    assert(
      res.data.salon.walkinAutoAssign ===
        (prefetched.walkin_auto_assign === false ? false : true),
      "walkin_auto_assign parity mismatch",
    );
    assert(
      res.data.salon.queueDisplayMode ===
        (prefetched.queue_display_mode === "simple" ? "simple" : "full"),
      "queue_display_mode parity mismatch",
    );
    assert(
      JSON.stringify(res.data.salon.staffNotificationSettings) ===
        JSON.stringify(
          parseStaffNotificationSettings(
            prefetched.staff_notification_settings,
            prefetched.default_notification_locale === "vi" ? "vi" : "en",
          ),
        ),
      "staff_notification_settings parity mismatch",
    );
    const rawAutoNoShow = prefetched.auto_no_show_minutes;
    const numericAutoNoShow =
      rawAutoNoShow == null ? null : Math.round(Number(rawAutoNoShow));
    const expectedAutoNoShow =
      numericAutoNoShow !== null &&
      Number.isFinite(numericAutoNoShow) &&
      numericAutoNoShow > 0
        ? numericAutoNoShow
        : null;
    assert(
      res.data.salon.autoNoShowMinutes === expectedAutoNoShow,
      "auto_no_show_minutes parity mismatch",
    );
  });

  console.log(`${pass} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
