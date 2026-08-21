import {
  isOpeningHoursCustomized,
  parseOpeningHours,
} from "@/shared/dashboard/openingHoursDefaults";
import { isAllowedTimezone } from "@/shared/dashboard/timezoneOptions";
import { isValidBookingClosedDate } from "@/shared/booking/parseBookingClosedDates";
import { isValidPhone } from "@/shared/dashboard/addressSetupValidation";

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
  /** Selection intent is not readiness proof; used for truthful optional UI. */
  selected?: boolean;
  /** Optional-step navigation decision; never counts as readiness proof. */
  skipped?: boolean;
};

export type GoLiveReadinessInput = {
  slug: string;
  name: string | null;
  address: string | null;
  salonPhone: string | null;
  timezone: unknown;
  openingHours: unknown;
  bookingClosedDates?: unknown;
  profileComplete: boolean;
  email: string | null;
  emailVerified: boolean;
  emailLinksEnabled: boolean;
  phoneOtpEnabled: boolean;
  cancellationPolicy?: unknown;
  defaultNotificationLocale?: unknown;
  paymentProvider?: unknown;
  voiceAiEnabled?: boolean;
  optionalIntegrationsSkipped?: boolean;
  /**
   * The QA-only Guided Setup pilot makes its policy and communication steps
   * technical prerequisites. Legacy salons keep the canonical readiness
   * contract until their per-salon pilot flag is explicitly enabled.
   */
  guidedSetupEnabled?: boolean;
  staffAccessValid?: boolean;
  serviceCoverageValid?: boolean;
  groupBookingEnabled?: boolean;
  groupTogetherThresholdMinutes?: unknown;
  noShowGroupWholeParty?: unknown;
  /** Default-OFF sequence rollout is data/proof based, never click based. */
  multiServiceBookingEnabled?: boolean;
  multiServiceSequenceReadiness?: {
    contractVersion: number;
    scheduleModel: string;
    platformEnabled: boolean;
    salonEnabled: boolean;
    qaAllowlisted: boolean;
    catalogReady: boolean;
    capacityContractReady: boolean;
    ready: boolean;
  };
  activeServices: Array<{
    priceCents: number | null;
    durationMinutes: number | null;
  }>;
  activeStaffCount: number;
  humanAttestations?: {
    hoursConfirmed: boolean;
    otpPolicyConfirmed: boolean;
    liveRehearsalCompleted: boolean;
    ownerApproved: boolean;
    ownerApprovalStale: boolean;
  };
};

export type GoLiveReadiness = {
  checks: GoLiveReadinessCheck[];
  passedBlocking: number;
  totalBlocking: number;
  readyForManualReview: boolean;
  approvedForGoLive: boolean;
};

function text(value: string | null): string {
  return value?.trim() ?? "";
}

function hasBilingualPolicy(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as { en?: unknown; vi?: unknown };
  return (
    typeof policy.en === "string" &&
    policy.en.trim().length > 0 &&
    typeof policy.vi === "string" &&
    policy.vi.trim().length > 0
  );
}

