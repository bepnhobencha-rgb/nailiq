/**
 * Shared types for the Wix self-service admin flow.
 * Kept out of the "use server" action module (which may only export async functions).
 */
export interface WixStatus {
  connected: boolean; // has both site_id and a key
  siteId: string | null;
  enabled: boolean;
  autoApprove: boolean;
  hasApiKey: boolean;
  hasWebhookKey: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  webhookLastReceivedAt: string | null;
  mappedServices: number; // services with a wix_service_id
  totalServices: number;
  mappedStaff: number; // staff with a wix_resource_id
  totalStaff: number;
  syncedBookings: number; // bookings carrying a wix_booking_id
}
