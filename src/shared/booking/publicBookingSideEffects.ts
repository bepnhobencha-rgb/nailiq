"use server";

import { after } from "next/server";
import {
  evaluateBookingNoShow,
  type EvaluateBookingNoShowInput,
} from "@/shared/noshow/evaluateBookingNoShow";
import { sendOnlineSaveCardLink } from "@/shared/booking/sendOnlineSaveCardLink";
import { sendBookingConfirmationEmail } from "@/shared/booking/sendBookingConfirmationEmail";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type EmailInput = Parameters<typeof sendBookingConfirmationEmail>[0];

/** Post-creation booking field stamps that must run server-side: the browser
 *  anon client has the UPDATE grant but no RLS UPDATE policy, so a client-side
 *  `.update()` on the booking row silently affects 0 rows (no error). That left
 *  EVERY online booking with booking_channel=null (reports) and the customer's
 *  staff-requested ❤️ flag unset. Service role bypasses RLS. */
type StampInput = {
  bookingId: string;
  bookingChannel?: string;
  clientLocale?: string;
  staffRequested?: boolean;
  /** How this booking was verified ('otp' | 'deposit' | 'none' | …). Recorded so
   *  the front desk sees a verified badge + the release-pending cron can tell.
   *  Was also a silent anon-UPDATE no-op when done client-side. */
  verificationMethod?: string;
  /** OTP session that verified it (audit trail). */
  otpSessionId?: string | null;
  /** Customer ticked the mandatory health acknowledgment → stamp health_ack_at. */
  healthAck?: boolean;
  /** Pre-tax subtotal and tax amount — stamped server-side since anon UPDATE
   *  on bookings is blocked by RLS. */
  subtotalCents?: number;
  taxAmountCents?: number;
};

/**
 * Run a public booking's post-commit side-effects SERVER-SIDE.
 *
 * Why a server action: submitPublicBooking runs in the browser (it uses the
 * anon Supabase client for RLS-scoped inserts). The old code fire-and-forgot
 * fetches to internal routes with `process.env.INTERNAL_API_SECRET` — which is
 * undefined in the browser — so noshow-evaluate returned 401 and booking-email
 * returned 403 on EVERY online booking: no risk score was ever persisted and no
 * confirmation email was ever sent. A server action has the secret/server env,
 * so it can run these directly with no HTTP hop.
 *
 * Uses after() so the user isn't blocked on the AI risk call or Resend; the
 * Vercel function stays alive until they finish.
 */
export async function runPublicBookingSideEffects(args: {
  risk?: EvaluateBookingNoShowInput;
  email?: EmailInput;
  stamp?: StampInput;
}): Promise<void> {
  after(async () => {
    const jobs: Promise<unknown>[] = [];
    if (args.risk) {
      const bookingId = args.risk.bookingId;
      // Sequential: evaluate (which may set noshow_card_required, incl. via the
      // live AI policy agent), THEN auto-send the save-card link if the customer
      // needs one but never captured a card inline (they've usually left the
      // page by the time the requirement is decided). sendOnline… self-gates.
      jobs.push(
        (async () => {
          await evaluateBookingNoShow(args.risk!);
          await sendOnlineSaveCardLink(bookingId);
        })(),
      );
    }
    if (args.email) {
      jobs.push(
        sendBookingConfirmationEmail(args.email).catch((e) =>
          console.error("[publicBookingSideEffects] email threw", e),
        ),
      );
    }
    if (args.stamp?.bookingId) {
      const s = args.stamp;
      const upd: Record<string, unknown> = {};
      if (s.bookingChannel) upd.booking_channel = s.bookingChannel;
      if (s.clientLocale) upd.client_locale = s.clientLocale;
      if (s.staffRequested) upd.staff_requested_by_client = true;
      if (s.verificationMethod) {
        upd.verification_method = s.verificationMethod;
        upd.verification_completed_at = new Date().toISOString();
        if (s.otpSessionId) upd.otp_session_id = s.otpSessionId;
      }
      if (s.healthAck) upd.health_ack_at = new Date().toISOString();
      if (s.subtotalCents != null) upd.subtotal_cents = s.subtotalCents;
      if (s.taxAmountCents != null && s.taxAmountCents > 0) upd.tax_amount_cents = s.taxAmountCents;
      if (Object.keys(upd).length > 0) {
        jobs.push(
          (async () => {
            const { error } = await createServiceRoleClient()
              .from("bookings" as never)
              .update(upd as never)
              .eq("id", s.bookingId);
            if (error) console.error("[publicBookingSideEffects] stamp", error);
          })(),
        );
      }
    }
    await Promise.allSettled(jobs);
  });
}
