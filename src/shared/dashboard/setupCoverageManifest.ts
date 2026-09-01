export const SETUP_CAPABILITY_IDS = [
  "salon_profile",
  "business_hours",
  "staff_access",
  "service_catalog",
  "resource_capacity",
  "multi_service",
  "group_booking",
  "waitlist_walkin",
  "customer_identity_otp",
  "booking_policies",
  "communications",
  "payments_checkout",
  "ai_automation",
  "reporting_alerts",
  "safe_preview_go_live",
] as const;

export type SetupCapabilityId = (typeof SETUP_CAPABILITY_IDS)[number];

/**
 * Coverage is deliberately distinct from runtime readiness. A capability can
 * be configured OFF (or explicitly declined) without being active, while a
 * provider-backed capability can remain blocked even after the owner selects
 * it. The existing Go-Live Readiness contract remains the launch authority.
 */
export type SetupCapabilityState =
  | "configured_on"
  | "configured_off"
  | "not_using"
  | "not_configured"
  | "blocked"
  | "needs_approval";

export type SetupCapabilityRequirement =
  "required_on" | "explicit_decision" | "owner_approval";

export type SetupCapabilityRisk = "standard" | "operational" | "sensitive";

export type SetupCapabilityDefinition = {
  id: SetupCapabilityId;
  titleEn: string;
  titleVi: string;
  requirement: SetupCapabilityRequirement;
  risk: SetupCapabilityRisk;
};

export type SetupCapabilityEvidence = {
  id: SetupCapabilityId;
  state: SetupCapabilityState;
  detailEn: string;
  detailVi: string;
};

export type SetupCoverageItem = SetupCapabilityDefinition &
  SetupCapabilityEvidence & {
    resolved: boolean;
  };

export type SetupCoverageManifest = {
  items: SetupCoverageItem[];
  resolvedCount: number;
  totalCount: number;
  percent: number;
  complete: boolean;
  nextCapability: SetupCoverageItem | null;
  configuredOnCount: number;
  configuredOffCount: number;
  notUsingCount: number;
  notConfiguredCount: number;
  blockedCount: number;
  needsApprovalCount: number;
};

/**
 * One ordered catalogue for both first-run setup and the future Change
 * Concierge. The order intentionally establishes the salon's operating model
 * before optional automation or provider-backed capabilities.
 */
export const SETUP_CAPABILITY_DEFINITIONS: readonly SetupCapabilityDefinition[] =
  [
    {
      id: "salon_profile",
      titleEn: "Salon profile and business type",
      titleVi: "Thông tin và loại hình salon",
      requirement: "required_on",
      risk: "standard",
    },
    {
      id: "business_hours",
      titleEn: "Business hours and closed days",
      titleVi: "Giờ mở cửa và ngày nghỉ",
      requirement: "required_on",
      risk: "operational",
    },
    {
      id: "staff_access",
      titleEn: "Staff, skills, and access",
      titleVi: "Nhân viên, kỹ năng và quyền truy cập",
      requirement: "required_on",
      risk: "sensitive",
    },
    {
      id: "service_catalog",
      titleEn: "Services, prices, and duration",
      titleVi: "Dịch vụ, giá và thời lượng",
      requirement: "required_on",
      risk: "sensitive",
    },
    {
      id: "resource_capacity",
      titleEn: "Chairs, beds, rooms, and capacity",
      titleVi: "Ghế, giường, phòng và sức chứa",
      requirement: "explicit_decision",
      risk: "operational",
    },
    {
      id: "multi_service",
      titleEn: "Sequential and parallel services",
      titleVi: "Dịch vụ nối tiếp và song song",
      requirement: "explicit_decision",
      risk: "operational",
    },
    {
      id: "group_booking",
      titleEn: "Group booking and waves",
      titleVi: "Booking nhóm và chia lượt",
      requirement: "explicit_decision",
      risk: "operational",
    },
    {
      id: "waitlist_walkin",
      titleEn: "Waitlist, walk-ins, and queue",
      titleVi: "Danh sách chờ, khách vãng lai và hàng đợi",
      requirement: "explicit_decision",
      risk: "operational",
    },
    {
      id: "customer_identity_otp",
      titleEn: "Customer identity and OTP",
      titleVi: "Nhận diện khách và OTP",
      requirement: "explicit_decision",
      risk: "sensitive",
    },
    {
      id: "booking_policies",
      titleEn: "Booking, cancellation, and no-show policies",
      titleVi: "Chính sách đặt, huỷ và no-show",
      requirement: "required_on",
      risk: "sensitive",
    },
    {
      id: "communications",
      titleEn: "Email, SMS, reminders, and consent",
      titleVi: "Email, SMS, nhắc lịch và đồng ý nhận tin",
      requirement: "explicit_decision",
      risk: "sensitive",
    },
    {
      id: "payments_checkout",
      titleEn: "Payments, deposits, and checkout",
      titleVi: "Thanh toán, tiền cọc và checkout",
      requirement: "explicit_decision",
      risk: "sensitive",
    },
    {
      id: "ai_automation",
      titleEn: "AI assistance and automation level",
      titleVi: "AI hỗ trợ và mức tự động hoá",
      requirement: "explicit_decision",
      risk: "sensitive",
    },
    {
      id: "reporting_alerts",
      titleEn: "Reports, briefs, and operational alerts",
      titleVi: "Báo cáo, bản tin và cảnh báo vận hành",
      requirement: "explicit_decision",
      risk: "standard",
    },
    {
      id: "safe_preview_go_live",
      titleEn: "Safe preview and Go-Live approval",
      titleVi: "Xem thử an toàn và phê duyệt Go-Live",
      requirement: "owner_approval",
      risk: "sensitive",
    },
  ];

