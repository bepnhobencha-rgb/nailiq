"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type CardInfo = {
  ok: boolean;
  salonName: string;
  hasCard: boolean;
  brand: string;
  last4: string;
  feeLabel: string;
  status: string;
  code?: string;
};

type Phase =
  | { phase: "loading" }
  | { phase: "view"; info: CardInfo }
  | { phase: "removing"; info: CardInfo }
  | { phase: "removed" }
  | { phase: "error"; code: string };

function brandLabel(brand: string): string {
  const b = brand.toUpperCase();
  if (b.includes("VISA")) return "Visa";
  if (b.includes("MASTER")) return "Mastercard";
  if (b.includes("AMEX") || b.includes("AMERICAN")) return "Amex";
  if (b.includes("DISCOVER")) return "Discover";
  return brand || "Card";
}

function CardManager() {
  const params = useSearchParams();
  const token = params?.get("token") ?? "";
  const [state, setState] = useState<Phase>(
    token ? { phase: "loading" } : { phase: "error", code: "missing_token" },
  );

  useEffect(() => {
    if (!token) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/booking/card-info?token=${encodeURIComponent(token)}`);
        const json = (await res.json()) as CardInfo;
        if (!alive) return;
        if (!res.ok || !json.ok) {
          setState({ phase: "error", code: json.code ?? "load_failed" });
          return;
        }
        setState({ phase: "view", info: json });
      } catch {
        if (alive) setState({ phase: "error", code: "network_error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  async function remove(info: CardInfo) {
    setState({ phase: "removing", info });
    try {
      const res = await fetch("/api/booking/remove-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = (await res.json()) as { ok: boolean; code?: string };
      if (!res.ok || !json.ok) {
        if (json.code === "already_charged") {
          setState({ phase: "error", code: "already_charged" });
          return;
        }
        setState({ phase: "error", code: json.code ?? "remove_failed" });
        return;
      }
      setState({ phase: "removed" });
    } catch {
      setState({ phase: "error", code: "network_error" });
    }
  }

  return (
    <main className="min-h-screen w-full bg-white">
     <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-5 py-10">
      <header className="text-center">
        <h1 className="text-2xl font-semibold text-neutral-900">Your saved card</h1>
        <p className="mt-1 text-sm text-neutral-500">Thẻ đã lưu của bạn</p>
      </header>

      {state.phase === "loading" ? (
        <div className="animate-pulse rounded-2xl border border-neutral-200 bg-neutral-50 p-6">
          <div className="h-4 w-32 rounded bg-neutral-200" />
          <div className="mt-3 h-8 w-48 rounded bg-neutral-200" />
        </div>
      ) : null}

      {state.phase === "view" || state.phase === "removing" ? (
        <Card
          info={state.info}
          busy={state.phase === "removing"}
          onRemove={() => remove(state.info)}
        />
      ) : null}

      {state.phase === "removed" ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
          <p className="text-lg font-semibold text-emerald-800">Card removed ✓</p>
          <p className="mt-1 text-sm text-emerald-700">
            Đã gỡ thẻ. Thẻ của bạn sẽ không bị tính phí nữa.
          </p>
          <p className="mt-2 text-xs text-emerald-600">
            Your card has been removed and can no longer be charged.
          </p>
        </div>
      ) : null}

      {state.phase === "error" ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center">
          <p className="text-sm font-medium text-amber-800">
            {state.code === "already_charged"
              ? "This card was already charged a no-show fee, so it can't be removed here. Please contact the salon. / Thẻ này đã bị tính phí no-show nên không thể gỡ ở đây — vui lòng liên hệ salon."
              : state.code === "expired_token" || state.code === "invalid_token"
                ? "This link has expired. Please contact the salon. / Liên kết đã hết hạn, vui lòng liên hệ salon."
                : "Something went wrong. Please try again. / Có lỗi xảy ra, vui lòng thử lại."}
          </p>
        </div>
      ) : null}
     </div>
    </main>
  );
}

function Card({
  info,
  busy,
  onRemove,
}: {
  info: CardInfo;
  busy: boolean;
  onRemove: () => void;
}) {
  if (!info.hasCard) {
    return (
      <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-6 text-center">
        <p className="text-sm text-neutral-600">
          No card is on file for this appointment. / Không có thẻ nào được lưu cho lịch hẹn này.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl bg-gradient-to-br from-neutral-900 to-neutral-700 p-6 text-white shadow-lg">
        <p className="text-xs uppercase tracking-widest text-white/60">{info.salonName}</p>
        <p className="mt-6 font-mono text-xl tracking-widest">•••• •••• •••• {info.last4}</p>
        <p className="mt-3 text-sm text-white/80">{brandLabel(info.brand)}</p>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm leading-relaxed text-neutral-600">
        <p>
          We securely saved this card to hold your spot. You&apos;re only charged{" "}
          <strong className="text-neutral-900">{info.feeLabel}</strong> if you don&apos;t show up —
          nothing otherwise.
        </p>
        <p className="mt-2 text-neutral-500">
          Thẻ được lưu an toàn để giữ chỗ. Bạn chỉ bị tính{" "}
          <strong className="text-neutral-800">{info.feeLabel}</strong> nếu không đến — ngoài ra
          không tính gì.
        </p>
      </div>

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

export default function CardManagerPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <CardManager />
    </Suspense>
  );
}
