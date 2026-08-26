import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseBookingSequenceRescheduleQuote } from "../bookingSequenceReschedule";

const ids = {
  request: "11111111-1111-4111-8111-111111111111",
  booking: "22222222-2222-4222-8222-222222222222",
  salon: "33333333-3333-4333-8333-333333333333",
  line: "44444444-4444-4444-8444-444444444444",
  service: "55555555-5555-4555-8555-555555555555",
  staff: "66666666-6666-4666-8666-666666666666",
};

function quote() {
  const schedule = {
    line_id: ids.line,
    position: 0,
    service_id: ids.service,
    staff_id: ids.staff,
    staff_name: "Mai",
    resource_id: null,
    customer_start_utc: "2026-08-24T11:00:00-07:00",
    customer_end_utc: "2026-08-24T12:00:00-07:00",
    occupied_start_utc: "2026-08-24T10:50:00-07:00",
    occupied_end_utc: "2026-08-24T12:05:00-07:00",
    prep_minutes: 10,
    service_duration_minutes: 50,
    sequential_addon_minutes: 10,
    trailing_buffer_minutes: 5,
  };
  return {
    success: true,
    code: "reschedule_quoted",
    request_id: ids.request,
    booking_id: ids.booking,
    salon_id: ids.salon,
    booking_transition_version: 2,
    current_sequence_fingerprint: "a".repeat(64),
    requested_start_time_utc: schedule.customer_start_utc,
    parent_start_time_utc: schedule.customer_start_utc,
    parent_end_time_utc: schedule.customer_end_utc,
    schedule_segments: [schedule],
    timing_segments: [{
      line_id: ids.line,
      position: 0,
      service_id: ids.service,
      resolved_staff_id: ids.staff,
      resolved_resource_id: null,
      prep_minutes: 10,
      duration_minutes: 60,
      buffer_minutes: 5,
      occupied_start_utc: schedule.occupied_start_utc,
      service_start_utc: schedule.customer_start_utc,
      service_end_utc: schedule.customer_end_utc,
      occupied_end_utc: schedule.occupied_end_utc,
    }],
    sequence_fingerprint: "b".repeat(64),
    idempotent: false,
  };
}

describe("parseBookingSequenceRescheduleQuote", () => {
  it("accepts PostgreSQL RFC3339 offsets and canonicalizes them to UTC", () => {
    expect(parseBookingSequenceRescheduleQuote(quote())).toMatchObject({
      requestedStartTimeUtc: "2026-08-24T18:00:00.000Z",
      parentEndTimeUtc: "2026-08-24T19:00:00.000Z",
      segments: [{
        customerStartUtc: "2026-08-24T18:00:00.000Z",
        occupiedStartUtc: "2026-08-24T17:50:00.000Z",
      }],
    });
  });

  it("rejects drift between the schedule and timing projection", () => {
    const value = quote();
    value.timing_segments[0].duration_minutes = 59;
    expect(parseBookingSequenceRescheduleQuote(value)).toBeNull();
  });
});
