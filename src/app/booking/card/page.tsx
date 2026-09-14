"use client";

import { Suspense, useEffect, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { buildBookingThemeVars } from "@/shared/booking/bookingThemeVars";
import { CARD_PROTECTION_COPY, type CardProtectionStatus } from "@/shared/booking/cardProtection";
import {
  acknowledgeBookingManagementRequest,
  pendingBookingManagementRequest,
  stableBookingManagementRequestId,
} from "@/shared/booking/bookingManagementRequestId";

type CardInfo = {
  ok: boolean;
  salonName: string;
  brandColor: string;
  themeMode: "light" | "dark";
  hasCard: boolean;
  protectionStatus: CardProtectionStatus;
  protectionActive: boolean;
  brand: string;
  last4: string;
  feeLabel: string;
  status: string;
  cardFingerprint: string;
  code?: string;
};

type Phase =
  | { phase: "loading" }
  | { phase: "view"; info: CardInfo }
  | { phase: "removing"; info: CardInfo }
  | { phase: "removed"; info?: CardInfo }
  | { phase: "error"; code: string; info?: CardInfo };

function removalReply(value: unknown): { removed: boolean; code: string } {
  const reply = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  return {
    removed: reply?.ok === true && (reply.code === "removed" || reply.code === "already_removed"),
    code: typeof reply?.code === "string" ? reply.code : "remove_unknown",
  };
}

function errorMessage(code: string): string {
  if (code === "already_charged") return "This card was already charged a no-show fee, so it can't be removed here. Please contact the salon. / Thẻ này đã bị tính phí no-show nên không thể gỡ ở đây — vui lòng liên hệ salon.";
  if (["expired_token", "invalid_token", "expired_or_revoked", "token_consumed", "missing_token"].includes(code)) {
    return "This link is no longer available. Please contact the salon to check your card status and request a new secure link. / Liên kết không còn sử dụng được. Vui lòng liên hệ salon kiểm tra trạng thái thẻ và xin liên kết an toàn mới.";
  }
  if (["stale_card", "idempotency_mismatch"].includes(code)) {
    return "This request no longer matches the saved card. Please contact the salon to check your card status. / Yêu cầu này không còn khớp với thẻ đã lưu. Vui lòng liên hệ salon kiểm tra trạng thái thẻ.";
  }
  if (["network_error", "load_failed"].includes(code)) {
    return "We could not load your card information. Please reload the page or contact the salon. / Chưa tải được thông tin thẻ. Vui lòng tải lại trang hoặc liên hệ salon.";
  }
  return "We cannot yet confirm that your card was removed. Please contact the salon to check the result before requesting another removal. / Chưa xác nhận được thẻ đã gỡ. Vui lòng liên hệ salon kiểm tra kết quả trước khi yêu cầu gỡ lại.";
}

function brandLabel(brand: string): string {
  const b = brand.toUpperCase();
  if (b.includes("VISA")) return "Visa";
  if (b.includes("MASTER")) return "Mastercard";
  if (b.includes("AMEX") || b.includes("AMERICAN")) return "Amex";
  if (b.includes("DISCOVER")) return "Discover";
  return brand || "Card";
}

function CardManager({ token }: { token: string }) {
  const [state, setState] = useState<Phase>(
    token ? { phase: "loading" } : { phase: "error", code: "missing_token" },
  );
  const appearance = "info" in state ? state.info : null;
  const brand = /^#[0-9a-f]{6}$/i.test(appearance?.brandColor ?? "") ? appearance!.brandColor : "#D4AF37";
  const theme = buildBookingThemeVars(brand, appearance?.themeMode === "dark" ? "dark" : "light") as CSSProperties;

  useEffect(() => {
    if (!token) return;
    let alive = true;
    let replayingRemoval = false;
    void (async () => {
      try {
        const pending = await pendingBookingManagementRequest({ action: "card_manage", token });
        if (pending && /^[0-9a-f]{64}$/.test(pending.material)) {
          replayingRemoval = true;
          const replay = await fetch("/api/booking/remove-card", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token,
              requestId: pending.requestId,
              expectedCardFingerprint: pending.material,
            }),
          });
          const reply = removalReply(await replay.json().catch(() => null));
          if (replay.ok && reply.removed) {
            await acknowledgeBookingManagementRequest({ action: "card_manage", token, material: pending.material });
            if (alive) setState({ phase: "removed" });
            return;
          }
          // A consumed capability can make card-info look expired. Preserve the
          // exact operation result instead; never replace it with a fresh read.
          if (alive) setState({ phase: "error", code: reply.code });
          return;
        }
        const res = await fetch(`/api/booking/card-info?token=${encodeURIComponent(token)}`);
        const json = (await res.json()) as CardInfo;
        if (!alive) return;
        if (!res.ok || !json.ok) {
          // No removal was attempted on this path. A read outage must not imply
          // that there is an unresolved removal operation.
          const code = ["expired_token", "invalid_token", "expired_or_revoked", "token_consumed"].includes(json.code ?? "")
            ? json.code! : "load_failed";
          setState({ phase: "error", code });
          return;
        }
        setState({ phase: "view", info: json });
      } catch {
        if (alive) setState({ phase: "error", code: replayingRemoval ? "remove_unknown" : "network_error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  async function remove(info: CardInfo) {
    setState({ phase: "removing", info });
    try {
      const intent = { action: "card_manage" as const, token, material: info.cardFingerprint };
      const requestId = await stableBookingManagementRequestId(intent);
      const res = await fetch("/api/booking/remove-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, requestId, expectedCardFingerprint: info.cardFingerprint }),
      });
      const reply = removalReply(await res.json().catch(() => null));
      if (!res.ok || !reply.removed) {
        setState({ phase: "error", code: reply.code, info });
        return;
      }
      await acknowledgeBookingManagementRequest(intent);
      setState({ phase: "removed", info });
    } catch {
      setState({ phase: "error", code: "remove_unknown", info });
    }
  }

  return (
    <main style={theme} className="min-h-screen w-full bg-[var(--booking-bg)] text-[var(--booking-text)]">
     <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-5 py-10">
      <header className="text-center">
        <h1 className="text-2xl font-semibold">{CARD_PROTECTION_COPY.en.title}</h1>
        <p className="mt-1 text-sm text-[var(--booking-text-muted)]">{CARD_PROTECTION_COPY.vi.title}</p>
      </header>

      {state.phase === "loading" ? (
        <div className="animate-pulse rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-6">
          <div className="h-4 w-32 rounded bg-[var(--booking-bg-input)]" />
          <div className="mt-3 h-8 w-48 rounded bg-[var(--booking-bg-input)]" />
        </div>
      ) : null}

      {state.phase === "view" || state.phase === "removing" ? (
        <Card
          info={state.info}
          recoveryHref={`/booking/save-card?token=${encodeURIComponent(token)}`}
          busy={state.phase === "removing"}
          onRemove={() => remove(state.info)}
        />
      ) : null}

      {state.phase === "removed" ? (
        <div className="rounded-2xl border border-emerald-500/40 bg-[var(--booking-bg-card)] p-6 text-center">
          <p className="text-lg font-semibold">Card removed ✓</p>
          <p className="mt-1 text-sm text-[var(--booking-text-muted)]">
            Đã gỡ thẻ. Thẻ của bạn sẽ không bị tính phí nữa.
          </p>
          <p className="mt-2 text-xs text-[var(--booking-text-muted)]">
            Your card has been removed and can no longer be charged.
          </p>
        </div>
      ) : null}

      {state.phase === "error" ? (
        <div role="alert" className="rounded-2xl border border-amber-500/40 bg-[var(--booking-bg-card)] p-6 text-center">
          <p className="text-sm font-medium">
            {errorMessage(state.code)}
          </p>
        </div>
      ) : null}
     </div>
    </main>
  );
}

function Card({
  info,
  recoveryHref,
  busy,
  onRemove,
}: {
  info: CardInfo;
  recoveryHref: string;
  busy: boolean;
  onRemove: () => void;
}) {
  if (!info.hasCard) {
    return (
      <div className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-6 text-center">
        <p className="text-sm text-[var(--booking-text-muted)]">
          No card is on file for this appointment. / Không có thẻ nào được lưu cho lịch hẹn này.
        </p>
        <InactiveProtection info={info} recoveryHref={recoveryHref} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-6 shadow-lg">
        <p className="text-xs uppercase tracking-widest text-[var(--booking-text-muted)]">{info.salonName}</p>
        <p className="mt-6 font-mono text-xl tracking-widest">•••• •••• •••• {info.last4}</p>
        <p className="mt-3 text-sm text-[var(--booking-text-muted)]">{brandLabel(info.brand)}</p>
      </div>

      {info.protectionActive === true && info.protectionStatus === "saved" ? <div className="rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 text-sm leading-relaxed text-[var(--booking-text-muted)]">
        <p className="font-semibold text-[var(--booking-text)]">{CARD_PROTECTION_COPY.en.active} / {CARD_PROTECTION_COPY.vi.active}</p>
        <p>
          The agreed no-show policy applies to the fee of{" "}
          <strong className="text-[var(--booking-text)]">{info.feeLabel}</strong> for this appointment.
        </p>
        <p className="mt-2">
          Phí no-show <strong className="text-[var(--booking-text)]">{info.feeLabel}</strong> áp dụng theo chính sách bạn đã đồng ý cho lịch hẹn này.
        </p>
      </div> : <InactiveProtection info={info} recoveryHref={recoveryHref} />}

      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        data-testid="remove-card-btn"
        className="rounded-xl border border-red-200 bg-red-50 py-3 text-sm font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-60"
      >
        {busy ? "Removing… / Đang gỡ…" : "Remove this card / Gỡ thẻ này"}
      </button>
    </div>
  );
}

function InactiveProtection({ info, recoveryHref }: { info: CardInfo; recoveryHref: string }) {
  if (info.protectionStatus === "not_required") return <p className="mt-3 text-sm text-[var(--booking-text-muted)]">
    {CARD_PROTECTION_COPY.en.notRequired} / {CARD_PROTECTION_COPY.vi.notRequired}
  </p>;
  return <div className="mt-3 rounded-xl border border-amber-500/40 bg-[var(--booking-bg-card)] p-4 text-sm leading-relaxed">
    <p>Card protection is not active. Please check your card status or contact the salon.</p>
    <p className="mt-2">Bảo vệ hủy trễ/no-show chưa kích hoạt. Vui lòng kiểm tra trạng thái thẻ hoặc liên hệ salon.</p>
    <a className="mt-3 inline-block font-semibold underline underline-offset-4" href={recoveryHref}>
      Check card status / Kiểm tra trạng thái thẻ
    </a>
  </div>;
}

function ScopedCardManager() {
  const token = useSearchParams()?.get("token") ?? "";
  return <CardManager key={token} token={token} />;
}

export default function CardManagerPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <ScopedCardManager />
    </Suspense>
  );
}
