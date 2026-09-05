import { z } from "zod";

const uuid = z.string().uuid();
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const preferredSlot = z.string().trim().min(1).max(40).nullable();

export const capacityRescueRequestSchema = z
  .object({
    salonId: uuid,
    requestId: uuid,
    requestKind: z.enum(["individual", "sequence", "group"]),
    primaryServiceId: uuid,
    staffId: uuid.nullable(),
    bookingDateYmd: ymd,
    preferredSlotLabel: preferredSlot,
    partySize: z.number().int().min(1).max(20),
    clientName: z.string().trim().min(1).max(100),
    clientPhone: z.string().trim().min(7).max(32),
    clientEmail: z.string().trim().email().max(254),
    clientLocale: z.enum(["en", "vi"]),
    intent: z
      .record(z.string(), z.unknown())
      .and(
        z.object({
          serviceIds: z.array(uuid).min(1).max(20),
        }),
      ),
  })
  .superRefine((value, ctx) => {
    if (value.requestKind === "group" && value.partySize < 2) {
      ctx.addIssue({
        code: "custom",
        path: ["partySize"],
        message: "group_requires_multiple_guests",
      });
    }
    if (value.requestKind !== "group" && value.partySize !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["partySize"],
        message: "individual_or_sequence_requires_one_guest",
      });
    }
    if (!value.intent.serviceIds.includes(value.primaryServiceId)) {
      ctx.addIssue({
        code: "custom",
        path: ["intent", "serviceIds"],
        message: "primary_service_missing",
      });
    }
    if (
      value.requestKind === "individual" &&
      value.intent.source !== "slot_unavailable" &&
      value.intent.source !== "booking_conflict"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["intent", "source"],
        message: "invalid_waitlist_source",
      });
    }
  });

export type CapacityRescueRequestBody = z.infer<
  typeof capacityRescueRequestSchema
>;
