import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type NailTryOnEventName =
  | "upload_received" | "quality_passed" | "quality_rejected"
  | "catalog_viewed" | "generation_started" | "generation_ready"
  | "generation_failed" | "booking_attached" | "expired_deleted";

export async function recordNailTryOnEvent(args: {
  salonId: string;
  sessionId?: string | null;
  event: NailTryOnEventName;
  properties?: Record<string, string | number | boolean | null>;
}) {
  const safeProperties = Object.fromEntries(
    Object.entries(args.properties || {}).filter(([key]) =>
      !/(image|url|token|phone|email|name)/i.test(key),
    ),
  );
  const { error } = await createServiceRoleClient().from("nail_tryon_events" as never).insert({
    salon_id: args.salonId,
    tryon_session_id: args.sessionId || null,
    event_name: args.event,
    properties: safeProperties,
  } as never);
  if (error) console.error("[nail-tryon] telemetry insert failed", error.code);
}
