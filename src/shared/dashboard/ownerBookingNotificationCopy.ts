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

export function ownerRescheduleTimeLabels(input: {
  previousStartUtc: string;
  nextStartUtc: string;
  timezone: string;
  durationMin?: number | null;
}): { before: string; afterDate: string; afterTime: string } {
  const before = `${formatInSalonTz(input.previousStartUtc, input.timezone, "date")} ${formatInSalonTz(input.previousStartUtc, input.timezone, "time")}`;
  const afterDate = formatInSalonTz(input.nextStartUtc, input.timezone, "date");
  const afterTime = `${formatInSalonTz(input.nextStartUtc, input.timezone, "time")}${input.durationMin ? ` · ${input.durationMin} min` : ""}`;
  return { before, afterDate, afterTime };
}
