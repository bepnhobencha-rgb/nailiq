"use server";

import * as Sentry from "@sentry/nextjs";
import type { EditBookingInput, EditBookingResult } from "@/shared/dashboard/editBookingCore";
import { editBooking } from "@/shared/dashboard/receptionistActions";

/** Next.js server action entry for desk edit (thin wrapper over `editBooking`).
 * Wrapped in a Sentry span so the desk-edit critical path shows up in
 * Performance and so its child queries inherit the trace context. */
export async function editBookingAction(
  slug: string,
  input: EditBookingInput,
): Promise<EditBookingResult> {
  return Sentry.startSpan(
    {
      name: "editBookingAction",
      op: "server_action",
      attributes: {
        "nailiq.slug": slug,
        "nailiq.bookingId": input.bookingId,
      },
    },
    () => editBooking(slug, input),
  );
}
