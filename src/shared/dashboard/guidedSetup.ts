import type {
  GoLiveReadiness,
  GoLiveReadinessCheck,
} from "@/shared/dashboard/goLiveReadiness";

export type GuidedSetupStepId =
  | "salon-profile"
  | "business-hours"
  | "team-access"
  | "service-menu"
  | "booking-policies"
  | "communications"
  | "integrations"
  | "booking-preview"
  | "go-live";

export type GuidedSetupStep = {
  id: GuidedSetupStepId;
  required: boolean;
  done: boolean;
  selected: boolean;
  titleEn: string;
  titleVi: string;
  reasonEn: string;
  reasonVi: string;
  validationEn: string;
  validationVi: string;
  detailEn: string;
  detailVi: string;
  href: string;
};

export type GuidedSetupProgress = {
  steps: GuidedSetupStep[];
  completedCount: number;
  requiredCount: number;
  percent: number;
  currentStepNumber: number;
  totalStepCount: number;
  nextStep: GuidedSetupStep | null;
  complete: boolean;
};

export type GuidedSetupStage = "disabled" | "incomplete" | "complete";
export type GuidedDashboardRootDisposition =
  | "legacy"
  | "setup"
  | "action-center";

/** Null means readiness could not be loaded and must fail closed. */
export function resolveGuidedSetupStage(
  guidedSetupEnabled: boolean,
  setupComplete: boolean | null,
): GuidedSetupStage {
  if (!guidedSetupEnabled) return "disabled";
  return setupComplete === true ? "complete" : "incomplete";
}

/** Never expose the legacy dashboard when a flagged salon lacks readiness. */
export function resolveGuidedDashboardRoot(
  guidedSetupEnabled: boolean,
  setupComplete: boolean | null,
): GuidedDashboardRootDisposition {
  if (!guidedSetupEnabled) return "legacy";
  return setupComplete === true ? "action-center" : "setup";
}

/**
 * Keep the shell focused throughout setup and on the first post-setup Action
 * Center. Nested operational routes restore the normal navigation, so no
 * capability is removed and the prototype remains reversible.
 */
export function shouldUseGuidedFocusMode(
  stage: GuidedSetupStage,
  activeSegment: string | null,
): boolean {
  return (
    stage === "incomplete" ||
    (stage === "complete" && activeSegment === null)
  );
}

/**
 * The hub exposes exactly one forward action. Every other row remains visible
 * but inert, including the optional integration step (explicitly skipped for
 * now). Direct authenticated route deep-links still work, so a saved/resume
 * URL remains stable without inventing a second route guard.
 */
export function canOpenGuidedStep(
  steps: GuidedSetupStep[],
  stepIndex: number,
  nextStep: GuidedSetupStep | null,
): boolean {
  const step = steps[stepIndex];
  if (!step) return false;
  return nextStep?.id === step.id;
}

function findCheck(
  readiness: GoLiveReadiness,
  id: string,
): GoLiveReadinessCheck | undefined {
  return readiness.checks.find((check) => check.id === id);
}

function checksPass(readiness: GoLiveReadiness, ids: string[]): boolean {
  return ids.every((id) => findCheck(readiness, id)?.state === "pass");
}

function firstIncompleteDetail(
  readiness: GoLiveReadiness,
  ids: string[],
  language: "en" | "vi",
  fallback: string,
): string {
  const check = ids
    .map((id) => findCheck(readiness, id))
    .find((candidate) => candidate?.state !== "pass");
  if (!check) return fallback;
  return language === "vi" ? check.detailVi : check.detailEn;
}

