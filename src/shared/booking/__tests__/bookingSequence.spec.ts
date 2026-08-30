import { describe, expect, it } from "vitest";
import {
  canonicalizeUtcInstant,
  parseSequenceBookingIntent,
  parseSequenceTimingSegments,
  parseServicePrepMinutes,
  serializeSequenceBookingIntent,
  singleServiceSequenceTiming,
} from "@/shared/booking/bookingSequence";

const ids = {
  salon: "11111111-1111-4111-8111-111111111111",
  request: "22222222-2222-4222-8222-222222222222",
  line1: "33333333-3333-4333-8333-333333333333",
  line2: "44444444-4444-4444-8444-444444444444",
  service1: "55555555-5555-4555-8555-555555555555",
  service2: "66666666-6666-4666-8666-666666666666",
  staff1: "77777777-7777-4777-8777-777777777777",
  staff2: "88888888-8888-4888-8888-888888888888",
  addon: "99999999-9999-4999-8999-999999999999",
};

function intent() {
  return {
    salonId: ids.salon,
    requestId: ids.request,
    requestedStartTimeUtc: "2026-08-20T18:00:00.000Z",
    lines: [
      {
        lineId: ids.line1,
        position: 0,
        serviceId: ids.service1,
        staffPreference: "any",
        preferredResourceId: null,
        addOnServiceIds: [ids.addon],
      },
      {
        lineId: ids.line2,
        position: 1,
        serviceId: ids.service2,
        staffPreference: ids.staff2,
        addOnServiceIds: [],
      },
    ],
    sameStaffForAll: false,
    voucherCode: " qa-10 ",
    applyEmailDiscount: true,
    customer: {
      name: " QA Guest ",
      phone: "+1 604 555 0199",
      email: "QA@EXAMPLE.COM",
    },
  };
}

describe("parseSequenceBookingIntent", () => {
  it("accepts and normalizes ordered 1-5 line intent without accepting money", () => {
    const parsed = parseSequenceBookingIntent(intent());
    expect(parsed).not.toBeNull();
    expect(parsed?.lines.map((line) => line.position)).toEqual([0, 1]);
    expect(parsed?.customer).toEqual({
      name: "QA Guest",
      phone: "+1 604 555 0199",
      email: "qa@example.com",
    });
    expect(parsed?.voucherCode).toBe("QA-10");
    expect(serializeSequenceBookingIntent(parsed!)).toMatchObject({
      contract_version: 1,
      salon_id: ids.salon,
      lines: [
        { line_id: ids.line1, position: 0, service_id: ids.service1 },
        { line_id: ids.line2, position: 1, service_id: ids.service2 },
      ],
    });
  });

  it("normalizes explicit PostgreSQL timestamptz offsets to the canonical UTC instant", () => {
    const raw = intent();
    raw.requestedStartTimeUtc = "2026-08-20T11:00:00-07:00";
    expect(parseSequenceBookingIntent(raw)?.requestedStartTimeUtc).toBe(
      "2026-08-20T18:00:00.000Z",
    );
    expect(canonicalizeUtcInstant("2026-08-20T18:00:00")).toBeNull();
  });

  it("fails closed on noncontiguous positions, duplicate line IDs and >5 lines", () => {
    const gap = intent();
    gap.lines[1].position = 2;
    expect(parseSequenceBookingIntent(gap)).toBeNull();

    const duplicate = intent();
    duplicate.lines[1].lineId = ids.line1;
    expect(parseSequenceBookingIntent(duplicate)).toBeNull();

    const tooMany = intent();
    tooMany.lines = Array.from({ length: 6 }, (_, position) => ({
      ...tooMany.lines[0],
      position,
      lineId: `${position + 1}0000000-0000-4000-8000-00000000000${position}`,
    }));
    expect(parseSequenceBookingIntent(tooMany)).toBeNull();
  });

  it("uses the existing canonical eight add-on bound", () => {
    const raw = intent();
    raw.lines.splice(1);
    const firstAddons: string[] = raw.lines[0].addOnServiceIds;
    firstAddons.push(
      ...Array.from({ length: 8 }, (_, index) =>
        `${index + 1}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`,
      ),
    );
    expect(parseSequenceBookingIntent(raw)).toBeNull();
  });

  it("accepts one explicit two-staff parallel pair and fails closed beyond two lines", () => {
    const raw = intent() as ReturnType<typeof intent> & {
      lines: Array<ReturnType<typeof intent>["lines"][number] & {
        timingPreference?: "sequential" | "parallel";
      }>;
    };
    raw.lines[1] = { ...raw.lines[1], timingPreference: "parallel" };
    expect(parseSequenceBookingIntent(raw)?.lines[1]?.timingPreference).toBe(
      "parallel",
    );

    const third = {
      ...raw.lines[1],
      lineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      position: 2,
      timingPreference: "parallel",
    };
    expect(parseSequenceBookingIntent({ ...raw, lines: [...raw.lines, third] })).toBeNull();
  });

  it("rejects caller-controlled monetary or derived timing keys", () => {
    expect(parseSequenceBookingIntent({ ...intent(), totalCents: 1 })).toBeNull();
    const raw = intent();
    expect(
      parseSequenceBookingIntent({
        ...raw,
        lines: [{ ...raw.lines[0], prepMinutes: 0 }],
      }),
    ).toBeNull();
  });

  it("rejects malformed email and forbidden customer-name characters at the app boundary", () => {
    const raw = intent();
    expect(
      parseSequenceBookingIntent({
        ...raw,
        customer: { ...raw.customer, email: "qa@example" },
      }),
    ).toBeNull();
    expect(
      parseSequenceBookingIntent({
        ...raw,
        customer: { ...raw.customer, name: "QA & Guest" },
      }),
    ).toBeNull();
  });
});

