"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
  const [requestId, setRequestId] = useState<string | null>(null);
  const onCloseRef = useRef(onClose);
  const onCompletedRef = useRef(onCompleted);

  useEffect(() => {
    onCloseRef.current = onClose;
    onCompletedRef.current = onCompleted;
  }, [onClose, onCompleted]);

  useEffect(() => {
    if (!isOpen || !staffId) return;
    const storageKey = `nailiq:staff-offboarding-request:${slug}:${staffId}`;
    let durableRequestId: string;
    try {
      const stored = window.sessionStorage.getItem(storageKey);
      durableRequestId = stored && /^[0-9a-f-]{36}$/i.test(stored)
        ? stored
        : crypto.randomUUID();
      window.sessionStorage.setItem(storageKey, durableRequestId);
    } catch {
      durableRequestId = crypto.randomUUID();
    }
    let alive = true;
    void (async () => {
      // Schedule state synchronization after the effect body; the external
      // sessionStorage write above is the effect's synchronous responsibility.
      await Promise.resolve();
      if (!alive) return;
      setRequestId(durableRequestId);
      setPreview(null);
      setError(null);
      const result = await loadStaffOffboardingPreview(slug, staffId, durableRequestId);
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
      if ("recovered" in result) {
        try {
          window.sessionStorage.removeItem(storageKey);
        } catch {
          // Storage is a recovery aid; the durable database receipt is authoritative.
        }
        setRequestId(null);
        const message = vi
          ? `Yêu cầu trước đã hoàn tất an toàn · chuyển ${result.recovered.reassigned} lịch.`
          : `The earlier request was already completed safely · ${result.recovered.reassigned} appointment(s) reassigned.`;
        onCompletedRef.current(message);
        onCloseRef.current();
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
    })();
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
    Boolean(requestId) &&
    !activePreview?.accessIsOwner &&
    !activePreview?.tooManyBookings &&
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
      notification_channel_unavailable: [
        "Kênh thông báo vừa bị tắt. Hãy mở lại bảng này và chọn kênh đang hoạt động.",
        "A notification channel was just disabled. Reopen this panel and choose an enabled channel.",
      ],
      sequence_receipt_invalid: [
        "Một lịch nhiều dịch vụ thiếu dữ liệu xác thực. Chưa có thay đổi nào được lưu; cần kiểm tra lịch này trước.",
        "A multi-service appointment has invalid receipt data. Nothing was saved; review that appointment first.",
      ],
      too_many_bookings: [
        "Có hơn 100 lịch bị ảnh hưởng. Chưa có thay đổi nào được lưu; cần chia kế hoạch chuyển lịch có kiểm soát.",
        "More than 100 appointments are affected. Nothing was saved; use a controlled staged reassignment plan.",
      ],
    };
    const pair = copy[code];
    return pair ? pair[vi ? 0 : 1] : vi ? "Không hoàn tất được. Vui lòng thử lại." : "Could not finish. Try again.";
  }

  async function complete() {
    if (!staffId || !requestId || !canComplete) return;
    setSaving(true);
    setError(null);
    let result: Awaited<ReturnType<typeof completeStaffOffboarding>>;
    try {
      result = await completeStaffOffboarding(slug, {
        requestId,
        staffId,
        assignments: reassignable.map((booking) => ({
          bookingId: booking.id,
          staffId: assignments[booking.id]!,
        })),
        notifyEmail,
        notifySms,
        revokeAccess,
      });
    } catch {
      setSaving(false);
      setError(
        vi
          ? "Mất kết nối sau khi gửi yêu cầu. Đóng và mở lại bảng này để tự kiểm tra kết quả an toàn."
          : "The connection was lost after submission. Close and reopen this panel to recover the exact result safely.",
      );
      return;
    }
    setSaving(false);
    if (!result.ok) {
      setError(errorMessage(result.error));
      return;
    }
    const deliveryWarning =
      (notifyEmail || notifySms) && result.notificationEventsQueued === 0
        ? vi
          ? " · chưa xếp hàng được thông báo; vui lòng kiểm tra lại"
          : " · no notice was queued; please review"
        : "";
    const queuedNotice = result.notificationEventsQueued > 0
      ? vi
        ? ` · đã xếp hàng ${result.notificationEventsQueued} sự kiện thông báo / ${result.notificationDeliveriesQueued} lượt theo kênh; thao tác này chưa ghi nhận lần thử nhà cung cấp nào`
        : ` · ${result.notificationEventsQueued} notice event(s) / ${result.notificationDeliveriesQueued} channel delivery(s) queued; no provider attempt was recorded at this action boundary`
      : "";
    const message = vi
      ? `Đã cho ${activePreview?.staffName ?? "nhân viên"} nghỉ việc an toàn · chuyển ${result.reassigned} lịch`
      : `${activePreview?.staffName ?? "Staff member"} was safely offboarded · ${result.reassigned} appointment(s) reassigned`;
    try {
      window.sessionStorage.removeItem(
        `nailiq:staff-offboarding-request:${slug}:${staffId}`,
      );
    } catch {
      // The committed receipt is authoritative even when browser storage is unavailable.
    }
    setRequestId(null);
    onCompleted(`${message}${queuedNotice}${deliveryWarning}.`);
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

          {activePreview.tooManyBookings ? (
            <section className="rounded-2xl border border-nq-error/45 bg-nq-error/10 p-4" role="alert">
              <p className="font-semibold text-nq-error">
                {vi ? "Vượt giới hạn chuyển lịch an toàn" : "Safe reassignment limit exceeded"}
              </p>
              <p className="mt-1 text-sm text-nq-foreground">
                {vi
                  ? `Có ${activePreview.bookings.length} lịch bị ảnh hưởng; giới hạn cho một lần là ${activePreview.bookingLimit}. Chưa có thay đổi nào được lưu.`
                  : `${activePreview.bookings.length} appointments are affected; the per-request limit is ${activePreview.bookingLimit}. Nothing has been saved.`}
              </p>
            </section>
          ) : null}

          <section className="rounded-2xl border border-nq-border/50 bg-nq-bg/50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-nq-primary">
              {vi ? "2 · Báo khách có kiểm soát" : "2 · Controlled guest notice"}
            </p>
            <p className="mt-2 text-sm text-nq-muted">
              {vi
                ? "Không gửi mặc định. Khi xác nhận, kênh đã chọn chỉ được xếp vào hàng đợi bền vững; màn hình này không gọi nhà cung cấp và không chứng minh đã giao. Nội dung nói rõ lịch vẫn giữ nguyên."
                : "Nothing is sent by default. Confirmation only queues durable work for selected channels; this screen does not call a provider or prove delivery. The notice says the appointment time is unchanged."}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="flex min-h-11 items-center gap-3 rounded-xl border border-nq-border/40 bg-nq-surface px-3 has-[:disabled]:opacity-55">
                <input
                  type="checkbox"
                  checked={notifyEmail}
                  disabled={emailRecipients === 0 || !activePreview.emailOutboundEnabled}
                  onChange={(e) => setNotifyEmail(e.target.checked)}
                  data-testid="staff-offboarding-notify-email"
                />
                <span className="text-sm text-nq-foreground">
                  Email · {emailRecipients} {vi ? "khách" : "guest(s)"}
                </span>
              </label>
              <label className="flex min-h-11 items-center gap-3 rounded-xl border border-nq-border/40 bg-nq-surface px-3 has-[:disabled]:opacity-55">
                <input
                  type="checkbox"
                  checked={notifySms}
                  disabled={smsRecipients === 0 || !activePreview.smsOutboundEnabled}
                  onChange={(e) => setNotifySms(e.target.checked)}
                  data-testid="staff-offboarding-notify-sms"
                />
                <span className="text-sm text-nq-foreground">
                  SMS · {smsRecipients} {vi ? "khách" : "guest(s)"}
                </span>
              </label>
            </div>
            {!activePreview.emailOutboundEnabled || !activePreview.smsOutboundEnabled ? (
              <p className="mt-3 text-sm text-nq-warning" data-testid="staff-offboarding-channel-warning">
                {vi
                  ? `Kênh đang tắt: ${[
                      !activePreview.emailOutboundEnabled ? "Email" : null,
                      !activePreview.smsOutboundEnabled ? "SMS" : null,
                    ].filter(Boolean).join(", ")}. Không thể chọn và hệ thống sẽ không xếp hàng kênh này.`
                  : `Disabled channel(s): ${[
                      !activePreview.emailOutboundEnabled ? "Email" : null,
                      !activePreview.smsOutboundEnabled ? "SMS" : null,
                    ].filter(Boolean).join(", ")}. They cannot be selected or queued.`}
              </p>
            ) : null}
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
