import { buildIcs } from "@/shared/lib/calendarLinks";

export function generateBookingCalendarIcs(args: {
  title: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  eventUid: string;
}): string | null {
  return buildIcs({
    uid: args.eventUid,
    title: args.title,
    details: args.description,
    location: args.location,
    startUtc: Number.isFinite(args.start.getTime()) ? args.start.toISOString() : "",
    endUtc: Number.isFinite(args.end.getTime()) ? args.end.toISOString() : "",
  });
}