describe("parseSequenceTimingSegments", () => {
  const valid = [
    {
      line_id: ids.line1,
      position: 0,
      service_id: ids.service1,
      resolved_staff_id: ids.staff1,
      resolved_resource_id: null,
      prep_minutes: 10,
      duration_minutes: 30,
      buffer_minutes: 5,
      occupied_start_utc: "2026-08-20T17:50:00.000Z",
      service_start_utc: "2026-08-20T18:00:00.000Z",
      service_end_utc: "2026-08-20T18:30:00.000Z",
      occupied_end_utc: "2026-08-20T18:35:00.000Z",
    },
    {
      line_id: ids.line2,
      position: 1,
      service_id: ids.service2,
      resolved_staff_id: ids.staff2,
      resolved_resource_id: null,
      prep_minutes: 5,
      duration_minutes: 45,
      buffer_minutes: 10,
      occupied_start_utc: "2026-08-20T18:25:00.000Z",
      service_start_utc: "2026-08-20T18:30:00.000Z",
      service_end_utc: "2026-08-20T19:15:00.000Z",
      occupied_end_utc: "2026-08-20T19:25:00.000Z",
    },
  ];

  it("accepts exact prep/duration/buffer equations and ordered customer work", () => {
    expect(parseSequenceTimingSegments(valid)).toHaveLength(2);
  });

  it("accepts a same-start parallel pair only with different staff", () => {
    const parallel = valid.map((line, index) => ({
      ...line,
      requested_timing_preference: index === 0 ? "sequential" : "parallel",
      resolved_timing_mode: index === 0 ? "sequential" : "parallel",
      ...(index === 1
        ? {
            occupied_start_utc: "2026-08-20T17:55:00.000Z",
            service_start_utc: "2026-08-20T18:00:00.000Z",
            service_end_utc: "2026-08-20T18:45:00.000Z",
            occupied_end_utc: "2026-08-20T18:55:00.000Z",
          }
        : {}),
    }));
    expect(parseSequenceTimingSegments(parallel)).toHaveLength(2);
    expect(
      parseSequenceTimingSegments([
        parallel[0],
        { ...parallel[1], resolved_staff_id: ids.staff1 },
      ]),
    ).toBeNull();
  });

  it("accepts PostgreSQL offset timestamps and canonicalizes every derived instant", () => {
    const offset = [
      {
        ...valid[0],
        occupied_start_utc: "2026-08-20T10:50:00-07:00",
        service_start_utc: "2026-08-20T11:00:00-07:00",
        service_end_utc: "2026-08-20T11:30:00-07:00",
        occupied_end_utc: "2026-08-20T11:35:00-07:00",
      },
      {
        ...valid[1],
        occupied_start_utc: "2026-08-20T11:25:00-07:00",
        service_start_utc: "2026-08-20T11:30:00-07:00",
        service_end_utc: "2026-08-20T12:15:00-07:00",
        occupied_end_utc: "2026-08-20T12:25:00-07:00",
      },
    ];
    expect(parseSequenceTimingSegments(offset)).toEqual(
      parseSequenceTimingSegments(valid),
    );
  });

  it("rejects timestamp equation drift and overlapping customer work", () => {
    expect(
      parseSequenceTimingSegments([
        { ...valid[0], occupied_start_utc: "2026-08-20T17:49:00.000Z" },
      ]),
    ).toBeNull();
    expect(
      parseSequenceTimingSegments([
        valid[0],
        {
          ...valid[1],
          occupied_start_utc: "2026-08-20T18:15:00.000Z",
          service_start_utc: "2026-08-20T18:20:00.000Z",
          service_end_utc: "2026-08-20T19:05:00.000Z",
          occupied_end_utc: "2026-08-20T19:15:00.000Z",
        },
      ]),
    ).toBeNull();
  });

  it("accepts historical service durations through 1440 minutes", () => {
    const day = {
      ...valid[0],
      prep_minutes: 0,
      duration_minutes: 1440,
      buffer_minutes: 0,
      occupied_start_utc: "2026-08-20T18:00:00.000Z",
      service_start_utc: "2026-08-20T18:00:00.000Z",
      service_end_utc: "2026-08-21T18:00:00.000Z",
      occupied_end_utc: "2026-08-21T18:00:00.000Z",
    };
    expect(parseSequenceTimingSegments([day])).toHaveLength(1);
    expect(parseSequenceTimingSegments([{ ...day, duration_minutes: 1441 }])).toBeNull();
  });

  it("accepts the existing trailing-buffer bound through 720 minutes", () => {
    const longBuffer = {
      ...valid[0],
      prep_minutes: 0,
      duration_minutes: 30,
      buffer_minutes: 720,
      occupied_start_utc: "2026-08-20T18:00:00.000Z",
      service_start_utc: "2026-08-20T18:00:00.000Z",
      service_end_utc: "2026-08-20T18:30:00.000Z",
      occupied_end_utc: "2026-08-21T06:30:00.000Z",
    };
    expect(parseSequenceTimingSegments([longBuffer])).toHaveLength(1);
    expect(
      parseSequenceTimingSegments([{ ...longBuffer, buffer_minutes: 721 }]),
    ).toBeNull();
  });
});

describe("singleServiceSequenceTiming", () => {
  it("preserves legacy duration+buffer block when prep is zero", () => {
    expect(
      singleServiceSequenceTiming({
        serviceStartUtc: "2026-08-20T18:00:00Z",
        durationMinutes: 45,
        bufferMinutes: 15,
      }),
    ).toMatchObject({
      occupiedStartUtc: "2026-08-20T18:00:00.000Z",
      occupiedEndUtc: "2026-08-20T19:00:00.000Z",
      blockMinutes: 60,
      customerServiceMinutes: 45,
    });
  });
});

describe("parseServicePrepMinutes", () => {
  it("accepts whole operational minutes from 0 through 180 and rejects drift", () => {
    expect(parseServicePrepMinutes(0)).toBe(0);
    expect(parseServicePrepMinutes("12")).toBe(12);
    expect(parseServicePrepMinutes(180)).toBe(180);
    expect(parseServicePrepMinutes(-1)).toBeNull();
    expect(parseServicePrepMinutes(181)).toBeNull();
    expect(parseServicePrepMinutes(12.5)).toBeNull();
    expect(parseServicePrepMinutes("12.5")).toBeNull();
    expect(parseServicePrepMinutes("bad")).toBeNull();
  });
});
