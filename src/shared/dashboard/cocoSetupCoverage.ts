import type { GoLiveReadiness } from "@/shared/dashboard/goLiveReadiness";
import {
  deriveSetupCoverageManifest,
  type SetupCapabilityEvidence,
  type SetupCapabilityId,
  type SetupCapabilityState,
  type SetupCoverageManifest,
} from "@/shared/dashboard/setupCoverageManifest";

export const COCO_SETUP_DECISIONS_FLAG = "coco_setup_decisions" as const;

export type CocoSetupDecisionState = "configured_off" | "not_using";

export type CocoSetupCoverageInput = {
  readiness: GoLiveReadiness;
  featureFlags: unknown;
  resourcesEnabled: boolean | null;
  phoneOtpEnabled: boolean;
  paymentProvider: unknown;
  voiceAiEnabled: boolean;
  optionalIntegrationsSkipped: boolean;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function decisionFor(
  flags: Record<string, unknown>,
  id: SetupCapabilityId,
): CocoSetupDecisionState | null {
  const value = record(flags[COCO_SETUP_DECISIONS_FLAG])[id];
  return value === "configured_off" || value === "not_using" ? value : null;
}

function hasOwnBoolean(
  flags: Record<string, unknown>,
  key: string,
): boolean | null {
  if (!Object.prototype.hasOwnProperty.call(flags, key)) return null;
  return typeof flags[key] === "boolean" ? (flags[key] as boolean) : null;
}

function checksById(readiness: GoLiveReadiness): Map<string, GoLiveReadiness["checks"][number]> {
  return new Map(readiness.checks.map((check) => [check.id, check]));
}

function evidence(
  id: SetupCapabilityId,
  state: SetupCapabilityState,
  detailEn: string,
  detailVi: string,
): SetupCapabilityEvidence {
  return { id, state, detailEn, detailVi };
}

function requiredFromChecks(
  checks: Map<string, GoLiveReadiness["checks"][number]>,
  id: SetupCapabilityId,
  checkIds: string[],
  readyEn: string,
  readyVi: string,
): SetupCapabilityEvidence {
  const selected = checkIds.map((checkId) => checks.get(checkId));
  if (selected.every((check) => check?.state === "pass")) {
    return evidence(id, "configured_on", readyEn, readyVi);
  }
  const first = selected.find((check) => check?.state !== "pass");
  return evidence(
    id,
    first?.state === "review" ? "needs_approval" : "not_configured",
    first?.detailEn ?? "Setup evidence is not available yet.",
    first?.detailVi ?? "Chưa có bằng chứng thiết lập.",
  );
}

function optionalDecision(
  flags: Record<string, unknown>,
  id: SetupCapabilityId,
  on: boolean,
  readyEn: string,
  readyVi: string,
): SetupCapabilityEvidence {
  if (on) return evidence(id, "configured_on", readyEn, readyVi);
  const decision = decisionFor(flags, id);
  if (decision) {
    return evidence(
      id,
      decision,
      decision === "not_using"
        ? "The owner chose not to use this capability for now."
        : "The owner explicitly chose to keep this capability off.",
      decision === "not_using"
        ? "Chủ salon chọn chưa sử dụng chức năng này."
        : "Chủ salon đã chọn giữ chức năng này ở trạng thái tắt.",
    );
  }
  return evidence(
    id,
    "not_configured",
    "Coco still needs the owner's use-or-skip decision.",
    "Coco vẫn cần chủ salon chọn sử dụng hay bỏ qua.",
  );
}

export function deriveCocoSetupCoverage(
  input: CocoSetupCoverageInput,
): SetupCoverageManifest {
  const checks = checksById(input.readiness);
  const flags = record(input.featureFlags);
  const multiService = hasOwnBoolean(flags, "multi_service_booking_enabled");
  const groupBooking = hasOwnBoolean(flags, "group_booking_enabled");
  const walkin = hasOwnBoolean(flags, "walkin_queue_enabled");
  const waitlistAttention = hasOwnBoolean(flags, "waitlist_attention_enabled");
  const aiText = hasOwnBoolean(flags, "ai_text_receptionist_enabled");
  const aiControl = hasOwnBoolean(flags, "ai_control_center_enabled");
  const reports = hasOwnBoolean(flags, "reports_enabled");
  const policyReady = checks.get("booking-policy")?.state === "pass";
  const sequenceReady = checks.get("multi_service_sequence")?.state === "pass";
  const ownerApproved = checks.get("owner-approval")?.state === "pass";
  const previewApproved = checks.get("human-approval")?.state === "pass";

  const items: SetupCapabilityEvidence[] = [
    requiredFromChecks(
      checks,
      "salon_profile",
      ["identity"],
      "Salon profile and timezone are verified.",
      "Thông tin salon và múi giờ đã được xác minh.",
    ),
    requiredFromChecks(
      checks,
      "business_hours",
      ["schedule"],
      "Business hours and closed days are verified.",
      "Giờ mở cửa và ngày nghỉ đã được xác minh.",
    ),
    requiredFromChecks(
      checks,
      "staff_access",
      ["staff"],
      "Bookable staff and access are verified.",
      "Nhân viên nhận lịch và quyền truy cập đã được xác minh.",
    ),
    requiredFromChecks(
      checks,
      "service_catalog",
      ["catalog"],
      "Services, prices, duration, and staff coverage are verified.",
      "Dịch vụ, giá, thời lượng và nhân viên thực hiện đã được xác minh.",
    ),
    optionalDecision(
      flags,
      "resource_capacity",
      input.resourcesEnabled === true,
      "Chair, bed, room, and capacity scheduling is on.",
      "Phân lịch theo ghế, giường, phòng và sức chứa đang bật.",
    ),
    multiService === true && !sequenceReady
      ? evidence(
          "multi_service",
          "blocked",
          "Multi-service is selected but its sequence and capacity proof is not ready.",
          "Đã chọn nhiều dịch vụ nhưng bằng chứng chuỗi và sức chứa chưa sẵn sàng.",
        )
      : optionalDecision(
          flags,
          "multi_service",
          multiService === true,
          "Sequential or parallel multi-service booking is configured.",
          "Booking nhiều dịch vụ nối tiếp hoặc song song đã được cấu hình.",
        ),
    groupBooking === true && !policyReady
      ? evidence(
          "group_booking",
          "blocked",
          "Group booking is on, but its policy still needs completion.",
          "Booking nhóm đang bật nhưng chính sách nhóm chưa hoàn tất.",
        )
      : optionalDecision(
          flags,
          "group_booking",
          groupBooking === true,
          "Group booking and wave rules are configured.",
          "Booking nhóm và quy tắc chia lượt đã được cấu hình.",
        ),
    optionalDecision(
      flags,
      "waitlist_walkin",
      walkin === true || waitlistAttention === true,
      "Waitlist, walk-in, or queue assistance is configured.",
      "Waitlist, khách vãng lai hoặc hỗ trợ hàng đợi đã được cấu hình.",
    ),
    checks.get("otp-policy")?.state === "pass"
      ? evidence(
          "customer_identity_otp",
          input.phoneOtpEnabled ? "configured_on" : "configured_off",
          input.phoneOtpEnabled
            ? "The owner approved phone OTP and consent policy."
            : "The owner approved keeping phone OTP off.",
          input.phoneOtpEnabled
            ? "Chủ salon đã duyệt OTP điện thoại và chính sách đồng ý nhận tin."
            : "Chủ salon đã duyệt giữ OTP điện thoại ở trạng thái tắt.",
        )
      : evidence(
          "customer_identity_otp",
          "needs_approval",
          "The owner must approve the OTP and consent policy.",
          "Chủ salon cần duyệt chính sách OTP và đồng ý nhận tin.",
        ),
    requiredFromChecks(
      checks,
      "booking_policies",
      ["booking-policy"],
      "Booking, cancellation, and no-show policies are verified.",
      "Chính sách đặt, huỷ và no-show đã được xác minh.",
    ),
    requiredFromChecks(
      checks,
      "communications",
      ["fallback-channel", "notification-language"],
      "Verified fallback and default notification language are configured.",
      "Kênh dự phòng và ngôn ngữ thông báo mặc định đã được cấu hình.",
    ),
    input.paymentProvider === "square" || input.paymentProvider === "stripe"
      ? evidence(
          "payments_checkout",
          "needs_approval",
          "A provider is selected; credentials and a safe test still need verification.",
          "Đã chọn provider; credential và bài kiểm tra an toàn vẫn cần được xác minh.",
        )
      : optionalDecision(
          flags,
          "payments_checkout",
          false,
          "Payment and checkout are configured.",
          "Thanh toán và checkout đã được cấu hình.",
        ),
    input.voiceAiEnabled || aiText === true || aiControl === true
      ? evidence(
          "ai_automation",
          "needs_approval",
          "AI is selected; the owner must approve its exact automation policy.",
          "Đã chọn AI; chủ salon cần duyệt chính xác policy tự động hoá.",
        )
      : optionalDecision(
          flags,
          "ai_automation",
          false,
          "AI automation policy is configured.",
          "Policy tự động hoá AI đã được cấu hình.",
        ),
    optionalDecision(
      flags,
      "reporting_alerts",
      reports === true,
      "Reports and operational alerts are configured.",
      "Báo cáo và cảnh báo vận hành đã được cấu hình.",
    ),
    evidence(
      "safe_preview_go_live",
      ownerApproved && previewApproved ? "configured_on" : "needs_approval",
      ownerApproved && previewApproved
        ? "Safe Preview and final Owner approval are recorded."
        : "Safe Preview and final Owner approval are still required.",
      ownerApproved && previewApproved
        ? "Đã ghi nhận Preview an toàn và phê duyệt cuối của Owner."
        : "Vẫn cần Preview an toàn và phê duyệt cuối của Owner.",
    ),
  ];

  if (input.optionalIntegrationsSkipped) {
    const paymentIndex = items.findIndex((item) => item.id === "payments_checkout");
    if (paymentIndex >= 0 && items[paymentIndex]?.state === "not_configured") {
      items[paymentIndex] = evidence(
        "payments_checkout",
        "not_using",
        "The owner chose to connect payments later.",
        "Chủ salon chọn kết nối thanh toán sau.",
      );
    }
  }

  return deriveSetupCoverageManifest(items);
}
