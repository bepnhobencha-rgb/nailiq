"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Check, Clock3, Copy, Printer, QrCode, RotateCcw, ShieldX } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  issueTurnIqCustomerCheckInLink,
  revokeTurnIqCustomerCheckInLink,
} from "@/shared/turniq/customerCheckInActions";

type BookingChoice = {
  id: string;
  serviceName: string;
  startLabel: string;
  partySize: number;
};

type ActiveLink = {
  capabilityId: string;
  path: string;
  expiresAt: string;
  scope: "one_booking" | "walkin_kiosk";
};

function errorCopy(code: string): string {
  if (code === "preview_only") return "Customer check-in is limited to Preview/local verification / Check-in khách hiện chỉ dùng ở Preview/local.";
  if (code === "feature_disabled") return "TurnIQ is off for this salon or platform / TurnIQ đang tắt cho salon hoặc hệ thống.";
  if (code === "rollout_stage_blocked") return "TurnIQ must reach Supervised before customer check-in is opened / TurnIQ phải đến chế độ Giám sát trước khi mở check-in khách.";
  if (code === "not_found") return "This appointment can no longer receive a QR / Lịch hẹn này không còn đủ điều kiện nhận QR.";
  if (code === "forbidden" || code === "unauthorized") return "This account cannot issue check-in links / Tài khoản này không có quyền tạo link check-in.";
  return "The secure link was not created / Chưa tạo được link an toàn. Nothing changed; please retry.";
}

function remainingCopy(seconds: number | null): string {
  if (seconds === null) return "Checking expiry…";
  if (seconds <= 0) return "Expired — scans are blocked by the server";
  if (seconds < 60) return `${seconds}s remaining`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min remaining`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m remaining` : `${hours}h remaining`;
}

function secondsUntil(expiresAt: string): number {
  const expiresMs = Date.parse(expiresAt);
  return Number.isFinite(expiresMs)
    ? Math.max(0, Math.ceil((expiresMs - Date.now()) / 1_000))
    : 0;
}