export function evaluateGoLiveReadiness(
  input: GoLiveReadinessInput,
): GoLiveReadiness {
  const setupBase = `/dashboard/${encodeURIComponent(input.slug)}/setup`;
  const settingsBase = `/dashboard/${encodeURIComponent(input.slug)}/settings`;
  const guidedRequired = input.guidedSetupEnabled === true;
  const hours = parseOpeningHours(input.openingHours);
  const legacyHasOpenDay =
    hours !== null &&
    Object.values(hours).some(
      (day) => !day.closed && day.open.trim() !== day.close.trim(),
    );
  const openDays = hours
    ? Object.values(hours).filter((day) => !day.closed)
    : [];
  const closedDatesValid =
    input.bookingClosedDates == null ||
    (Array.isArray(input.bookingClosedDates) &&
      input.bookingClosedDates.every(isValidBookingClosedDate));
  const guidedScheduleValid =
    hours !== null &&
    openDays.length > 0 &&
    openDays.every((day) => day.open.trim() < day.close.trim()) &&
    closedDatesValid;
  const legacyScheduleValid =
    hours !== null && legacyHasOpenDay && isAllowedTimezone(input.timezone);
  const scheduleValid = guidedRequired
    ? guidedScheduleValid
    : legacyScheduleValid;
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
  const catalogValid =
    servicesValid && (!guidedRequired || input.serviceCoverageValid === true);
  const supportedNotificationLocale =
    input.defaultNotificationLocale === "en" ||
    input.defaultNotificationLocale === "vi";
  const integrationSelected =
    input.paymentProvider === "square" ||
    input.paymentProvider === "stripe" ||
    input.voiceAiEnabled === true;
  const staffAccessValid = input.staffAccessValid === true;
  const groupThreshold = Number(input.groupTogetherThresholdMinutes);
  const groupPolicyValid =
    input.groupBookingEnabled !== true ||
    (typeof input.groupTogetherThresholdMinutes === "number" &&
      Number.isFinite(groupThreshold) &&
      groupThreshold >= 0 &&
      groupThreshold <= 120 &&
      typeof input.noShowGroupWholeParty === "boolean");
  const bookingPolicyValid =
    hasBilingualPolicy(input.cancellationPolicy) && groupPolicyValid;
  const sequenceRequired = input.multiServiceBookingEnabled === true;
  const sequenceProof = input.multiServiceSequenceReadiness;
  const sequenceReady =
    !sequenceRequired ||
    (sequenceProof?.contractVersion === 1 &&
      sequenceProof.scheduleModel === "segments_v1" &&
      sequenceProof.platformEnabled === true &&
      sequenceProof.salonEnabled === true &&
      sequenceProof.qaAllowlisted === true &&
      sequenceProof.catalogReady === true &&
      sequenceProof.capacityContractReady === true &&
      sequenceProof.ready === true);
  const attestations = input.humanAttestations ?? {
    hoursConfirmed: false,
    otpPolicyConfirmed: false,
    liveRehearsalCompleted: false,
    ownerApproved: false,
    ownerApprovalStale: false,
  };
  const rehearsalVerified = attestations.liveRehearsalCompleted;
  const identityValid =
    Boolean(text(input.name)) &&
    Boolean(text(input.address)) &&
    (guidedRequired
      ? isValidPhone(text(input.salonPhone)) &&
        isAllowedTimezone(input.timezone)
      : Boolean(text(input.salonPhone)));

  const allChecks: GoLiveReadinessCheck[] = [
    {
      id: "identity",
      state: identityValid ? "pass" : "action",
      blocking: true,
      titleEn: "Salon identity and contact",
      titleVi: "Thông tin và liên hệ của tiệm",
      detailEn: identityValid
        ? guidedRequired
          ? `Name, address, public phone, and ${String(input.timezone)} timezone are present.`
          : "Name, address, and public salon phone are present."
        : guidedRequired
          ? "Add the salon name, full address, public phone number, and supported timezone."
          : "Add the salon name, full address, and public phone number.",
      detailVi: identityValid
        ? guidedRequired
          ? `Đã có tên, địa chỉ, số điện thoại công khai và múi giờ ${String(input.timezone)}.`
          : "Đã có tên, địa chỉ và số điện thoại công khai của tiệm."
        : guidedRequired
          ? "Thêm tên, địa chỉ đầy đủ, số điện thoại công khai và múi giờ được hỗ trợ."
          : "Thêm tên, địa chỉ đầy đủ và số điện thoại công khai của tiệm.",
      href: `${setupBase}/address`,
    },
    {
      id: "catalog",
      state: catalogValid ? "pass" : "action",
      blocking: true,
      titleEn: "Bookable service catalog",
      titleVi: "Danh mục dịch vụ có thể đặt",
      detailEn: !servicesValid
        ? input.activeServices.length === 0
          ? "Add at least one active service."
          : "Every active service needs a valid price and duration."
        : guidedRequired && input.serviceCoverageValid !== true
          ? "Assign every active service to at least one active staff member."
          : guidedRequired
            ? `${input.activeServices.length} active service${input.activeServices.length === 1 ? "" : "s"} with valid price, duration, and staff coverage.`
            : `${input.activeServices.length} active service${input.activeServices.length === 1 ? "" : "s"} with valid price and duration.`,
      detailVi: !servicesValid
        ? input.activeServices.length === 0
          ? "Thêm ít nhất một dịch vụ đang hoạt động."
          : "Mỗi dịch vụ đang hoạt động cần có giá và thời lượng hợp lệ."
        : guidedRequired && input.serviceCoverageValid !== true
          ? "Gán mỗi dịch vụ đang hoạt động cho ít nhất một nhân viên đang hoạt động."
          : guidedRequired
            ? `${input.activeServices.length} dịch vụ đang hoạt động có giá, thời lượng và nhân viên thực hiện hợp lệ.`
            : `${input.activeServices.length} dịch vụ đang hoạt động có giá và thời lượng hợp lệ.`,
      href: `${setupBase}/services`,
    },
    {
      id: "staff",
      state:
        input.activeStaffCount > 0 && (!guidedRequired || staffAccessValid)
          ? "pass"
          : "action",
      blocking: true,
      titleEn: "Bookable staff",
      titleVi: "Nhân viên nhận lịch",
      detailEn:
        input.activeStaffCount === 0
          ? "Add at least one active staff member."
          : guidedRequired && !staffAccessValid
            ? "Review every active staff job role. Linked staff logins require separate authorization evidence before this check can pass."
            : guidedRequired
              ? `${input.activeStaffCount} active staff member${input.activeStaffCount === 1 ? "" : "s"} with valid access configuration.`
              : `${input.activeStaffCount} active staff member${input.activeStaffCount === 1 ? "" : "s"}.`,
      detailVi:
        input.activeStaffCount === 0
          ? "Thêm ít nhất một nhân viên đang hoạt động."
          : guidedRequired && !staffAccessValid
            ? "Kiểm tra vai trò công việc của mọi nhân viên đang hoạt động. Tài khoản nhân viên đã liên kết cần bằng chứng quyền riêng trước khi mục này đạt."
            : guidedRequired
              ? `${input.activeStaffCount} nhân viên đang hoạt động có cấu hình quyền hợp lệ.`
              : `${input.activeStaffCount} nhân viên đang hoạt động.`,
      href: `${setupBase}/staff`,
    },
    {
      id: "schedule",
      state: scheduleValid ? "pass" : "action",
      blocking: true,
      titleEn: "Business hours and closed days",
      titleVi: "Giờ mở cửa và ngày nghỉ",
      detailEn: !scheduleValid
        ? guidedRequired
          ? "Save a complete seven-day schedule with at least one open day, opening before closing, and only real calendar dates for any special closures."
          : "Save valid business hours with at least one open day and a supported timezone."
        : hoursCustomized
          ? `Business hours are saved in ${String(input.timezone)}.`
          : `Valid default hours are saved in ${String(input.timezone)}; human confirmation is still required.`,
      detailVi: !scheduleValid
        ? guidedRequired
          ? "Lưu lịch đủ bảy ngày với ít nhất một ngày mở cửa, giờ mở trước giờ đóng và chỉ dùng ngày lịch hợp lệ cho mọi ngày nghỉ đặc biệt."
          : "Lưu giờ làm việc hợp lệ, ít nhất một ngày mở cửa và múi giờ được hỗ trợ."
        : hoursCustomized
          ? `Đã lưu giờ làm việc theo ${String(input.timezone)}.`
          : `Đã lưu giờ mặc định hợp lệ theo ${String(input.timezone)}; vẫn cần người thật xác nhận.`,
      href: `${setupBase}/hours`,
    },
    {
      id: "booking-policy",
      state: bookingPolicyValid ? "pass" : "action",
      blocking: guidedRequired,
      titleEn: "Booking, cancellation, and no-show policy",
      titleVi: "Quy định đặt lịch, huỷ lịch và vắng mặt",
      detailEn: !hasBilingualPolicy(input.cancellationPolicy)
        ? "Review and save the salon's English and Vietnamese policy before go-live."
        : !groupPolicyValid
          ? "Group booking is enabled, but its together-window or whole-party no-show rule is missing or invalid."
          : "Bilingual salon policy and every enabled group rule are saved. After-hours bookings remain locked to per-booking Owner/Admin approval plus staff consent.",
      detailVi: !hasBilingualPolicy(input.cancellationPolicy)
        ? "Xem lại và lưu chính sách của tiệm bằng tiếng Anh và tiếng Việt trước khi hoạt động."
        : !groupPolicyValid
          ? "Đặt lịch nhóm đang bật nhưng khung giờ đi cùng nhau hoặc quy định vắng mặt cả nhóm còn thiếu hay không hợp lệ."
          : "Đã lưu chính sách song ngữ và mọi quy định nhóm đang bật. Lịch ngoài giờ vẫn yêu cầu Owner/Admin phê duyệt từng lịch và nhân viên đồng ý.",
      href: `/dashboard/${encodeURIComponent(input.slug)}/no-show-protection`,
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
      blocking: guidedRequired,
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
      id: "notification-language",
      state: supportedNotificationLocale ? "pass" : "action",
      blocking: guidedRequired,
      titleEn: "Default notification language",
      titleVi: "Ngôn ngữ thông báo mặc định",
      detailEn: supportedNotificationLocale
        ? `${String(input.defaultNotificationLocale).toUpperCase()} is saved as the salon default.`
        : "Choose English or Vietnamese as the salon's default notification language.",
      detailVi: supportedNotificationLocale
        ? `Đã lưu ${String(input.defaultNotificationLocale).toUpperCase()} làm ngôn ngữ mặc định của tiệm.`
        : "Chọn tiếng Anh hoặc tiếng Việt làm ngôn ngữ thông báo mặc định của tiệm.",
      href: `${settingsBase}#cat-notifications`,
    },
    {
      id: "optional-integrations",
      // Selecting a provider is intent, not runtime credential proof. Keep
      // this optional check in review until a future provider-specific probe
      // can supply trustworthy evidence.
      state: "review",
      blocking: false,
      selected: integrationSelected,
      skipped: input.optionalIntegrationsSkipped === true,
      titleEn: "Payments and AI (optional)",
      titleVi: "Thanh toán và AI (không bắt buộc)",
      detailEn: integrationSelected
        ? "Selected, but provider credentials and runtime delivery are not yet verified. This optional item does not block core setup."
        : "No payment or AI integration is required to finish core setup; add one later if needed.",
      detailVi: integrationSelected
        ? "Đã chọn nhưng credential và hoạt động runtime của nhà cung cấp chưa được xác minh. Mục không bắt buộc này không chặn thiết lập cốt lõi."
        : "Không cần tích hợp thanh toán hoặc AI để hoàn tất thiết lập cốt lõi; có thể thêm sau.",
      href: `${settingsBase}#cat-integrations`,
    },
    {
      id: "hours-confirmation",
      state: attestations.hoursConfirmed ? "pass" : "review",
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
      state: attestations.otpPolicyConfirmed ? "pass" : "review",
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
      state: rehearsalVerified ? "pass" : "review",
      blocking: false,
      titleEn: guidedRequired
        ? "Owner-approved safe booking preview"
        : "Owner-approved live rehearsal",
      titleVi: guidedRequired
        ? "Preview booking an toàn có chủ tiệm phê duyệt"
        : "Chạy thử có chủ tiệm phê duyệt",
      detailEn: guidedRequired
        ? rehearsalVerified
          ? "An Owner/Admin reviewed a server-rechecked service, staff, date, and available time for this exact configuration snapshot."
          : "Use Safe Preview to select a service, eligible staff, date, and available time, then record the result there. The live booking form is never used."
        : "A human must test owner and receptionist login, complete the authorized rehearsal, verify it at the desk, and record go-live approval.",
      detailVi: guidedRequired
        ? rehearsalVerified
          ? "Owner/Admin đã kiểm tra dịch vụ, nhân viên, ngày và giờ trống được server xác minh lại cho đúng snapshot cấu hình này."
          : "Dùng Safe Preview để chọn dịch vụ, nhân viên phù hợp, ngày và giờ trống rồi ghi nhận tại đó. Không dùng form booking thật."
        : "Cần người thật kiểm tra đăng nhập Owner và Receptionist, hoàn tất lần chạy thử được cho phép, xác minh tại quầy và ghi nhận phê duyệt go-live.",
    },
    {
      id: "owner-approval",
      state: attestations.ownerApproved ? "pass" : "review",
      blocking: false,
      titleEn: "Final owner approval",
      titleVi: "Chủ tiệm phê duyệt cuối",
      detailEn: attestations.ownerApproved
        ? "The owner approved this exact readiness configuration."
        : attestations.ownerApprovalStale
          ? "The salon configuration changed after approval. The owner must review and approve again."
          : "Only an Owner can approve after every technical gate and human prerequisite is complete.",
      detailVi: attestations.ownerApproved
        ? "Chủ tiệm đã phê duyệt đúng cấu hình readiness hiện tại."
        : attestations.ownerApprovalStale
          ? "Cấu hình tiệm đã thay đổi sau khi phê duyệt. Chủ tiệm cần xem lại và phê duyệt lại."
          : "Chỉ Owner được phê duyệt sau khi hoàn tất mọi cổng kỹ thuật và xác nhận con người.",
    },
  ];
  if (sequenceRequired) {
    allChecks.push({
      id: "multi_service_sequence",
      state: sequenceReady ? "pass" : "action",
      blocking: true,
      titleEn: "Multi-service sequence contract",
      titleVi: "Hợp đồng chuỗi nhiều dịch vụ",
      detailEn: sequenceReady
        ? "QA allowlist, catalog, and cross-model capacity contracts are ready for sequence v1."
        : "Multi-service remains blocked until platform, QA allowlist, catalog, and capacity proof all pass.",
      detailVi: sequenceReady
        ? "Allowlist QA, danh mục và hợp đồng sức chứa liên mô hình đã sẵn sàng cho sequence v1."
        : "Nhiều dịch vụ vẫn bị khóa cho đến khi cổng nền tảng, allowlist QA, danh mục và bằng chứng sức chứa đều đạt.",
      href: `${setupBase}/services`,
    });
  }
  const guidedOnlyCheckIds = new Set([
    "booking-policy",
    "notification-language",
    "optional-integrations",
  ]);
  const checks = guidedRequired
    ? allChecks
    : allChecks.filter((check) => !guidedOnlyCheckIds.has(check.id));

  const blocking = checks.filter((check) => check.blocking);
  const passedBlocking = blocking.filter(
    (check) => check.state === "pass",
  ).length;

  return {
    checks,
    passedBlocking,
    totalBlocking: blocking.length,
    readyForManualReview: passedBlocking === blocking.length,
    approvedForGoLive:
      passedBlocking === blocking.length &&
      attestations.hoursConfirmed &&
      attestations.otpPolicyConfirmed &&
      rehearsalVerified &&
      attestations.ownerApproved,
  };
}
