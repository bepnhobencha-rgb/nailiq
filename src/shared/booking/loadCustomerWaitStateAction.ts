"use server";

import {
  type CustomerWaitState,
  loadCustomerWaitState,
} from "@/shared/booking/loadCustomerWaitState";

/**
 * Server action wrapper around `loadCustomerWaitState` so the client
 * component can re-fetch on realtime ticks / polling without exposing
 * the service-role client or any DB credentials.
 */
export async function refreshCustomerWaitState(
  slug: string,
  bookingId: string,
): Promise<CustomerWaitState> {
  return loadCustomerWaitState(slug, bookingId);
}
