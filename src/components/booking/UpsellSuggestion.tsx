"use client";

import { useEffect, useState, useCallback, useRef } from "react";

type Props = {
  salonId: string;
  clientPhone: string | null;
  selectedServiceId: string | null;
  lang: "vi" | "en";
  onAccept: (serviceId: string, serviceName: string, priceCents: number) => void;
};

type UpsellData = {
  service_id: string;
  service_name: string;
  price_cents: number;
  reason: string;
  confidence: number;
  session_id: string;
};

const DISMISS_KEY = (salonId: string, phone: string) =>
  `nq-upsell-dismiss-${salonId}-${phone}`;

function getDismissState(key: string): { count: number; until: number } {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : { count: 0, until: 0 };
  } catch {
    return { count: 0, until: 0 };
  }
}

function recordDismiss(key: string) {
  const state = getDismissState(key);
  const count = state.count + 1;
  // After 3 dismissals, suppress for 90 days
  const until = count >= 3 ? Date.now() + 90 * 24 * 60 * 60 * 1000 : 0;
  try {
    localStorage.setItem(key, JSON.stringify({ count: count >= 3 ? 0 : count, until }));
  } catch {}
}

export function UpsellSuggestion({ salonId, clientPhone, selectedServiceId, lang, onAccept }: Props) {
  const [upsell, setUpsell] = useState<UpsellData | null>(null);
  const [visible, setVisible] = useState(false);
  const sessionId = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!clientPhone || !selectedServiceId) return;

    const key = DISMISS_KEY(salonId, clientPhone);
    const state = getDismissState(key);
    if (state.until > Date.now()) return; // suppressed

    fetch(
      `/api/upsell?salon_id=${salonId}&phone=${encodeURIComponent(clientPhone)}&selected_service_id=${selectedServiceId}&session_id=${sessionId.current}`
    )
      .then((r) => r.json())
      .then((data: UpsellData | { available: false }) => {
        if ("service_id" in data) {
          setUpsell(data);
          setVisible(true);
        }
      })
      .catch(() => {});
  }, [salonId, clientPhone, selectedServiceId]);

  const handleAccept = useCallback(() => {
    if (!upsell) return;
    setVisible(false);
    fetch("/api/upsell/outcome", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: upsell.session_id, outcome: "accepted" }),
    }).catch(() => {});
    onAccept(upsell.service_id, upsell.service_name, upsell.price_cents);
  }, [upsell, onAccept]);

  const handleDismiss = useCallback(() => {
    if (!upsell || !clientPhone) return;
    setVisible(false);
    recordDismiss(DISMISS_KEY(salonId, clientPhone));
    fetch("/api/upsell/outcome", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: upsell.session_id, outcome: "dismissed" }),
    }).catch(() => {});
  }, [upsell, clientPhone, salonId]);

  if (!visible || !upsell) return null;

  const t = {
    addTo: lang === "vi" ? "Thêm vào dịch vụ?" : "Add to your visit?",
    price: lang === "vi" ? "Giá" : "Price",
    add: lang === "vi" ? "Thêm vào" : "Add this",
    skip: lang === "vi" ? "Bỏ qua" : "Skip",
    free: lang === "vi" ? "Miễn phí" : "Free",
  };

  const priceLabel =
    upsell.price_cents === 0
      ? t.free
      : `+$${(upsell.price_cents / 100).toFixed(0)}`;

  return (
    <div className="mt-4 rounded-2xl border border-nq-primary/30 bg-nq-surface p-4 shadow-[var(--shadow-nq-card)]">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-nq-primary">
            {t.addTo}
          </p>
          <p className="mt-0.5 text-base font-semibold text-nq-foreground">
            {upsell.service_name}
          </p>
          <p className="text-sm text-nq-muted">{upsell.reason}</p>
        </div>
        <span className="shrink-0 rounded-lg bg-nq-primary/10 px-2 py-1 text-sm font-bold text-nq-primary">
          {priceLabel}
        </span>
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleAccept}
          className="flex-1 rounded-xl bg-nq-primary py-2.5 text-sm font-semibold text-nq-bg transition-opacity hover:opacity-90 active:scale-[0.97]"
        >
          {t.add}
        </button>
        <button
          onClick={handleDismiss}
          className="rounded-xl border border-nq-border/60 px-4 py-2.5 text-sm text-nq-muted transition-colors hover:text-nq-foreground"
        >
          {t.skip}
        </button>
      </div>
    </div>
  );
}
