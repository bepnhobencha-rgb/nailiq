import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import Link from "next/link";

type Props = { searchParams: Promise<{ token?: string }> };

/** Row shape returned by the updated `claim_waitlist_slot` RPC. When the salon
 * has `feature_flags.waitlist_auto_book = true` AND the entry carried a concrete
 * offered slot, the RPC auto-creates the real booking and returns
 * `auto_booked = true` with the booking details; otherwise `auto_booked = false`
 * (manual follow-up). Zero rows = token invalid / slot already taken. */
type ClaimRow = {
  id: string;
  client_name: string;
  client_phone: string | null;
  client_email: string | null;
  auto_booked: boolean;
  booking_id: string | null;
  booked_start_utc: string | null;
  staff_name: string | null;
  service_name: string | null;
};

export default async function WaitlistClaimPage({ searchParams }: Props) {
  const { token } = await searchParams;

  if (!token) {
    return <Shell><Result ok={false} message="This claim link is invalid." /></Shell>;
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("claim_waitlist_slot" as never, {
    p_claim_token: token,
  });

  if (error) {
    console.error("[waitlist-claim] RPC error", error);
    return <Shell><Result ok={false} message="Something went wrong. Please contact the salon." /></Shell>;
  }

  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as ClaimRow | undefined;

  if (!row) {
    return (
      <Shell>
        <Result
          ok={false}
          message="This slot has already been claimed by another customer. We're sorry — first to claim wins!"
        />
      </Shell>
    );
  }

  // Auto-booked: the slot is already a real appointment. Show a confirmation
  // with service / staff / formatted date+time. Format the UTC start in the
  // salon's own timezone (one extra read off the freed booking) so the time
  // never drifts to the viewer's device tz.
  if (row.auto_booked === true) {
    const when = await formatBookedTime(supabase, row.booking_id, row.booked_start_utc);
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-nq-success/30 bg-nq-success/10">
            <svg className="h-8 w-8 text-nq-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-white">✅ You&apos;re booked!</h1>
          <p className="mt-3 text-sm text-nq-muted">
            Your appointment is confirmed
            {row.service_name ? <> — <span className="text-white">{row.service_name}</span></> : null}
            {row.staff_name ? <> with <span className="text-white">{row.staff_name}</span></> : null}
            {when ? <> on <span className="text-white">{when}</span></> : null}
            . See you then!
          </p>
          <p className="mt-6 text-sm text-nq-muted">You can close this page.</p>
        </div>
      </Shell>
    );
  }

  // Manual follow-up (flag off / no concrete slot) — existing behavior.
  return (
    <Shell>
      <div className="text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-nq-primary/30 bg-nq-primary/10">
          <svg className="h-8 w-8 text-nq-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-white">Spot Claimed!</h1>
        <p className="mt-3 text-sm text-nq-muted">
          Great news, {row.client_name}! Your spot has been reserved. The salon will follow up to confirm your appointment details.
        </p>
        <p className="mt-6 text-sm text-nq-muted">You can close this page.</p>
      </div>
    </Shell>
  );
}

/**
 * Format an auto-booked appointment's UTC start in the SALON timezone. The page
 * only has the claim token, so we resolve the salon tz off the freshly-created
 * booking (`bookings → salons.timezone`). Falls back to a UTC-labelled format if
 * the lookup fails or the tz is missing, so we never crash the success page.
 */
async function formatBookedTime(
  supabase: ReturnType<typeof createServiceRoleClient>,
  bookingId: string | null,
  bookedStartUtc: string | null,
): Promise<string | null> {
  if (!bookedStartUtc) return null;
  const startMs = Date.parse(bookedStartUtc);
  if (!Number.isFinite(startMs)) return null;

  let timeZone = "UTC";
  if (bookingId) {
    try {
      // Two plain selects (booking → salon_id → salons.timezone) instead of an
      // embedded relationship, since the bookings↔salons FK relationship name
      // isn't in the generated types and PostgREST would reject the embed.
      const { data: bk } = await supabase
        .from("bookings")
        .select("salon_id")
        .eq("id", bookingId)
        .maybeSingle();
      const salonId = (bk as { salon_id?: string | null } | null)?.salon_id;
      if (salonId) {
        const { data: sl } = await supabase
          .from("salons")
          .select("timezone")
          .eq("id", salonId)
          .maybeSingle();
        const tz = (sl as { timezone?: string | null } | null)?.timezone;
        if (typeof tz === "string" && tz.trim()) timeZone = tz.trim();
      }
    } catch (e) {
      console.error("[waitlist-claim] salon tz lookup", e);
    }
  }

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(startMs));
  } catch {
    // Bad/unknown tz string → fall back to UTC so the page still renders.
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(startMs));
  }
}

function Result({ ok, message }: { ok: boolean; message: string }) {
  void ok;
  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold text-white">
        {ok ? "Done!" : "Slot Unavailable"}
      </h1>
      <p className="mt-3 text-sm text-nq-muted">{message}</p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-nq-bg px-4">
      <div className="w-full max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface p-8">
        {children}
        <p className="mt-8 text-center text-xs text-nq-muted/50">
          Powered by{" "}
          <Link href="https://nailiq.ca" className="underline">
            NailIQ
          </Link>
        </p>
      </div>
    </div>
  );
}
