"use client";

import { useEffect, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import {
  loadRsvpPageData,
  confirmMemberAttendance,
  declineMemberAttendance,
  reportLateDecline,
  type RsvpPageData,
} from "@/shared/booking/groupMemberRsvpActions";

function formatSlotTime(isoUtc: string, timezone: string): string {
  try {
    return new Date(isoUtc).toLocaleString("en-CA", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
      timeZoneName: "short",
    });
  } catch {
    return isoUtc;
  }
}

type UIState =
  | "loading"
  | "error"
  | "idle"
  | "declining"
  | "too_late"          // past cutoff → Minh handles
  | "late_suggest"      // same as declining but for late path
  | "done_confirm"
  | "done_decline"
  | "done_late";        // late decline submitted to Minh

export default function GroupRsvpPage() {
  const searchParams = useSearchParams();
  const token = searchParams?.get("token") ?? "";
  const lang = (searchParams?.get("lang") ?? "vi") as "en" | "vi";

  const [data, setData] = useState<RsvpPageData | null>(null);
  const [uiState, setUiState] = useState<UIState>(
    token ? "loading" : "error",
  );
  const [sugName, setSugName] = useState("");
  const [sugPhone, setSugPhone] = useState("");
  const [errorCode, setErrorCode] = useState(
    token ? "" : "missing_token",
  );
  const [cutoffHours, setCutoffHours] = useState(2);
  const [isPending, startTransition] = useTransition();

  const t = lang === "en" ? EN : VI;

  useEffect(() => {
    if (!token) return;
    void loadRsvpPageData(token).then((res) => {
      setData(res);
      if (!res.ok) { setUiState("error"); setErrorCode(res.code); return; }
      // Already responded
      if (res.currentStatus === "confirmed") { setUiState("done_confirm"); return; }
      if (res.currentStatus === "declined")  { setUiState("done_decline"); return; }
      setUiState("idle");
    });
  }, [token]);

  function handleConfirm() {
    if (!data?.ok) return;
    startTransition(async () => {
      const res = await confirmMemberAttendance(data.bookingId, token);
      if (res.ok) { setUiState("done_confirm"); }
      else { setUiState("error"); setErrorCode(res.code ?? "unknown"); }
    });
  }

  function handleDeclineSubmit() {
    if (!data?.ok) return;
    startTransition(async () => {
      const res = await declineMemberAttendance(
        data.bookingId,
        token,
        sugName.trim() || undefined,
        sugPhone.trim() || undefined,
      );
      if (res.ok) {
        setUiState("done_decline");
      } else if (res.code === "too_late") {
        // Past cutoff — switch to Minh-handled flow
        setCutoffHours(res.cutoffHours ?? 2);
        setUiState("too_late");
      } else {
        setUiState("error");
        setErrorCode(res.code ?? "unknown");
      }
    });
  }

  function handleLateDeclineSubmit() {
    if (!data?.ok) return;
    startTransition(async () => {
      await reportLateDecline(
        data.bookingId,
        token,
        sugName.trim() || undefined,
        sugPhone.trim() || undefined,
      );
      setUiState("done_late");
    });
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (uiState === "loading") {
    return (
      <Shell>
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-2/3 rounded-lg bg-nq-surface" />
          <div className="h-4 w-full rounded-lg bg-nq-surface" />
          <div className="h-4 w-4/5 rounded-lg bg-nq-surface" />
        </div>
      </Shell>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (uiState === "error" || !data?.ok) {
    const msgs: Record<string, string> = {
      missing_token: t.errMissing,
      not_found:     t.errNotFound,
      expired:       t.errExpired,
    };
    return (
      <Shell>
        <div className="text-center">
          <p className="text-3xl">🔗</p>
          <h1 className="mt-3 text-lg font-semibold text-white">{t.errTitle}</h1>
          <p className="mt-2 text-sm text-nq-muted">{msgs[errorCode] ?? t.errGeneric}</p>
        </div>
      </Shell>
    );
  }

  const info = data;

  // ── Already confirmed ─────────────────────────────────────────────────────
  if (uiState === "done_confirm") {
    return (
      <Shell>
        <div className="text-center">
          <p className="text-4xl">✅</p>
          <h1 className="mt-4 text-xl font-semibold text-white">{t.confirmedTitle}</h1>
          <p className="mt-2 text-sm text-nq-muted">
            {t.confirmedBody(info.salonName, formatSlotTime(info.startAt, info.timezone))}
          </p>
        </div>
      </Shell>
    );
  }

  // ── Already / just declined ───────────────────────────────────────────────
  if (uiState === "done_decline") {
    return (
      <Shell>
        <div className="text-center">
          <p className="text-4xl">🙏</p>
          <h1 className="mt-4 text-xl font-semibold text-white">{t.declinedTitle}</h1>
          <p className="mt-2 text-sm text-nq-muted">
            {t.declinedBody(info.organizerName || t.theOrganizer)}
          </p>
        </div>
      </Shell>
    );
  }

  // ── Too late → Minh takes over ───────────────────────────────────────────
  if (uiState === "too_late") {
    return (
      <Shell>
        <div className="text-center">
          <p className="text-4xl">⏰</p>
          <h1 className="mt-4 text-lg font-semibold text-white">{t.tooLateTitle(cutoffHours)}</h1>
          <p className="mt-2 text-sm text-nq-muted">{t.tooLateBody}</p>
          <div className="mt-6 space-y-3">
            <button
              onClick={() => setUiState("late_suggest")}
              disabled={isPending}
              className="w-full rounded-xl bg-nq-primary py-3 text-sm font-semibold text-black transition hover:opacity-90"
            >
              {t.tooLateCta}
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  // ── Late decline suggestion form ──────────────────────────────────────────
  if (uiState === "late_suggest") {
    return (
      <Shell>
        <div>
          <button
            onClick={() => setUiState("too_late")}
            className="mb-4 flex items-center gap-1 text-xs text-nq-muted transition hover:text-white"
          >
            ← {t.back}
          </button>
          <h2 className="text-base font-semibold text-white">{t.suggestTitle}</h2>
          <p className="mt-1 text-xs text-nq-muted">{t.lateSuggestSubtitle}</p>
          <div className="mt-5 space-y-3">
            <input
              type="text"
              placeholder={t.suggestNamePlaceholder}
              value={sugName}
              onChange={(e) => setSugName(e.target.value)}
              className="w-full rounded-xl border border-nq-border/40 bg-nq-bg px-4 py-2.5 text-sm text-white placeholder:text-nq-muted focus:outline-none focus:ring-1 focus:ring-nq-primary/40"
            />
            <input
              type="tel"
              placeholder={t.suggestPhonePlaceholder}
              value={sugPhone}
              onChange={(e) => setSugPhone(e.target.value)}
              className="w-full rounded-xl border border-nq-border/40 bg-nq-bg px-4 py-2.5 text-sm text-white placeholder:text-nq-muted focus:outline-none focus:ring-1 focus:ring-nq-primary/40"
            />
          </div>
          <button
            onClick={handleLateDeclineSubmit}
            disabled={isPending}
            className="mt-5 w-full rounded-xl bg-nq-primary py-3 text-sm font-semibold text-black transition hover:opacity-90 disabled:opacity-50"
          >
            {isPending ? t.sending : t.lateConfirmCta}
          </button>
        </div>
      </Shell>
    );
  }

  // ── Minh confirmed taking over ────────────────────────────────────────────
  if (uiState === "done_late") {
    const org = data?.ok ? data.organizerName : "";
    return (
      <Shell>
        <div className="text-center">
          <p className="text-4xl">🤖</p>
          <h1 className="mt-4 text-lg font-semibold text-white">{t.doneLateTitle}</h1>
          <p className="mt-2 text-sm text-nq-muted">{t.doneLateBody(org || t.theOrganizer)}</p>
        </div>
      </Shell>
    );
  }

  // ── Decline form (second step) ────────────────────────────────────────────
  if (uiState === "declining") {
    return (
      <Shell>
        <div>
          <button
            onClick={() => setUiState("idle")}
            className="mb-4 flex items-center gap-1 text-xs text-nq-muted transition hover:text-white"
          >
            ← {t.back}
          </button>
          <h2 className="text-base font-semibold text-white">{t.suggestTitle}</h2>
          <p className="mt-1 text-xs text-nq-muted">{t.suggestSubtitle}</p>

          <div className="mt-5 space-y-3">
            <input
              type="text"
              placeholder={t.suggestNamePlaceholder}
              value={sugName}
              onChange={(e) => setSugName(e.target.value)}
              className="w-full rounded-xl border border-nq-border/40 bg-nq-bg px-4 py-2.5 text-sm text-white placeholder:text-nq-muted focus:outline-none focus:ring-1 focus:ring-nq-primary/40"
            />
            <input
              type="tel"
              placeholder={t.suggestPhonePlaceholder}
              value={sugPhone}
              onChange={(e) => setSugPhone(e.target.value)}
              className="w-full rounded-xl border border-nq-border/40 bg-nq-bg px-4 py-2.5 text-sm text-white placeholder:text-nq-muted focus:outline-none focus:ring-1 focus:ring-nq-primary/40"
            />
          </div>

          <button
            onClick={handleDeclineSubmit}
            disabled={isPending}
            className="mt-5 w-full rounded-xl border border-nq-error/30 bg-nq-error/10 py-3 text-sm font-medium text-nq-error transition hover:bg-nq-error/20 disabled:opacity-50"
          >
            {isPending ? t.sending : t.confirmDecline}
          </button>
        </div>
      </Shell>
    );
  }

  // ── Main RSVP screen ─────────────────────────────────────────────────────
  return (
    <Shell>
      {/* Salon + invite header */}
      <div className="mb-6 text-center">
        <p className="text-3xl">💇</p>
        <h1 className="mt-2 text-xl font-semibold text-white">{info.salonName}</h1>
        {info.organizerName && (
          <p className="mt-1 text-sm text-nq-muted">
            {t.invitedBy(info.organizerName, info.groupSize)}
          </p>
        )}
      </div>

      {/* Booking details card */}
      <div className="mb-6 rounded-2xl border border-nq-border/30 bg-nq-surface/40 px-4 py-4 space-y-2">
        {info.serviceName && (
          <Row label={t.service} value={info.serviceName} />
        )}
        {info.staffName && (
          <Row label={t.with} value={info.staffName} />
        )}
        <Row label={t.when} value={formatSlotTime(info.startAt, info.timezone)} />
      </div>

      {/* CTA prompt */}
      <p className="mb-4 text-center text-sm font-medium text-nq-muted">{t.prompt}</p>

      {/* Buttons */}
      <div className="space-y-3">
        <button
          onClick={handleConfirm}
          disabled={isPending}
          className="w-full rounded-xl bg-nq-primary py-3.5 text-sm font-semibold text-black transition hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? t.sending : `✅  ${t.attending}`}
        </button>
        <button
          onClick={() => setUiState("declining")}
          disabled={isPending}
          className="w-full rounded-xl border border-nq-border/40 bg-nq-surface/30 py-3.5 text-sm font-medium text-nq-muted transition hover:text-white disabled:opacity-50"
        >
          {`❌  ${t.notAttending}`}
        </button>
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="min-w-[64px] text-xs text-nq-muted">{label}</span>
      <span className="text-sm text-white">{value}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-nq-bg px-4 py-12">
      <div className="w-full max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface p-8 shadow-xl">
        {children}
        <p className="mt-8 text-center text-xs text-nq-muted/40">
          Powered by{" "}
          <a href="https://nailiq.ca" className="underline">
            NailIQ
          </a>
        </p>
      </div>
    </div>
  );
}

// ── i18n strings ─────────────────────────────────────────────────────────────

const VI = {
  invitedBy: (name: string, size: number) =>
    `${name} đã đặt lịch nhóm ${size} người cho bạn`,
  service: "Dịch vụ",
  with: "Kỹ thuật viên",
  when: "Thời gian",
  prompt: "Bạn có thể tham dự không?",
  attending: "Tôi sẽ đến",
  notAttending: "Tôi không đến được",
  sending: "Đang gửi…",
  back: "Quay lại",
  suggestTitle: "Gợi ý người thay (không bắt buộc)",
  suggestSubtitle:
    "Nếu bạn biết ai có thể thay thế, hãy để lại thông tin để tổ chức thông báo cho họ.",
  lateSuggestSubtitle:
    "Không bắt buộc — nếu có người muốn lấy slot của bạn, Minh sẽ liên hệ họ ngay.",
  suggestNamePlaceholder: "Tên người thay",
  suggestPhonePlaceholder: "Số điện thoại",
  confirmDecline: "Xác nhận không tham dự",
  lateConfirmCta: "Báo Minh xử lý",
  tooLateTitle: (h: number) => `Còn dưới ${h} tiếng — quá thời hạn tự huỷ`,
  tooLateBody:
    "Không sao! Minh sẽ thông báo cho người tổ chức ngay và kiểm tra xem có ai trên danh sách chờ có thể lấp slot của bạn không.",
  tooLateCta: "Nhờ Minh xử lý giúp tôi →",
  doneLateTitle: "Minh đã nhận được!",
  doneLateBody: (organizer: string) =>
    `${organizer} vừa được thông báo. Minh đang kiểm tra danh sách chờ và sẽ sắp xếp nếu có người thay.`,
  confirmedTitle: "Đã xác nhận!",
  confirmedBody: (salon: string, date: string) =>
    `Bạn đã xác nhận tham dự tại ${salon} · ${date}. Hẹn gặp bạn sớm!`,
  declinedTitle: "Đã ghi nhận",
  declinedBody: (organizer: string) =>
    `Cảm ơn bạn đã thông báo. ${organizer} sẽ được thông báo ngay.`,
  theOrganizer: "Người tổ chức",
  errTitle: "Liên kết không hợp lệ",
  errMissing: "Liên kết này không hợp lệ.",
  errNotFound: "Liên kết này không tồn tại hoặc đã hết hạn.",
  errExpired: "Liên kết này đã hết hạn. Vui lòng liên hệ salon.",
  errGeneric: "Đã có lỗi xảy ra. Vui lòng liên hệ salon trực tiếp.",
};

const EN = {
  invitedBy: (name: string, size: number) =>
    `${name} added you to a group of ${size}`,
  service: "Service",
  with: "With",
  when: "When",
  prompt: "Will you be there?",
  attending: "I'll be there",
  notAttending: "I can't make it",
  sending: "Sending…",
  back: "Go back",
  suggestTitle: "Suggest a replacement (optional)",
  suggestSubtitle:
    "If you know someone who can take your slot, leave their info and the organizer will be notified.",
  lateSuggestSubtitle:
    "Optional — if you have someone in mind, Minh will reach out to them right away.",
  suggestNamePlaceholder: "Their name",
  suggestPhonePlaceholder: "Phone number",
  confirmDecline: "Confirm I won't attend",
  lateConfirmCta: "Ask Minh to handle this →",
  tooLateTitle: (h: number) => `Under ${h}h to go — past the self-serve window`,
  tooLateBody:
    "No worries! Minh will notify the organizer immediately and check if anyone on the waitlist can fill your slot.",
  tooLateCta: "Let Minh handle it →",
  doneLateTitle: "Minh is on it!",
  doneLateBody: (organizer: string) =>
    `${organizer} has been notified. Minh is checking the waitlist and will arrange a replacement if available.`,
  confirmedTitle: "You're confirmed!",
  confirmedBody: (salon: string, date: string) =>
    `We have you down for ${salon} · ${date}. See you soon!`,
  declinedTitle: "Got it!",
  declinedBody: (organizer: string) =>
    `Thanks for letting us know. ${organizer} will be notified right away.`,
  theOrganizer: "The organizer",
  errTitle: "Invalid link",
  errMissing: "This link is not valid.",
  errNotFound: "This link doesn't exist or has expired.",
  errExpired: "This link has expired. Please contact the salon.",
  errGeneric: "Something went wrong. Please contact the salon directly.",
};
