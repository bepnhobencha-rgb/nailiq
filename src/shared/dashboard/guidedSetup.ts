import type {
  GoLiveReadiness,
  GoLiveReadinessCheck,
} from "@/shared/dashboard/goLiveReadiness";

export type GuidedSetupStepId =
  | "identity"
  | "schedule"
  | "staff"
  | "catalog"
  | "go-live";

export type GuidedSetupStep = {
  id: GuidedSetupStepId;
  done: boolean;
  titleEn: string;
  titleVi: string;
  detailEn: string;
  detailVi: string;
  href: string;
};

export type GuidedSetupProgress = {
  steps: GuidedSetupStep[];
  completedCount: number;
  totalCount: number;
  percent: number;
  currentStepNumber: number;
  nextStep: GuidedSetupStep | null;
  complete: boolean;
};

const CORE_ORDER = ["identity", "schedule", "staff", "catalog"] as const;

const FALLBACK_COPY: Record<
  (typeof CORE_ORDER)[number],
  Pick<GuidedSetupStep, "titleEn" | "titleVi" | "detailEn" | "detailVi">
> = {
  identity: {
    titleEn: "Salon information",
    titleVi: "Thông tin salon",
    detailEn: "Add the salon address, phone, and timezone.",
    detailVi: "Thêm địa chỉ, số điện thoại và múi giờ của salon.",
  },
  schedule: {
    titleEn: "Business hours",
    titleVi: "Giờ mở cửa",
    detailEn: "Set the days and hours when customers can book.",
    detailVi: "Chọn ngày và giờ khách có thể đặt lịch.",
  },
  staff: {
    titleEn: "Staff",
    titleVi: "Nhân viên",
    detailEn: "Add at least one staff member who can take bookings.",
    detailVi: "Thêm ít nhất một nhân viên có thể nhận lịch.",
  },
  catalog: {
    titleEn: "Services",
    titleVi: "Dịch vụ",
    detailEn: "Add services with a valid price and duration.",
    detailVi: "Thêm dịch vụ với giá và thời lượng hợp lệ.",
  },
};

function findCheck(
  readiness: GoLiveReadiness,
  id: (typeof CORE_ORDER)[number],
): GoLiveReadinessCheck | undefined {
  return readiness.checks.find((check) => check.id === id);
}

export function deriveGuidedSetupProgress(
  slug: string,
  readiness: GoLiveReadiness,
): GuidedSetupProgress {
  const encodedSlug = encodeURIComponent(slug);
  const setupBase = `/dashboard/${encodedSlug}/setup`;
  const fallbackHref: Record<(typeof CORE_ORDER)[number], string> = {
    identity: `${setupBase}/address`,
    schedule: `${setupBase}/hours`,
    staff: `${setupBase}/staff`,
    catalog: `${setupBase}/services`,
  };

  const coreSteps: GuidedSetupStep[] = CORE_ORDER.map((id) => {
    const check = findCheck(readiness, id);
    const copy = FALLBACK_COPY[id];
    return {
      id,
      done: check?.state === "pass",
      titleEn: check?.titleEn ?? copy.titleEn,
      titleVi: check?.titleVi ?? copy.titleVi,
      detailEn: check?.detailEn ?? copy.detailEn,
      detailVi: check?.detailVi ?? copy.detailVi,
      href: check?.href ?? fallbackHref[id],
    };
  });

  const reviewStep: GuidedSetupStep = {
    id: "go-live",
    done: readiness.approvedForGoLive,
    titleEn: "Final review",
    titleVi: "Kiểm tra cuối cùng",
    detailEn: readiness.readyForManualReview
      ? "Review the booking page and confirm the salon is ready to go live."
      : "Complete the required setup before the final review.",
    detailVi: readiness.readyForManualReview
      ? "Xem lại trang đặt lịch và xác nhận salon đã sẵn sàng hoạt động."
      : "Hoàn tất các bước bắt buộc trước khi kiểm tra cuối cùng.",
    href: `/dashboard/${encodedSlug}/settings/readiness`,
  };

  const steps = [...coreSteps, reviewStep];
  const completedCount = steps.filter((step) => step.done).length;
  const nextStep = steps.find((step) => !step.done) ?? null;
  const nextIndex = nextStep ? steps.indexOf(nextStep) : steps.length - 1;

  return {
    steps,
    completedCount,
    totalCount: steps.length,
    percent: Math.round((completedCount / steps.length) * 100),
    currentStepNumber: Math.max(1, nextIndex + 1),
    nextStep,
    complete: readiness.approvedForGoLive,
  };
}
