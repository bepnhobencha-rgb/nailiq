"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  inviteStaffAccess,
  changeStaffAccessRole,
  revokeStaffAccess,
  type StaffAccessInfo,
  type StaffAccessRole,
} from "@/shared/dashboard/staffAccess";

// Bilingual labels colocated with the component (small, self-contained set).
const COPY = {
  en: {
    noLogin: "No login",
    inviteCta: "Invite to log in",
    owner: "Owner · full access",
    admin: "Admin",
    frontDesk: "Front-desk",
    pending: "invite pending",
    active: "active",
    emailPlaceholder: "staff@example.com",
    roleAdmin: "Admin (manage staff & settings)",
    roleReceptionist: "Front-desk (bookings only)",
    send: "Send invite",
    cancel: "Cancel",
    changeRole: "Change role",
    revoke: "Remove access",
    revokeConfirm: "Remove this person's login? Their staff profile and bookings stay.",
    sent: "Invite sent — they'll get an email to set a password",
    added: "Account linked",
    saved: "Updated",
    removed: "Login removed",
    emailRequired: "Enter an email",
    error: "Something went wrong",
  },
  vi: {
    noLogin: "Chưa có đăng nhập",
    inviteCta: "Mời đăng nhập",
    owner: "Chủ tiệm · toàn quyền",
    admin: "Quản trị",
    frontDesk: "Tiếp tân",
    pending: "chờ xác nhận lời mời",
    active: "đang hoạt động",
    emailPlaceholder: "nhanvien@example.com",
    roleAdmin: "Quản trị (quản lý nhân viên & cài đặt)",
    roleReceptionist: "Tiếp tân (chỉ lịch hẹn)",
    send: "Gửi lời mời",
    cancel: "Huỷ",
    changeRole: "Đổi quyền",
    revoke: "Gỡ đăng nhập",
    revokeConfirm: "Gỡ đăng nhập của người này? Hồ sơ thợ và lịch hẹn vẫn giữ nguyên.",
    sent: "Đã gửi lời mời — họ sẽ nhận email để đặt mật khẩu",
    added: "Đã liên kết tài khoản",
    saved: "Đã cập nhật",
    removed: "Đã gỡ đăng nhập",
    emailRequired: "Nhập email",
    error: "Có lỗi xảy ra",
  },
} as const;

export function StaffAccessControl({
  slug,
  staffId,
  access,
  currentUserRole,
  onToast,
}: {
  slug: string;
  staffId: string;
  /** null = bookable provider with no login yet. */
  access: StaffAccessInfo | null;
  /** Caller's own role — only an owner may grant/keep `admin`. */
  currentUserRole: "owner" | "admin" | "receptionist" | string;
  onToast?: (msg: string, kind: "success" | "error") => void;
}) {
  const { language } = useUserLanguage();
  const t = COPY[language === "vi" ? "vi" : "en"];
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffAccessRole>("receptionist");

  const isOwnerAccount = access?.role === "owner";
  const canGrantAdmin = currentUserRole === "owner";

  const notify = (msg: string, kind: "success" | "error") => {
    if (onToast) onToast(msg, kind);
  };

  const handleInvite = () => {
    if (!email.trim()) {
      notify(t.emailRequired, "error");
      return;
    }
    startTransition(async () => {
      const res = await inviteStaffAccess(slug, staffId, {
        email: email.trim(),
        role,
      });
      if (res.ok) {
        notify(res.invited ? t.sent : t.added, "success");
        setInviting(false);
        setEmail("");
        setRole("receptionist");
        router.refresh();
      } else {
        notify(res.error || t.error, "error");
      }
    });
  };

  const handleChangeRole = () => {
    const next: StaffAccessRole =
      access?.role === "admin" ? "receptionist" : "admin";
    startTransition(async () => {
      const res = await changeStaffAccessRole(slug, staffId, next);
      if (res.ok) {
        notify(t.saved, "success");
        router.refresh();
      } else {
        notify(res.error || t.error, "error");
      }
    });
  };

  const handleRevoke = () => {
    if (typeof window !== "undefined" && !window.confirm(t.revokeConfirm)) return;
    startTransition(async () => {
      const res = await revokeStaffAccess(slug, staffId);
      if (res.ok) {
        notify(t.removed, "success");
        router.refresh();
      } else {
        notify(res.error || t.error, "error");
      }
    });
  };

  // ── Has a login account ───────────────────────────────────────────────────
  if (access) {
    const label =
      access.role === "owner"
        ? t.owner
        : access.role === "admin"
          ? t.admin
          : t.frontDesk;
    return (
      <div className="flex flex-wrap items-center gap-2 pl-10 pb-3 text-xs">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold",
            isOwnerAccount
              ? "border-nq-primary/40 bg-nq-primary/10 text-nq-primary"
              : "border-nq-success/40 bg-nq-success/10 text-nq-success",
          )}
        >
          🔑 {label}
        </span>
        {access.email && (
          <span className="text-nq-muted truncate max-w-[160px]">
            {access.email}
          </span>
        )}
        <span className={access.active ? "text-nq-muted" : "text-nq-warning"}>
          · {access.active ? t.active : t.pending}
        </span>
        {!isOwnerAccount && (
          <span className="flex items-center gap-2">
            {/* Only show role toggle if it won't require admin without owner rights */}
            {(access.role === "admin" || canGrantAdmin) && (
              <button
                type="button"
                disabled={pending}
                onClick={handleChangeRole}
                className="rounded-md px-2 py-0.5 text-nq-primary hover:bg-nq-primary/10 disabled:opacity-50"
              >
                {t.changeRole}
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={handleRevoke}
              className="rounded-md px-2 py-0.5 text-nq-error hover:bg-nq-error/10 disabled:opacity-50"
            >
              {t.revoke}
            </button>
          </span>
        )}
      </div>
    );
  }

  // ── No login yet ──────────────────────────────────────────────────────────
  return (
    <div className="pl-10 pb-3 text-xs">
      {!inviting ? (
        <span className="flex items-center gap-2">
          <span className="text-nq-muted">— {t.noLogin}</span>
          <button
            type="button"
            disabled={pending}
            onClick={() => setInviting(true)}
            className="rounded-md px-2 py-0.5 text-nq-primary hover:bg-nq-primary/10 disabled:opacity-50"
          >
            {t.inviteCta}
          </button>
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            value={email}
            placeholder={t.emailPlaceholder}
            disabled={pending}
            onChange={(e) => setEmail(e.target.value)}
            className="min-w-[180px] flex-1 rounded-lg border border-nq-border/50 bg-nq-bg px-2 py-1 text-nq-foreground"
          />
          <select
            value={role}
            disabled={pending}
            onChange={(e) => setRole(e.target.value as StaffAccessRole)}
            className="rounded-lg border border-nq-border/50 bg-nq-bg px-2 py-1 text-nq-foreground"
          >
            <option value="receptionist">{t.roleReceptionist}</option>
            {canGrantAdmin && <option value="admin">{t.roleAdmin}</option>}
          </select>
          <button
            type="button"
            disabled={pending}
            onClick={handleInvite}
            className="rounded-lg bg-nq-primary px-3 py-1 font-semibold text-nq-on-primary disabled:opacity-50"
          >
            {pending ? "…" : t.send}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setInviting(false);
              setEmail("");
            }}
            className="rounded-lg px-2 py-1 text-nq-muted hover:bg-nq-surface disabled:opacity-50"
          >
            {t.cancel}
          </button>
        </div>
      )}
    </div>
  );
}
