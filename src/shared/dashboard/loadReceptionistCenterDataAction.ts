"use server";

import * as Sentry from "@sentry/nextjs";
import {
  loadReceptionistCenterData,
  type LoadReceptionistCenterResult,
} from "@/shared/dashboard/loadReceptionistCenterData";

/**
 * Next.js server action wrapper for Receptionist Center data (session + RLS via `getDashboardWriteClient`).
 * Wrapped in a Sentry span so the desk reload path shows up in
 * Performance with child queries (salons, staff, services, walk-ins,
 * bookings) inheriting the trace.
 */
export async function loadReceptionistCenterDataAction(
  slug: string,
  dateYmd: string,
): Promise<LoadReceptionistCenterResult> {
  return Sentry.startSpan(
    {
      name: "loadReceptionistCenterDataAction",
      op: "server_action",
      attributes: {
        "nailiq.slug": slug,
        "nailiq.dateYmd": dateYmd,
      },
    },
    () => loadReceptionistCenterData(slug, dateYmd),
  );
}
