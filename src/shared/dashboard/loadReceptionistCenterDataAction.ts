"use server";

import {
  loadReceptionistCenterData,
  type LoadReceptionistCenterResult,
} from "@/shared/dashboard/loadReceptionistCenterData";

/**
 * Next.js server action wrapper for Receptionist Center data (session + RLS via `getDashboardWriteClient`).
 */
export async function loadReceptionistCenterDataAction(
  slug: string,
  dateYmd: string,
): Promise<LoadReceptionistCenterResult> {
  return loadReceptionistCenterData(slug, dateYmd);
}
