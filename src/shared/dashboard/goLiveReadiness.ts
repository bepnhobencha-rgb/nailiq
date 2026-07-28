import {
  isOpeningHoursCustomized,
  parseOpeningHours,
} from "@/shared/dashboard/openingHoursDefaults";
import { isAllowedTimezone } from "@/shared/dashboard/timezoneOptions";

export type GoLiveReadinessState = "pass" | "action" | "review";

export type GoLiveReadinessCheck = {
  id: string;
  state: GoLiveReadinessState;
  blocking: boolean;
  titleEn: string;
  titleVi: string;
  detailEn: string;
  detailVi: string;
  href?: string;
};

export type GoLiveReadinessInput = {
  slug: string;
  name: string | null;
  address: string | null;
  salonPhone: string | null;
  timezone: unknown;
  openingHours: unknown;
  profileComplete: boolean;
  email: string | null;
  emailVerified: boolean;
  emailLinksEnabled: boolean;
  phoneOtpEnabled: boolean;
  activeServices: Array<{
    priceCents: number | null;
    durationMinutes: number | null;
  }>;
  activeStaffCount: number;
};

export type GoLiveReadiness = {
  checks: GoLiveReadinessCheck[];
  passedBlocking: number;
  totalBlocking: number;
  readyForManualReview: boolean;
};

function text(value: string | null): string {
  return value?.trim() ?? "";
}