export function deriveGuidedSetupProgress(
  slug: string,
  readiness: GoLiveReadiness,
): GuidedSetupProgress {
  const encodedSlug = encodeURIComponent(slug);
  const dashboardBase = `/dashboard/${encodedSlug}`;
  const setupBase = `${dashboardBase}/setup`;
  const settingsBase = `${dashboardBase}/settings`;

  const definitions: Array<
    Omit<GuidedSetupStep, "done" | "selected" | "detailEn" | "detailVi"> & {
      checkIds: string[];
      completeEn: string;
      completeVi: string;
    }
  > = [
    {
      id: "salon-profile",
      required: true,
      checkIds: ["identity"],
      titleEn: "Salon information and timezone",
      titleVi: "Thông tin salon và múi giờ",
      reasonEn:
        "Accurate contact details and timezone keep every booking on the right local schedule.",
      reasonVi:
        "Thông tin liên hệ và múi giờ chính xác giúp mọi lịch hẹn chạy đúng giờ địa phương.",
      validationEn:
        "Passes when name, address, public phone, and a supported timezone are saved.",
      validationVi:
        "Đạt khi đã lưu tên, địa chỉ, số điện thoại công khai và múi giờ được hỗ trợ.",
      completeEn: "Salon identity, contact details, and timezone are valid.",
      completeVi: "Thông tin, liên hệ và múi giờ của salon đã hợp lệ.",
      href: `${setupBase}/address`,
    },
    {
      id: "business-hours",
      required: true,
      checkIds: ["schedule"],
      titleEn: "Business hours and closed days",
      titleVi: "Giờ mở cửa và ngày nghỉ",
      reasonEn:
        "Availability must match the salon's real working schedule before customers can book.",
      reasonVi:
        "Lịch trống phải khớp giờ làm thực tế của salon trước khi khách đặt hẹn.",
      validationEn:
        "Passes after valid hours and closed days are saved. The final Go-Live review separately records the owner's human confirmation.",
      validationVi:
        "Đạt sau khi lưu giờ hợp lệ và ngày nghỉ. Bước Go-Live cuối sẽ ghi nhận riêng xác nhận của chủ salon.",
      completeEn: "Business hours and closed days are valid.",
      completeVi: "Giờ hoạt động và ngày nghỉ đã hợp lệ.",
      href: `${setupBase}/hours`,
    },
    {
      id: "team-access",
      required: true,
      checkIds: ["staff"],
      titleEn: "Staff and access",
      titleVi: "Nhân viên và quyền truy cập",
      reasonEn:
        "Bookable staff and clear roles prevent appointments or sensitive settings from reaching the wrong person.",
      reasonVi:
        "Nhân viên nhận lịch và vai trò rõ ràng giúp lịch hẹn hoặc cài đặt nhạy cảm không đến sai người.",
      validationEn:
        "Passes when active staff have supported job roles and every linked login has active salon access.",
      validationVi:
        "Đạt khi nhân viên đang hoạt động có vai trò công việc được hỗ trợ và mọi tài khoản đã liên kết có quyền salon còn hiệu lực.",
      completeEn: "At least one active staff member can take bookings.",
      completeVi: "Có ít nhất một nhân viên đang hoạt động có thể nhận lịch.",
      href: `${setupBase}/staff`,
    },
    {
      id: "service-menu",
      required: true,
      checkIds: ["catalog"],
      titleEn: "Services, prices, and duration",
      titleVi: "Dịch vụ, giá và thời lượng",
      reasonEn:
        "Customers and staff need one reliable source for what can be booked and how long it takes.",
      reasonVi:
        "Khách và nhân viên cần một nguồn chính xác về dịch vụ có thể đặt và thời lượng thực hiện.",
      validationEn:
        "Passes when every active service has a valid price, duration, and at least one active staff assignment.",
      validationVi:
        "Đạt khi mọi dịch vụ đang hoạt động có giá, thời lượng và ít nhất một nhân viên đang hoạt động được phân công.",
      completeEn: "The active service menu has valid prices and durations.",
      completeVi:
        "Danh mục dịch vụ đang hoạt động có giá và thời lượng hợp lệ.",
      href: `${setupBase}/services`,
    },
    {
      id: "booking-policies",
      required: true,
      checkIds: ["booking-policy"],
      titleEn: "Booking and cancellation rules",
      titleVi: "Quy định đặt và huỷ lịch",
      reasonEn:
        "Clear cancellation, no-show, group, and after-hours rules reduce disputes and staff guesswork.",
      reasonVi:
        "Quy định rõ về huỷ lịch, vắng mặt, nhóm và ngoài giờ giúp giảm khiếu nại và việc nhân viên phải đoán.",
      validationEn:
        "Passes when salon-specific cancellation and no-show policy text is saved in English and Vietnamese; optional group or after-hours rules apply only when enabled.",
      validationVi:
        "Đạt khi đã lưu chính sách huỷ lịch và vắng mặt riêng của salon bằng tiếng Anh và tiếng Việt; quy định nhóm hoặc ngoài giờ chỉ áp dụng khi được bật.",
      completeEn: "The bilingual salon policy is saved.",
      completeVi: "Chính sách song ngữ riêng của salon đã được lưu.",
      href: `${dashboardBase}/no-show-protection`,
    },
    {
      id: "communications",
      required: true,
      checkIds: ["fallback-channel", "notification-language"],
      titleEn: "Language, notifications, and consent",
      titleVi: "Ngôn ngữ, thông báo và đồng ý nhận tin",
      reasonEn:
        "Transactional messages need a verified fallback, the right language, and owner-approved consent rules.",
      reasonVi:
        "Thông báo giao dịch cần kênh dự phòng đã xác minh, đúng ngôn ngữ và quy định đồng ý nhận tin được chủ salon duyệt.",
      validationEn:
        "Passes when email fallback is verified and EN or VI is saved as default. The final Go-Live review separately records the owner's OTP/consent decision.",
      validationVi:
        "Đạt khi email dự phòng đã xác minh và EN hoặc VI được lưu mặc định. Bước Go-Live cuối sẽ ghi nhận riêng quyết định OTP/đồng ý nhận tin của chủ salon.",
      completeEn:
        "Communication fallback and default language are complete.",
      completeVi:
        "Kênh dự phòng và ngôn ngữ mặc định đã hoàn tất.",
      href: `${settingsBase}?section=notifications`,
    },
    {
      id: "integrations",
      required: false,
      checkIds: ["optional-integrations"],
      titleEn: "Payments and AI",
      titleVi: "Thanh toán và AI",
      reasonEn:
        "Connect only the paid capabilities this salon has chosen to use.",
      reasonVi: "Chỉ kết nối những chức năng trả phí mà salon đã chọn sử dụng.",
      validationEn:
        "Optional. A selected Square or Stripe provider, or enabled AI Voice, is shown as selected and never blocks core setup; provider credentials still need their own verification.",
      validationVi:
        "Không bắt buộc. Square hoặc Stripe đã chọn, hoặc AI Voice đã bật, sẽ hiện là đã chọn và không bao giờ chặn thiết lập cốt lõi; credential của nhà cung cấp vẫn cần được kiểm tra riêng.",
      completeEn:
        "An optional payment provider is selected or AI Voice is enabled.",
      completeVi:
        "Đã chọn nhà cung cấp thanh toán không bắt buộc hoặc bật AI Voice.",
      href: `${settingsBase}?section=integrations`,
    },
    {
      id: "booking-preview",
      required: true,
      checkIds: ["public-booking", "human-approval"],
      titleEn: "Preview and live rehearsal",
      titleVi: "Xem trước và chạy thử",
      reasonEn:
        "A real human must confirm the customer page and front-desk flow work together before launch.",
      reasonVi:
        "Người thật phải xác nhận trang khách và luồng tiếp tân hoạt động cùng nhau trước khi ra mắt.",
      validationEn:
        "Passes only when the public booking gate is valid and an authorized human records the rehearsal in Go-Live Readiness.",
      validationVi:
        "Chỉ đạt khi điều kiện đặt lịch công khai hợp lệ và người có quyền ghi nhận lần chạy thử trong Go-Live Readiness.",
      completeEn:
        "The public booking gate and authorized rehearsal both pass.",
      completeVi:
        "Điều kiện đặt lịch công khai và lần chạy thử được phê duyệt đều đạt.",
      href: `${setupBase}/preview`,
    },
    {
      id: "go-live",
      required: true,
      checkIds: [
        "hours-confirmation",
        "otp-policy",
        "owner-approval",
      ],
      titleEn: "Go-Live Readiness",
      titleVi: "Sẵn sàng hoạt động",
      reasonEn:
        "The owner makes the final decision against the exact configuration that was reviewed.",
      reasonVi:
        "Chủ salon đưa ra quyết định cuối cùng dựa trên đúng cấu hình đã được kiểm tra.",
      validationEn:
        "Passes only when every prerequisite is complete and the Owner approves the current readiness snapshot.",
      validationVi:
        "Chỉ đạt khi mọi điều kiện tiên quyết hoàn tất và Owner phê duyệt đúng bản cấu hình readiness hiện tại.",
      completeEn: "The Owner approved the current readiness configuration.",
      completeVi: "Owner đã phê duyệt cấu hình readiness hiện tại.",
      href: `${settingsBase}/readiness`,
    },
  ];

  const steps: GuidedSetupStep[] = definitions.map(
    ({ checkIds, completeEn, completeVi, ...definition }) => {
      const done = checksPass(readiness, checkIds);
      const selected = checkIds.some(
        (id) => findCheck(readiness, id)?.selected === true,
      );
      return {
        ...definition,
        done,
        selected,
        detailEn: done
          ? completeEn
          : firstIncompleteDetail(
              readiness,
              checkIds,
              "en",
              definition.validationEn,
            ),
        detailVi: done
          ? completeVi
          : firstIncompleteDetail(
              readiness,
              checkIds,
              "vi",
              definition.validationVi,
            ),
      };
    },
  );

  const requiredSteps = steps.filter((step) => step.required);
  const completedCount = requiredSteps.filter((step) => step.done).length;
  const nextStep = steps.find((step) => step.required && !step.done) ?? null;
  const nextIndex = nextStep ? steps.indexOf(nextStep) : steps.length - 1;
  const complete = nextStep === null && readiness.approvedForGoLive;

  return {
    steps,
    completedCount,
    requiredCount: requiredSteps.length,
    percent: Math.round((completedCount / requiredSteps.length) * 100),
    currentStepNumber: Math.max(1, nextIndex + 1),
    totalStepCount: steps.length,
    nextStep,
    complete,
  };
}
