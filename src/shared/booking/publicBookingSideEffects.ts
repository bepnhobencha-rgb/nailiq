"use server";

import { after } from "next/server";
import {
  evaluateBookingNoShow,
  type EvaluateBookingNoShowInput,
} from "@/shared/noshow/evaluateBookingNoShow";
import { sendBookingConfirmationEmail } from "@/shared/booking/sendBookingConfirmationEmail";

type EmailInput = Parameters<typeof sendBookingConfirmationEmail>[0];

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
}): Promise<void> {
  after(async () => {
    const jobs: Promise<unknown>[] = [];
    if (args.risk) jobs.push(evaluateBookingNoShow(args.risk));
    if (args.email) {
      jobs.push(
        sendBookingConfirmationEmail(args.email).catch((e) =>
          console.error("[publicBookingSideEffects] email threw", e),
        ),
      );
    }
    await Promise.allSettled(jobs);
  });
}