export function TurnIqCheckInLinkManager(props: {
  slug: string;
  salonName: string;
  bookings: readonly BookingChoice[];
  issueAction?: typeof issueTurnIqCustomerCheckInLink;
  revokeAction?: typeof revokeTurnIqCustomerCheckInLink;
}) {
  const [mode, setMode] = useState<"walkin_kiosk" | "booked_qr">("walkin_kiosk");
  const [bookingId, setBookingId] = useState(props.bookings[0]?.id ?? "");
  const [active, setActive] = useState<ActiveLink | null>(null);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const issueAction = props.issueAction ?? issueTurnIqCustomerCheckInLink;
  const revokeAction = props.revokeAction ?? revokeTurnIqCustomerCheckInLink;
  const fullUrl = useMemo(() => {
    if (!active || typeof window === "undefined") return "";
    return `${window.location.origin}${active.path}`;
  }, [active]);
  const expired = remainingSeconds !== null && remainingSeconds <= 0;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(
      () => setRemainingSeconds(secondsUntil(active.expiresAt)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [active]);

  function issue() {
    setMessage("");
    setCopied(false);
    startTransition(() => {
      void (async () => {
        try {
          const result = await issueAction(
            props.slug,
            mode === "walkin_kiosk" ? { kind: mode } : { kind: mode, bookingId },
          );
          if (!result.ok) {
            setMessage(errorCopy(result.error));
            return;
          }
          setActive({
            capabilityId: result.capabilityId,
            path: result.checkInPath,
            expiresAt: result.expiresAt,
            scope: result.scope,
          });
          setRemainingSeconds(secondsUntil(result.expiresAt));
          setMessage("Secure QR ready / Mã QR an toàn đã sẵn sàng. No booking or assignment changed.");
        } catch {
          setMessage("QR could not be created / Không thể tạo QR. Nothing changed; please retry.");
        }
      })();
    });
  }

  function revoke() {
    if (!active) return;
    startTransition(() => {
      void (async () => {
        try {
          const result = await revokeAction(props.slug, active.capabilityId);
          if (!result.ok) {
            setMessage(errorCopy(result.error));
            return;
          }
          setActive(null);
          setRemainingSeconds(null);
          setMessage("QR revoked / QR đã thu hồi. It cannot be used again.");
        } catch {
          setMessage("Revocation could not be confirmed / Chưa xác nhận được thu hồi. Keep this QR private and retry.");
        }
      })();
    });
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .turniq-print-card, .turniq-print-card * { visibility: visible !important; }
          .turniq-print-card {
            position: fixed !important; inset: 0 !important; margin: auto !important;
            width: 100% !important; min-height: 100vh !important; border: 0 !important;
            display: flex !important; flex-direction: column !important;
            align-items: center !important; justify-content: center !important;
            color: #111214 !important; background: #fff !important; box-shadow: none !important;
          }
          .turniq-no-print { display: none !important; }
        }
      `}</style>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-nq-primary">TurnIQ shadow check-in</p>
        <h1 className="mt-1 text-2xl font-semibold text-nq-foreground">Customer check-in QR</h1>
        <p className="mt-2 text-sm text-nq-muted">{props.salonName} · Preview/local only · receives a shadow receipt, never creates a booking or assignment.</p>
      </div>

      <Card padding="lg">
        <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="QR type">
          <Button
            variant={mode === "walkin_kiosk" ? "primary" : "secondary"}
            size="lg"
            aria-pressed={mode === "walkin_kiosk"}
            disabled={Boolean(active && !expired)}
            onClick={() => {
              setMode("walkin_kiosk");
              if (expired) { setActive(null); setRemainingSeconds(null); }
            }}
          >Walk-in kiosk QR</Button>
          <Button
            variant={mode === "booked_qr" ? "primary" : "secondary"}
            size="lg"
            aria-pressed={mode === "booked_qr"}
            disabled={props.bookings.length === 0 || Boolean(active && !expired)}
            onClick={() => {
              setMode("booked_qr");
              if (expired) { setActive(null); setRemainingSeconds(null); }
            }}
          >One appointment QR</Button>
        </div>
        {mode === "booked_qr" ? (
          <label className="mt-4 block text-sm font-medium text-nq-foreground">
            Eligible appointment
            <select
              className="mt-2 min-h-12 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-nq-foreground"
              value={bookingId}
              disabled={Boolean(active && !expired)}
              onChange={(event) => {
                setBookingId(event.target.value);
                if (expired) { setActive(null); setRemainingSeconds(null); }
              }}
            >
              {props.bookings.map((booking) => (
                <option key={booking.id} value={booking.id}>
                  {booking.startLabel} · {booking.serviceName} · party {booking.partySize}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="mt-4 text-sm text-nq-muted">Reusable for today’s walk-ins, up to 100 shadow submissions or eight hours. Staff can revoke it instantly.</p>
        )}
        <Button
          className="mt-5"
          size="lg"
          fullWidth
          loading={pending}
          disabled={(mode === "booked_qr" && !bookingId) || Boolean(active && !expired)}
          leftIcon={<QrCode className="size-5" />}
          onClick={issue}
        >{expired ? "Create replacement QR" : "Create secure QR"}</Button>
        {active && !expired ? (
          <p className="mt-3 text-center text-xs text-nq-muted">Revoke the active QR before changing its type or appointment.</p>
        ) : null}
      </Card>

      {active && fullUrl ? (
        <Card padding="lg" className="turniq-print-card text-center" data-testid="turniq-active-qr">
          <p className="hidden text-sm font-semibold uppercase tracking-[0.16em] text-black print:block">{props.salonName}</p>
          <h2 className="hidden pt-3 text-3xl font-bold text-black print:block">Scan to check in</h2>
          <p className="hidden pt-2 text-base text-black print:block">Quét mã để check-in</p>
          <div
            className={`mt-4 inline-flex rounded-2xl bg-white p-4 ${expired ? "opacity-25" : ""}`}
            role="img"
            aria-label={expired ? "Expired customer check-in QR" : "Active customer check-in QR"}
          >
            <QRCodeSVG aria-hidden="true" value={fullUrl} size={232} bgColor="#ffffff" fgColor="#0b0c10" level="M" />
          </div>
          <p className="mt-4 text-sm font-medium text-nq-foreground">
            {active.scope === "walkin_kiosk" ? "Walk-in kiosk" : "One appointment only"}
          </p>
          <p className={`mt-2 inline-flex items-center gap-1.5 text-sm font-medium ${expired ? "text-nq-error" : "text-nq-muted"}`} role="timer" aria-label={`QR expiry: ${remainingCopy(remainingSeconds)}`}>
            <Clock3 className="size-4" aria-hidden="true" /> {remainingCopy(remainingSeconds)}
          </p>
          <p className="mt-1 text-xs text-nq-muted">Expires {new Date(active.expiresAt).toLocaleString()}</p>
          {expired ? <p className="mt-3 font-semibold text-nq-error" role="alert">Do not use this QR / Không dùng QR này</p> : null}
          <p className="hidden max-w-sm pt-5 text-sm text-black print:block">This QR only records arrival for staff review. It does not create or change an appointment.<br />QR này chỉ ghi nhận khách đã đến để nhân viên kiểm tra; không tạo hoặc đổi lịch hẹn.</p>
          <div className="turniq-no-print mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button
              variant="secondary"
              size="lg"
              disabled={expired}
              aria-label="Copy secure check-in link"
              leftIcon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              onClick={() => {
                void navigator.clipboard.writeText(fullUrl)
                  .then(() => setCopied(true))
                  .catch(() => setMessage("Copy was blocked by this browser. The QR remains valid."));
              }}
            >{copied ? "Copied" : "Copy link"}</Button>
            <Button
              variant="secondary"
              size="lg"
              disabled={expired}
              aria-label="Print customer check-in QR"
              leftIcon={<Printer className="size-4" />}
              onClick={() => window.print()}
            >Print QR</Button>
            <Button
              variant="danger"
              size="lg"
              loading={pending}
              className="bg-red-700 text-white hover:bg-red-800"
              aria-label="Revoke customer check-in QR"
              leftIcon={<ShieldX className="size-4" />}
              onClick={revoke}
            >Revoke QR</Button>
          </div>
        </Card>
      ) : null}

      {message ? (
        <Card padding="sm" role="status" aria-live="polite" className="turniq-no-print flex items-center gap-2 text-sm text-nq-muted">
          <RotateCcw className="size-4 shrink-0" aria-hidden="true" /> {message}
        </Card>
      ) : null}
    </div>
  );
}
