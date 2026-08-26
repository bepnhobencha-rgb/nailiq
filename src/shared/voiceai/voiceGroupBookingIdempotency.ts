import "server-only";

import { stableBookingIdempotencyKey } from "@/shared/booking/stableBookingIdempotencyKey";

export function parseVoiceGroupMode(
  value: unknown,
): "sync_start" | "sync_finish" | null {
  if (value == null) return "sync_start";
  return value === "sync_start" || value === "sync_finish" ? value : null;
}

export function voiceGroupBookingLogicalIdempotencyKey(input: {
  sessionId: string | null;
  salonId: string;
  serviceAssignments: ReadonlyArray<{ serviceId: string; count: number }>;
  date: string;
  time: string;
  mode: string;
  organizerName: string;
  organizerPhone: string;
}): string {
  const counts = new Map<string, number>();
  for (const entry of input.serviceAssignments) {
    const serviceId = entry.serviceId.trim().toLowerCase();
    counts.set(serviceId, (counts.get(serviceId) ?? 0) + entry.count);
  }
  return stableBookingIdempotencyKey({
    channel: "voice_group",
    sessionId: input.sessionId,
    salonId: input.salonId,
    serviceAssignments: [...counts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([serviceId, count]) => ({ serviceId, count })),
    date: input.date,
    time: input.time,
    mode: input.mode,
    organizerName: input.organizerName
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLocaleLowerCase("en-US"),
    organizerPhone: input.organizerPhone,
  });
}
