import type { ApprovalDisplayRow } from "@/shared/ai/approvalRequests";

export type ApprovalDecisionProvenance = {
  channel: string;
  actor: string;
};

export function approvalDecisionProvenance(
  approval: ApprovalDisplayRow,
  language: "en" | "vi",
): ApprovalDecisionProvenance {
  const vi = language === "vi";

  if (approval.status === "expired") {
    return {
      channel: vi ? "Hệ thống tự động" : "System automation",
      actor: vi ? "Không có người quyết định" : "No human decision",
    };
  }

  if (approval.decision_channel === "dashboard") {
    const role = approval.decision_actor?.role;
    const roleLabel =
      role === "owner"
        ? vi
          ? "Chủ tiệm"
          : "Owner"
        : role === "admin"
          ? vi
            ? "Quản trị viên"
            : "Admin"
          : null;
    const actor =
      approval.decision_actor?.label ??
      (vi ? "Chủ tiệm/quản trị viên đã xác thực" : "Authenticated owner/admin");
    return {
      channel: "Dashboard",
      actor: roleLabel ? `${actor} · ${roleLabel}` : actor,
    };
  }

  if (approval.decision_channel === "email_capability") {
    return {
      channel: vi ? "Liên kết email bảo mật" : "Secure email link",
      actor: vi
        ? "Không định danh người bấm liên kết"
        : "Link signer is not identity-attributed",
    };
  }

  return {
    channel: vi ? "Kênh cũ/chưa ghi nhận" : "Legacy/unrecorded channel",
    actor: vi ? "Không có dữ liệu người quyết định" : "No actor data",
  };
}