function isResolved(
  requirement: SetupCapabilityRequirement,
  state: SetupCapabilityState,
): boolean {
  if (requirement === "required_on" || requirement === "owner_approval") {
    return state === "configured_on";
  }

  return (
    state === "configured_on" ||
    state === "configured_off" ||
    state === "not_using"
  );
}

function defaultEvidence(
  definition: SetupCapabilityDefinition,
): SetupCapabilityEvidence {
  return {
    id: definition.id,
    state: "not_configured",
    detailEn: "No saved setup decision or verified evidence yet.",
    detailVi: "Chưa có lựa chọn thiết lập hoặc bằng chứng đã xác minh.",
  };
}

function countState(
  items: SetupCoverageItem[],
  state: SetupCapabilityState,
): number {
  return items.filter((item) => item.state === state).length;
}

/**
 * Produces a complete manifest even when evidence is partial. Missing evidence
 * becomes `not_configured`, so neither an AI conversation nor a legacy setup
 * screen can silently skip a NailIQ capability.
 */
export function deriveSetupCoverageManifest(
  evidence: readonly SetupCapabilityEvidence[],
): SetupCoverageManifest {
  const evidenceById = new Map<SetupCapabilityId, SetupCapabilityEvidence>();

  for (const item of evidence) {
    if (evidenceById.has(item.id)) {
      throw new Error(`Duplicate setup capability evidence: ${item.id}`);
    }
    evidenceById.set(item.id, item);
  }

  const items = SETUP_CAPABILITY_DEFINITIONS.map((definition) => {
    const itemEvidence =
      evidenceById.get(definition.id) ?? defaultEvidence(definition);
    return {
      ...definition,
      ...itemEvidence,
      resolved: isResolved(definition.requirement, itemEvidence.state),
    } satisfies SetupCoverageItem;
  });

  const resolvedCount = items.filter((item) => item.resolved).length;
  const totalCount = items.length;

  return {
    items,
    resolvedCount,
    totalCount,
    percent: Math.round((resolvedCount / totalCount) * 100),
    complete: resolvedCount === totalCount,
    nextCapability: items.find((item) => !item.resolved) ?? null,
    configuredOnCount: countState(items, "configured_on"),
    configuredOffCount: countState(items, "configured_off"),
    notUsingCount: countState(items, "not_using"),
    notConfiguredCount: countState(items, "not_configured"),
    blockedCount: countState(items, "blocked"),
    needsApprovalCount: countState(items, "needs_approval"),
  };
}
