import { formatInSalonTz } from "@/shared/lib/salonTime";

export type OwnerNotificationActor =
  | "customer"
  | "public_guest"
  | "owner"
  | "admin"
  | "manager"
  | "senior"
  | "receptionist"
  | "nail_tech"
  | "trainee"
  | "viewer"
  | "accounting"
  | "voice_ai"
  | "demo_cookie"
  | "system";

export type OwnerNotificationChangeField =
  | "time"
  | "staff"
  | "service"
  | "addon";

const ACTOR_LABEL: Record<OwnerNotificationActor, string> = {
  customer: "Customer · Khách hàng",
  public_guest: "Customer · Khách hàng",
  owner: "Owner · Chủ salon",
  admin: "Admin · Quản trị viên",
  manager: "Manager · Quản lý",
  senior: "Senior staff · Nhân viên cấp cao",
  receptionist: "Receptionist · Lễ tân",
  nail_tech: "Nail technician · Thợ nail",
  trainee: "Trainee · Nhân viên tập sự",
  viewer: "Staff · Nhân viên",
  accounting: "Accounting · Kế toán",
  voice_ai: "NailIQ Voice AI",
  demo_cookie: "NailIQ demo",
  system: "NailIQ system · Hệ thống NailIQ",
};

const CHANGE_LABEL: Record<OwnerNotificationChangeField, string> = {
  time: "Time · Giờ hẹn",
  staff: "Staff · Nhân viên",
  service: "Service · Dịch vụ",
  addon: "Add-on · Dịch vụ thêm",
};

export function ownerNotificationActorLabel(
  actor: OwnerNotificationActor | null | undefined,
): string | null {
  return actor ? ACTOR_LABEL[actor] : null;
}

export function ownerNotificationChangesLabel(
  fields: OwnerNotificationChangeField[] | null | undefined,
): string | null {
  if (!fields?.length) return null;
  return Array.from(new Set(fields)).map((field) => CHANGE_LABEL[field]).join(", ");
}

export type OwnerRescheduleTimePayload = {
  event: "reschedule";
  timezone: string;
  previousStartUtc: string;
  nextStartUtc: string;
  before: string;
  afterDate: string;
  afterTime: string;
  textLines: [string, string];
};

function canonicalUtcIso(value: string, field: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`owner reschedule payload: invalid ${field}`);
  }
  return new Date(ms).toISOString();
}

/**
 * Pure capture of the time-sensitive reschedule notification payload.
 *
 * Tests exercise this builder directly; no Resend or SMS transport is touched.
 * The real owner-email sender uses the same payload so QA can prove old/new UTC
 * values and salon-local rendering without delivering an external message.
 */
export function buildOwnerRescheduleTimePayload(input: {
  previousStartUtc: string;
  nextStartUtc: string;
  timezone: string;
  durationMin?: number | null;
}): OwnerRescheduleTimePayload {
  const previousStartUtc = canonicalUtcIso(
    input.previousStartUtc,
    "previousStartUtc",
  );
  const nextStartUtc = canonicalUtcIso(input.nextStartUtc, "nextStartUtc");
  const before = `${formatInSalonTz(previousStartUtc, input.timezone, "date")} ${formatInSalonTz(previousStartUtc, input.timezone, "time")}`;
  const afterDate = formatInSalonTz(nextStartUtc, input.timezone, "date");
  const afterTime = `${formatInSalonTz(nextStartUtc, input.timezone, "time")}${input.durationMin ? ` · ${input.durationMin} min` : ""}`;
  return {
    event: "reschedule",
    timezone: input.timezone,
    previousStartUtc,
    nextStartUtc,
    before,
    afterDate,
    afterTime,
    textLines: [
      `Before / Trước khi đổi: ${before}`,
      `After / Sau khi đổi: ${afterDate} ${afterTime}`,
    ],
  };
}

export function ownerRescheduleTimeLabels(input: {
  previousStartUtc: string;
  nextStartUtc: string;
  timezone: string;
  durationMin?: number | null;
}): { before: string; afterDate: string; afterTime: string } {
  const { before, afterDate, afterTime } =
    buildOwnerRescheduleTimePayload(input);
  return { before, afterDate, afterTime };
}
