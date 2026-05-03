"use server";

import type { EditBookingInput, EditBookingResult } from "@/shared/dashboard/editBookingCore";
import { editBooking } from "@/shared/dashboard/receptionistActions";

/** Next.js server action entry for desk edit (thin wrapper over `editBooking`). */
export async function editBookingAction(
  slug: string,
  input: EditBookingInput,
): Promise<EditBookingResult> {
  return editBooking(slug, input);
}
