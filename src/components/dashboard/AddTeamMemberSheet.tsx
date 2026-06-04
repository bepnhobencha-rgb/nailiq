"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  addTeamMember,
  type StaffAccessRole,
} from "@/shared/dashboard/staffAccess";

const COPY = {
  en: {
    title: "Add team member",
    name: "Name",
    namePlaceholder: "e.g. Hùng Nguyễn",
    takesBookings: "Takes bookings?",
    takesBookingsHint: "Shows in the booking flow as a service provider",
    jobRole: "Provider role",
    senior: "Senior tech",
    nailTech: "Nail tech",
    canLogin: "Can log into the app?",
    canLoginHint: "Sends an email invite to set a password",
    permission: "Permission",
    admin: "Admin — manage staff & settings",
    receptionist: "Front-desk — bookings only",
    email: "Email",
    emailPlaceholder: "staff@example.com",
    create: "Create",
    createInvite: "Create & invite",
    cancel: "Cancel",
    nameRequired: "Enter a name",
    emailRequired: "Enter an email to send the invite",
    createdInvited: "Member added — invite email sent",
    created: "Member added",
    partialInvite: "Member added, but the invite didn't send",
    error: "Something went wrong",
  },
  vi: {
    title: "Thêm nhân viên",
    name: "Tên",
    namePlaceholder: "vd: Hùng Nguyễn",
    takesBookings: "Nhận lịch hẹn?",
    takesBookingsHint: "Hiện trong luồng đặt lịch như một thợ làm dịch vụ",
    jobRole: "Loại thợ",
    senior: "Thợ chính",
    nailTech: "Thợ phụ",
    canLogin: "Cho đăng nhập app?",
    canLoginHint: "Gửi email mời để đặt mật khẩu",
    permission: "Quyền",
    admin: "Quản trị — quản lý nhân viên & cài đặt",
    receptionist: "Tiếp tân — chỉ lịch hẹn",
    email: "Email",
    emailPlaceholder: "nhanvien@example.com",
    create: "Tạo",
    createInvite: "Tạo & mời",
    cancel: "Huỷ",
    nameRequired: "Nhập tên",
    emailRequired: "Nhập email để gửi lời mời",
    createdInvited: "Đã thêm nhân viên — đã gửi email mời",
    created: "Đã thêm nhân viên",
    partialInvite: "Đã thêm nhân viên, nhưng lời mời chưa gửi được",
    error: "Có lỗi xảy ra",
  },
} as const;

function Toggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50",
        on ? "bg-nq-primary" : "bg-nq-border",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform",
          on ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function AddTeamMemberSheet({
  slug,
  currentUserRole,
  isOpen,
  onClose,
  onToast,
}: {
  slug: string;
  currentUserRole: string;
  isOpen: boolean;
  onClose: () => void;
  onToast: (msg: string, kind: "success" | "error") => void;
}) {
  const { language } = useUserLanguage();
  const t = COPY[language === "vi" ? "vi" : "en"];
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState("");
  const [takesBookings, setTakesBookings] = useState(true);
  const [jobRole, setJobRole] = useState<"senior" | "nail_tech">("nail_tech");
  const [grantAccess, setGrantAccess] = useState(false);
  const [accessRole, setAccessRole] = useState<StaffAccessRole>("receptionist");
  const [email, setEmail] = useState("");

  const canGrantAdmin = currentUserRole === "owner";

  if (!isOpen) return null;

  const reset = () => {
    setName("");
    setTakesBookings(true);
    setJobRole("nail_tech");
    setGrantAccess(false);
    setAccessRole("receptionist");
    setEmail("");
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = () => {
    if (!name.trim()) {
      onToast(t.nameRequired, "error");
      return;
    }
    if (grantAccess && !email.trim()) {
      onToast(t.emailRequired, "error");
      return;
    }
    startTransition(async () => {
      const res = await addTeamMember(slug, {
        name: name.trim(),
        takesBookings,
        jobRole,
        grantAccess,
        accessRole,
        email: email.trim(),
      });
      if (res.ok) {
        onToast(res.invited ? t.createdInvited : t.created, "success");
        router.refresh();
        close();
      } else if (res.staffCreated) {
        // Member exists but invite failed — close + refresh, warn precisely.
        onToast(`${t.partialInvite}: ${res.error}`, "error");
        router.refresh();
        close();
      } else {
        onToast(res.error || t.error, "error");
      }
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={close}
    >
      <div
        className="w-full max-w-md rounded-t-2xl border border-nq-border/50 bg-nq-surface p-5 shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-nq-foreground">
          {t.title}
        </h2>

        {/* Name */}
        <label className="mb-4 block">
          <span className="mb-1 block text-sm font-medium text-nq-muted">
            {t.name}
          </span>
          <input
            type="text"
            value={name}
            placeholder={t.namePlaceholder}
            disabled={pending}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-xl border border-nq-border/50 bg-nq-bg px-3 py-2 text-nq-foreground"
          />
        </label>

        {/* Takes bookings */}
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-nq-border/30 bg-nq-bg/50 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-nq-foreground">
              📅 {t.takesBookings}
            </p>
            <p className="text-xs text-nq-muted">{t.takesBookingsHint}</p>
          </div>
          <Toggle on={takesBookings} disabled={pending} onChange={setTakesBookings} />
        </div>
        {takesBookings && (
          <select
            value={jobRole}
            disabled={pending}
            onChange={(e) => setJobRole(e.target.value as "senior" | "nail_tech")}
            className="mb-3 w-full rounded-xl border border-nq-border/50 bg-nq-bg px-3 py-2 text-sm text-nq-foreground"
          >
            <option value="nail_tech">{t.nailTech}</option>
            <option value="senior">{t.senior}</option>
          </select>
        )}

        {/* Can log in */}
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-nq-border/30 bg-nq-bg/50 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-nq-foreground">
              🔑 {t.canLogin}
            </p>
            <p className="text-xs text-nq-muted">{t.canLoginHint}</p>
          </div>
          <Toggle on={grantAccess} disabled={pending} onChange={setGrantAccess} />
        </div>
        {grantAccess && (
          <div className="mb-3 space-y-2">
            <select
              value={accessRole}
              disabled={pending}
              onChange={(e) => setAccessRole(e.target.value as StaffAccessRole)}
              className="w-full rounded-xl border border-nq-border/50 bg-nq-bg px-3 py-2 text-sm text-nq-foreground"
            >
              <option value="receptionist">{t.receptionist}</option>
              {canGrantAdmin && <option value="admin">{t.admin}</option>}
            </select>
            <input
              type="email"
              value={email}
              placeholder={t.emailPlaceholder}
              disabled={pending}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl border border-nq-border/50 bg-nq-bg px-3 py-2 text-sm text-nq-foreground"
            />
          </div>
        )}

        {/* Actions */}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={submit}
            className="flex-1 rounded-xl bg-nq-primary px-4 py-2.5 font-semibold text-nq-on-primary disabled:opacity-50"
          >
            {pending ? "…" : grantAccess ? t.createInvite : t.create}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={close}
            className="rounded-xl border border-nq-border/50 px-4 py-2.5 text-nq-muted hover:bg-nq-bg disabled:opacity-50"
          >
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
