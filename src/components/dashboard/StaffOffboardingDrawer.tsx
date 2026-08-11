"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import {
  completeStaffOffboarding,
  loadStaffOffboardingPreview,
  type StaffOffboardingPreview,
} from "@/shared/dashboard/staffOffboardingActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  staffId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onCompleted: (message: string) => void;
};

function formatWhen(iso: string, timezone: string, language: "en" | "vi") {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(language === "vi" ? "vi-CA" : "en-CA", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(iso));
}

export function StaffOffboardingDrawer({
  slug,
  staffId,
  isOpen,
  onClose,
  onCompleted,
}: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [preview, setPreview] = useState<StaffOffboardingPreview | null>(null);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [notifySms, setNotifySms] = useState(false);
  const [revokeAccess, setRevokeAccess] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !staffId) return;
    let alive = true;
    void loadStaffOffboardingPreview(slug, staffId).then((result) => {
      if (!alive) return;
      if (!result.ok) {
        setPreview(null);
        setError(
          vi
            ? "Không tải được lịch của nhân viên. Vui lòng thử lại."
            : "Could not load this staff member's schedule. Try again.",
        );
        return;
      }
      setPreview(result.preview);
      setError(null);
      setNotifyEmail(false);
      setNotifySms(false);
      setRevokeAccess(result.preview.hasLogin && !result.preview.accessIsOwner);
      const suggested: Record<string, string> = {};
      for (const booking of result.preview.bookings) {
        if (booking.candidates.length === 1) {
          suggested[booking.id] = booking.candidates[0]!.id;
        }
      }
      setAssignments(suggested);
    });
    return () => {
      alive = false;
    };
  }, [isOpen, staffId, slug, vi]);

  const activePreview = preview?.staffId === staffId ? preview : null;
  const loading = isOpen && Boolean(staffId) && !activePreview && !error;

  const reassignable = useMemo(
    () =>
      activePreview?.bookings.filter(
        (booking) => booking.status === "pending" || booking.status === "confirmed",
      ) ?? [],
    [activePreview],
  );
  const blockers = useMemo(
    () =>
      activePreview?.bookings.filter(
        (booking) => booking.status === "in_progress" || booking.status === "waiting",
      ) ?? [],
    [activePreview],
  );
  const missingAssignments = reassignable.filter(
    (booking) => !assignments[booking.id],
  );
  const hasNoCandidate = reassignable.some(
    (booking) => booking.candidates.length === 0,
  );
  const commonCandidates = useMemo(() => {
    if (reassignable.length < 2) return [];
    const [first, ...rest] = reassignable;
    return first!.candidates.filter((candidate) =>
      rest.every((booking) =>
        booking.candidates.some((item) => item.id === candidate.id),
      ),
    );
  }, [reassignable]);
  const emailRecipients = reassignable.filter((booking) => booking.hasEmail).length;
  const smsRecipients = reassignable.filter((booking) => booking.hasPhone).length;
  const canComplete =
    Boolean(activePreview) &&
    !activePreview?.accessIsOwner &&
    blockers.length === 0 &&
    !hasNoCandidate &&
    missingAssignments.length === 0 &&
    !saving;

  function errorMessage(code: string): string {
    const copy: Record<string, [string, string]> = {
      owner_access_protected: [
        "Không thể cho tài khoản Chủ tiệm nghỉ việc. Hãy chuyển quyền sở hữu trước.",
        "The owner account cannot be offboarded. Transfer ownership first.",
      ],
      operational_booking_blocked: [
        "Còn khách đang chờ hoặc đang được phục vụ. Hãy hoàn tất ca đó trước.",
        "A guest is waiting or in service. Finish that visit first.",
      ],
      candidate_unavailable: [
        "Lịch vừa thay đổi hoặc thợ thay thế đã bận. Danh sách đã được làm mới.",
        "The schedule changed or the replacement is now busy. Refresh and review.",
      ],
      minimum_active_staff: [
        "Salon phải còn ít nhất một nhân viên đang hoạt động.",
        "The salon must keep at least one active staff member.",
      ],
      access_revoke_failed: [
        "Lịch đã được chuyển nhưng chưa khóa được quyền đăng nhập. Hãy thử lại trước khi hoàn tất.",
        "Appointments moved, but login access could not be revoked. Retry before finishing.",
      ],
      stale_booking: [
        "Một lịch vừa được chỉnh sửa. Hãy đóng và mở lại để kiểm tra dữ liệu mới nhất.",
        "An appointment just changed. Close and reopen to review the latest schedule.",
      ],
      already_inactive: [
        "Nhân viên này đã ở trạng thái Không hoạt động.",
        "This staff member is already inactive.",
      ],
    };
    const pair = copy[code];
    return pair ? pair[vi ? 0 : 1] : vi ? "Không hoàn tất được. Vui lòng thử lại." : "Could not finish. Try again.";
  }

  async function complete() {
    if (!staffId || !canComplete) return;
    setSaving(true);
    setError(null);
    const result = await completeStaffOffboarding(slug, {
      staffId,
      assignments: reassignable.map((booking) => ({
        bookingId: booking.id,
        staffId: assignments[booking.id]!,
      })),
      notifyEmail,
      notifySms,
      revokeAccess,
    });
    setSaving(false);
    if (!result.ok) {
      setError(errorMessage(result.error));
      return;
    }
    const deliveryWarning =
      (notifyEmail || notifySms) && result.notificationsSent === 0
        ? vi
          ? " · chưa gửi được thông báo; vui lòng liên hệ khách thủ công"
          : " · no notice was delivered; contact guests manually"
        : "";
    const message = vi
      ? `Đã cho ${activePreview?.staffName ?? "nhân viên"} nghỉ việc an toàn · chuyển ${result.reassigned} lịch${result.notificationsSent ? ` · gửi ${result.notificationsSent} thông báo` : ""}`
      : `${activePreview?.staffName ?? "Staff member"} was safely offboarded · ${result.reassigned} appointment(s) reassigned${result.notificationsSent ? ` · ${result.notificationsSent} notice(s) sent` : ""}`;
    onCompleted(`${message}${deliveryWarning}.`);
    onClose();
  }

  const footer = (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button variant="secondary" size="md" onClick={onClose} disabled={saving}>
        {vi ? "Để sau" : "Not now"}
      </Button>
      <Button
        variant="primary"
        size="md"
        disabled={!canComplete}
        onClick={() => void complete()}
        data-testid="staff-offboarding-complete"
      >
        {saving
          ? vi
            ? "Đang hoàn tất…"
            : "Finishing…"
          : vi
            ? "Xác nhận cho nghỉ việc"
            : "Confirm offboarding"}
      </Button>
    </div>
  );

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title={vi ? "Cho nhân viên nghỉ việc" : "Offboard staff member"}
      description={
        activePreview?.staffName ??
        (vi ? "Kiểm tra lịch trước khi khóa quyền" : "Review appointments before access is removed")
      }
      footer={footer}
    >
      {loading ? (
        <div className="flex min-h-48 items-center justify-center" role="status">
          <span className="size-6 animate-spin rounded-full border-2 border-nq-primary border-t-transparent" />
          <span className="ml-3 text-sm text-nq-muted">
            {vi ? "Đang kiểm tra lịch…" : "Checking the schedule…"}
          </span>
        </div>
      ) : null}

      {error ? (
        <p className="mb-4 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error" role="alert">
          {error}
        </p>
      ) : null}

      {activePreview ? (
        <div className="flex flex-col gap-5">
          <section className="rounded-2xl border border-nq-border/50 bg-nq-bg/50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-nq-primary">
              {vi ? "1 · Bảo vệ lịch khách" : "1 · Protect guest appointments"}
            </p>
            <h3 className="mt-1 text-base font-semibold text-nq-foreground">
              {reassignable.length
                ? vi
                  ? `${reassignable.length} lịch cần chuyển`
                  : `${reassignable.length} appointment(s) to reassign`
                : vi
                  ? "Không có lịch cần chuyển"
                  : "No appointments need reassignment"}
            </h3>
            <p className="mt-1 text-sm text-nq-muted">
              {vi
                ? "Chỉ hiện thợ làm được dịch vụ và không trùng giờ. Giá, dịch vụ và thời gian của khách được giữ nguyên."
                : "Only qualified, conflict-free staff are shown. Guest time, service, and price stay unchanged."}
            </p>

            <div className="mt-4 flex flex-col gap-3">
              {commonCandidates.length > 0 ? (
                <label className="block rounded-xl border border-nq-primary/30 bg-nq-primary/10 p-3 text-sm font-medium text-nq-foreground">
                  {vi ? "Gán nhanh tất cả lịch cho" : "Assign every appointment to"}
                  <select
                    className="mt-2 min-h-11 w-full rounded-xl border border-nq-border bg-nq-bg px-3 text-base text-nq-foreground"
                    defaultValue=""
                    onChange={(event) => {
                      const nextStaffId = event.target.value;
                      if (!nextStaffId) return;
                      setAssignments(
                        Object.fromEntries(
                          reassignable.map((booking) => [booking.id, nextStaffId]),
                        ),
                      );
                    }}
                    data-testid="staff-offboarding-assign-all"
                  >
                    <option value="">{vi ? "Chọn một thợ" : "Choose a staff member"}</option>
                    {commonCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {reassignable.map((booking) => (
                <div key={booking.id} className="rounded-xl border border-nq-border/40 bg-nq-surface p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-nq-foreground">{booking.clientName}</p>
                      <p className="text-sm text-nq-muted">
                        {booking.serviceName} · {formatWhen(booking.startTimeUtc, activePreview.timezone, language)}
                      </p>
                    </div>
                    <span className="rounded-full bg-nq-primary/10 px-2 py-1 text-xs font-semibold text-nq-primary">
                      {booking.status === "confirmed"
                        ? vi
                          ? "Đã xác nhận"
                          : "Confirmed"
                        : vi
                          ? "Đang chờ"
                          : "Pending"}
                    </span>
                  </div>
                  <label className="mt-3 block text-sm font-medium text-nq-foreground">
                    {vi ? "Chuyển cho" : "Reassign to"}
                    <select
                      className="mt-1 min-h-11 w-full rounded-xl border border-nq-border bg-nq-bg px-3 text-base text-nq-foreground"
                      value={assignments[booking.id] ?? ""}
                      onChange={(event) =>
                        setAssignments((current) => ({
                          ...current,
                          [booking.id]: event.target.value,
                        }))
                      }
                      data-testid={`staff-offboarding-assignment-${booking.id}`}
                    >
                      <option value="">
                        {booking.candidates.length
                          ? vi
                            ? "Chọn nhân viên phù hợp"
                            : "Choose an available staff member"
                          : vi
                            ? "Không có thợ phù hợp đang rảnh"
                            : "No qualified staff available"}
                      </option>
                      {booking.candidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ))}
            </div>
          </section>

          {blockers.length > 0 ? (
            <section className="rounded-2xl border border-nq-error/45 bg-nq-error/10 p-4" role="alert">
              <p className="font-semibold text-nq-error">
                {vi ? "Chưa thể hoàn tất" : "Cannot finish yet"}
              </p>
              <p className="mt-1 text-sm text-nq-foreground">
                {vi
                  ? `${blockers.length} khách đang chờ hoặc đang được phục vụ. Hãy hoàn tất các ca này trước để tránh bỏ quên khách.`
                  : `${blockers.length} guest(s) are waiting or in service. Finish those visits first so no guest is abandoned.`}
              </p>
            </section>
          ) : null}

          <section className="rounded-2xl border border-nq-border/50 bg-nq-bg/50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-nq-primary">
              {vi ? "2 · Báo khách có kiểm soát" : "2 · Controlled guest notice"}
            </p>
            <p className="mt-2 text-sm text-nq-muted">
              {vi
                ? "Không gửi mặc định. Chỉ gửi sau khi bạn chọn kênh và bấm xác nhận cuối cùng. Nội dung nói rõ lịch vẫn giữ nguyên."
                : "Nothing is sent by default. Notices send only after your final confirmation and clearly say the appointment time is unchanged."}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="flex min-h-11 items-center gap-3 rounded-xl border border-nq-border/40 bg-nq-surface px-3 has-[:disabled]:opacity-55">
                <input type="checkbox" checked={notifyEmail} disabled={emailRecipients === 0} onChange={(e) => setNotifyEmail(e.target.checked)} />
                <span className="text-sm text-nq-foreground">
                  Email · {emailRecipients} {vi ? "khách" : "guest(s)"}
                </span>
              </label>
              <label className="flex min-h-11 items-center gap-3 rounded-xl border border-nq-border/40 bg-nq-surface px-3 has-[:disabled]:opacity-55">
                <input type="checkbox" checked={notifySms} disabled={smsRecipients === 0} onChange={(e) => setNotifySms(e.target.checked)} />
                <span className="text-sm text-nq-foreground">
                  SMS · {smsRecipients} {vi ? "khách" : "guest(s)"}
                </span>
              </label>
            </div>
          </section>

          <section className="rounded-2xl border border-nq-border/50 bg-nq-bg/50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-nq-primary">
              {vi ? "3 · Khóa quyền, giữ lịch sử" : "3 · Remove access, preserve history"}
            </p>
            {activePreview.accessIsOwner ? (
              <p className="mt-2 rounded-xl border border-nq-error/40 bg-nq-error/10 p-3 text-sm text-nq-error">
                {vi
                  ? "Đây là tài khoản Chủ tiệm. Hãy chuyển quyền sở hữu trước khi cho nghỉ việc."
                  : "This is the owner account. Transfer ownership before offboarding."}
              </p>
            ) : activePreview.hasLogin ? (
              <label className="mt-3 flex min-h-11 items-center gap-3 rounded-xl border border-nq-border/40 bg-nq-surface px-3">
                <input type="checkbox" checked={revokeAccess} onChange={(e) => setRevokeAccess(e.target.checked)} />
                <span className="text-sm text-nq-foreground">
                  {vi ? "Khóa quyền đăng nhập Dashboard" : "Remove dashboard login access"}
                </span>
              </label>
            ) : (
              <p className="mt-2 text-sm text-nq-muted">
                {vi ? "Nhân viên này không có tài khoản đăng nhập." : "This staff member has no dashboard login."}
              </p>
            )}
            <p className="mt-3 text-sm text-nq-muted">
              {vi
                ? "Hồ sơ sẽ chuyển sang Không hoạt động. Lịch cũ, doanh thu và nhật ký vẫn được giữ để báo cáo chính xác."
                : "The profile becomes Inactive. Past appointments, revenue, and audit history remain intact."}
            </p>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