export function evaluateGoLiveReadiness(
  input: GoLiveReadinessInput,
): GoLiveReadiness {
  const setupBase = `/dashboard/${encodeURIComponent(input.slug)}/setup`;
  const settingsBase = `/dashboard/${encodeURIComponent(input.slug)}/settings`;
  const hours = parseOpeningHours(input.openingHours);
  const hasOpenDay =
    hours !== null &&
    Object.values(hours).some(
      (day) => !day.closed && day.open.trim() !== day.close.trim(),
    );
  const hoursCustomized = isOpeningHoursCustomized(input.openingHours);
  const servicesValid =
    input.activeServices.length > 0 &&
    input.activeServices.every(
      (service) =>
        Number.isFinite(service.priceCents) &&
        Number(service.priceCents) >= 0 &&
        Number.isFinite(service.durationMinutes) &&
        Number(service.durationMinutes) > 0,
    );

  const checks: GoLiveReadinessCheck[] = [
    {
      id: "identity",
      state:
        text(input.name) && text(input.address) && text(input.salonPhone)
          ? "pass"
          : "action",
      blocking: true,
      titleEn: "Salon identity and contact",
      titleVi: "Thông tin và liên hệ của tiệm",
      detailEn:
        text(input.name) && text(input.address) && text(input.salonPhone)
          ? "Name, address, and public salon phone are present."
          : "Add the salon name, full address, and public phone number.",
      detailVi:
        text(input.name) && text(input.address) && text(input.salonPhone)
          ? "Đã có tên, địa chỉ và số điện thoại công khai của tiệm."
          : "Thêm tên, địa chỉ đầy đủ và số điện thoại công khai của tiệm.",
      href: `${setupBase}/address`,
    },
    {
      id: "catalog",
      state: servicesValid ? "pass" : "action",
      blocking: true,
      titleEn: "Bookable service catalog",
      titleVi: "Danh mục dịch vụ có thể đặt",
      detailEn: servicesValid
        ? `${input.activeServices.length} active service${input.activeServices.length === 1 ? "" : "s"} with valid price and duration.`
        : input.activeServices.length === 0
          ? "Add at least one active service."
          : "Every active service needs a valid price and duration.",
      detailVi: servicesValid
        ? `${input.activeServices.length} dịch vụ đang hoạt động có giá và thời lượng hợp lệ.`
        : input.activeServices.length === 0
          ? "Thêm ít nhất một dịch vụ đang hoạt động."
          : "Mỗi dịch vụ đang hoạt động cần có giá và thời lượng hợp lệ.",
      href: `${setupBase}/services`,
    },
    {
      id: "staff",
      state: input.activeStaffCount > 0 ? "pass" : "action",
      blocking: true,
      titleEn: "Bookable staff",
      titleVi: "Nhân viên nhận lịch",
      detailEn:
        input.activeStaffCount > 0
          ? `${input.activeStaffCount} active staff member${input.activeStaffCount === 1 ? "" : "s"}.`
          : "Add at least one active staff member.",
      detailVi:
        input.activeStaffCount > 0
          ? `${input.activeStaffCount} nhân viên đang hoạt động.`
          : "Thêm ít nhất một nhân viên đang hoạt động.",
      href: `${setupBase}/staff`,
    },
    {
      id: "schedule",
      state:
        hours && hasOpenDay && isAllowedTimezone(input.timezone)
          ? "pass"
          : "action",
      blocking: true,
      titleEn: "Hours and timezone",
      titleVi: "Giờ mở cửa và múi giờ",
      detailEn:
        !hours || !hasOpenDay || !isAllowedTimezone(input.timezone)
          ? "Save valid business hours with at least one open day and a supported timezone."
          : hoursCustomized
            ? `Business hours are saved in ${String(input.timezone)}.`
            : `Valid default hours are saved in ${String(input.timezone)}; human confirmation is still required.`,
      detailVi:
        !hours || !hasOpenDay || !isAllowedTimezone(input.timezone)
          ? "Lưu giờ làm việc hợp lệ, ít nhất một ngày mở cửa và múi giờ được hỗ trợ."
          : hoursCustomized
            ? `Đã lưu giờ làm việc theo ${String(input.timezone)}.`
            : `Đã lưu giờ mặc định hợp lệ theo ${String(input.timezone)}; vẫn cần người thật xác nhận.`,
      href: `${setupBase}/hours`,
    },
    {
      id: "public-booking",
      state: input.profileComplete ? "pass" : "action",
      blocking: true,
      titleEn: "Public booking gate",
      titleVi: "Điều kiện mở đặt lịch công khai",
      detailEn: input.profileComplete
        ? "The salon is allowed to accept public bookings."
        : "Public booking remains paused until address, staff, and services are complete.",
      detailVi: input.profileComplete
        ? "Tiệm đã được phép nhận lịch đặt công khai."
        : "Đặt lịch công khai vẫn tạm dừng đến khi hoàn tất địa chỉ, nhân viên và dịch vụ.",
      href: `/${encodeURIComponent(input.slug)}`,
    },
    {
      id: "fallback-channel",
      state:
        input.emailLinksEnabled && text(input.email) && input.emailVerified
          ? "pass"
          : "review",
      blocking: false,
      titleEn: "Customer email fallback",
      titleVi: "Kênh email dự phòng cho khách",
      detailEn:
        input.emailLinksEnabled && text(input.email) && input.emailVerified
          ? "Verified salon email and email links are enabled."
          : "Verify the salon email and keep email links enabled before relying on SMS.",
      detailVi:
        input.emailLinksEnabled && text(input.email) && input.emailVerified
          ? "Email của tiệm đã xác minh và đường dẫn qua email đang bật."
          : "Xác minh email của tiệm và bật đường dẫn qua email trước khi phụ thuộc vào SMS.",
      href: `${settingsBase}#cat-notifications`,
    },
    {
      id: "hours-confirmation",
      state: "review",
      blocking: false,
      titleEn: "Confirm real business hours",
      titleVi: "Xác nhận giờ làm việc thực tế",
      detailEn: hoursCustomized
        ? "Confirm the saved hours and timezone match the salon's real schedule."
        : "Default hours are still in use. Confirm or update them with the salon owner.",
      detailVi: hoursCustomized
        ? "Xác nhận giờ đã lưu và múi giờ khớp lịch hoạt động thực tế của tiệm."
        : "Tiệm vẫn dùng giờ mặc định. Xác nhận hoặc cập nhật cùng chủ tiệm.",
      href: `${setupBase}/hours`,
    },
    {
      id: "otp-policy",
      state: "review",
      blocking: false,
      titleEn: "OTP and consent policy",
      titleVi: "Chính sách OTP và đồng ý nhận tin",
      detailEn: input.phoneOtpEnabled
        ? "Phone OTP is on. Confirm Twilio/A2P delivery and approved CASL/TCPA wording."
        : "Phone OTP is off. Confirm this is the salon owner's intended policy.",
      detailVi: input.phoneOtpEnabled
        ? "OTP điện thoại đang bật. Xác nhận Twilio/A2P gửi được và nội dung CASL/TCPA đã duyệt."
        : "OTP điện thoại đang tắt. Xác nhận đây là chính sách chủ tiệm mong muốn.",
      href: `${settingsBase}#cat-notifications`,
    },
    {
      id: "human-approval",
      state: "review",
      blocking: false,
      titleEn: "Owner-approved live rehearsal",
      titleVi: "Chạy thử có chủ tiệm phê duyệt",
      detailEn:
        "A human must test owner and receptionist login, create one approved test booking, verify it at the desk, and record go-live approval.",
      detailVi:
        "Cần người thật kiểm tra đăng nhập Owner và Receptionist, tạo một lịch thử được cho phép, xác minh tại quầy và ghi nhận phê duyệt go-live.",
    },
  ];

  const blocking = checks.filter((check) => check.blocking);
  const passedBlocking = blocking.filter((check) => check.state === "pass").length;

  return {
    checks,
    passedBlocking,
    totalBlocking: blocking.length,
    readyForManualReview: passedBlocking === blocking.length,
  };
}
