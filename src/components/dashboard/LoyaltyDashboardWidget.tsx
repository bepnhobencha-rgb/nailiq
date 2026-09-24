"use client";

import { useState, useTransition, useEffect, useRef, useId } from "react";
import { StampCard } from "@/components/loyalty/StampCard";
import { Button } from "@/components/ui/Button";
import { getClientLoyaltyCard, addStampsManually, getLoyaltyProgram, getLoyaltyStats } from "@/shared/loyalty/loyaltyActions";
import type { LoyaltyCard, LoyaltyProgram, LoyaltyStats } from "@/shared/loyalty/types";
import { LOYALTY_VALUE_MUTATIONS_ENABLED } from "@/shared/loyalty/loyaltyRuntimeConfig";

type Props = { slug: string; language: "en" | "vi"; refreshToken?: number };
type LoadState =
  | { slug: string; ok: true; program: LoyaltyProgram | null; stats: LoyaltyStats | null }
  | { slug: string; ok: false; retrying?: boolean };

export function LoyaltyDashboardWidget({ slug, language, refreshToken = 0 }: Props) {
  const L = (en: string, vi: string) => language === "vi" ? vi : en;
  const [load, setLoad] = useState<LoadState | null>(null);
  const [retry, setRetry] = useState(0);

  const [phone, setPhone] = useState("");
  const [card, setCard] = useState<LoyaltyCard | null>(null);
  const [looking, startLookup] = useTransition();
  const [adjusting, startAdjust] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);
  const lookupVersion = useRef(0);
  const readOnlyId = useId();

  useEffect(() => {
    let active = true;
    void Promise.all([getLoyaltyProgram(slug), getLoyaltyStats(slug)]).then(
      ([program, stats]) => {
        if (active) setLoad({ slug, ok: true, program, stats });
      },
      () => {
        if (active) setLoad({ slug, ok: false });
      },
    );
    return () => { active = false; };
  }, [slug, retry, refreshToken]);

  // A stats refresh is independent of the phone lookup. Only changing salon
  // or unmounting invalidates it; input edits already invalidate in onChange.
  useEffect(() => () => { lookupVersion.current += 1; }, [slug]);

  function handleLookup() {
    if (!phone.trim() || looking) return;
    const version = ++lookupVersion.current;
    setCard(null);
    setMsg(null);
    setLookupFailed(false);
    startLookup(async () => {
      try {
        const result = await getClientLoyaltyCard(slug, phone.trim());
        if (lookupVersion.current !== version) return;
        setCard(result);
        setMsg(result ? null : L("No card found for this number.", "Không tìm thấy thẻ cho số điện thoại này."));
      } catch {
        if (lookupVersion.current !== version) return;
        setLookupFailed(true);
      }
    });
  }

  function handleAdjust(delta: number) {
    // Match the server's hard gate; never invite a write that cannot succeed.
    if (!LOYALTY_VALUE_MUTATIONS_ENABLED || !phone.trim()) return;
    startAdjust(async () => {
      const result = await addStampsManually(slug, phone.trim(), delta, "Manual adjustment");
      if (result.ok) {
        setMsg(delta > 0 ? L(`+${delta} stamp added`, `Đã thêm ${delta} điểm`) : L(`${Math.abs(delta)} stamp removed`, `Đã trừ ${Math.abs(delta)} điểm`));
        handleLookup();
      } else {
        setMsg(result.error ?? L("Error", "Có lỗi xảy ra"));
      }
    });
  }

  if (!load || load.slug !== slug) return null;

  if (!load.ok) {
    return (
      <div role="alert" className="mb-12 rounded-2xl border border-nq-border bg-nq-surface p-5 space-y-4 xl:mb-0">
        <h3 className="text-sm font-semibold text-nq-foreground">🎟 {L("Loyalty", "Tích điểm")}</h3>
        <p className="text-sm text-nq-muted">
          {language === "vi" ? "Chưa tải được thông tin tích điểm" : "Unable to load loyalty information"}
        </p>
        <Button variant="secondary" size="lg" loading={load.retrying} onClick={() => {
          setLoad({ slug, ok: false, retrying: true });
          setRetry(value => value + 1);
        }}>
          {language === "vi" ? "Thử tải lại tích điểm" : "Retry loyalty load"}
        </Button>
      </div>
    );
  }

  const { program, stats } = load;

  return (
    <div className="mb-12 rounded-2xl border border-white/10 bg-[#1c1c1e] p-5 space-y-4 xl:mb-0">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">🎟 {L("Loyalty", "Tích điểm")}</h3>
        <a href={`/dashboard/${slug}/setup/loyalty`} className="inline-flex min-h-11 items-center text-xs text-[#D4AF37] hover:underline">
          {L("Setup", "Thiết lập")} →
        </a>
      </div>

      {program ? (
        <>
          {!LOYALTY_VALUE_MUTATIONS_ENABLED && (
            <p id={readOnlyId} className="text-sm text-nq-muted">
              {L("Read only: adding or removing stamps and redeeming rewards are currently unavailable.", "Chỉ xem: hiện chưa hỗ trợ cộng, trừ điểm hoặc đổi quà.")}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-black/20 p-3 text-center">
              <p className="text-2xl font-bold text-white">{stats?.totalCards ?? 0}</p>
              <p className="text-[10px] text-[#a1a1aa] mt-0.5">{L("Total cards", "Tổng số thẻ")}</p>
            </div>
            <div className="rounded-xl bg-black/20 p-3 text-center">
              <p className="text-2xl font-bold text-[#D4AF37]">{stats?.stampsIssuedToday ?? 0}</p>
              <p className="text-[10px] text-[#a1a1aa] mt-0.5">{L("Stamps today", "Điểm hôm nay")}</p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-[#a1a1aa]">{L("Quick lookup", "Tra cứu nhanh")}</p>
            <div className="flex gap-2">
              <input
                value={phone}
                onChange={(e) => {
                  lookupVersion.current += 1;
                  setPhone(e.target.value);
                  setCard(null);
                  setMsg(null);
                  setLookupFailed(false);
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") handleLookup();
                }}
                placeholder="+1 604 555 0100"
                type="tel"
                aria-label={L("Customer phone number", "Số điện thoại khách hàng")}
                className="min-h-11 min-w-0 flex-1 rounded-lg bg-black/20 border border-white/10 px-3 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-[#D4AF37]/40"
              />
              <Button
                onClick={handleLookup}
                disabled={!phone.trim()}
                loading={looking}
                className="min-h-11 px-3 text-xs"
              >
                {L("Look up", "Tra cứu")}
              </Button>
            </div>

            {card && (
              <div className="space-y-2">
                <StampCard
                  current={card.stamps_current}
                  required={program.stamps_required}
                  color={program.color}
                  programName={program.name}
                  stampsLabel={L("stamps", "điểm")}
                  compact
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAdjust(1)}
                    disabled={adjusting || !LOYALTY_VALUE_MUTATIONS_ENABLED}
                    aria-describedby={!LOYALTY_VALUE_MUTATIONS_ENABLED ? readOnlyId : undefined}
                    className="min-h-11 flex-1 rounded-lg border border-white/10 py-1.5 text-xs text-white hover:bg-white/5 disabled:opacity-50"
                  >
                    {L("+1 stamp", "+1 điểm")}
                  </button>
                  <button
                    onClick={() => handleAdjust(-1)}
                    disabled={adjusting || !LOYALTY_VALUE_MUTATIONS_ENABLED}
                    aria-describedby={!LOYALTY_VALUE_MUTATIONS_ENABLED ? readOnlyId : undefined}
                    className="min-h-11 flex-1 rounded-lg border border-white/10 py-1.5 text-xs text-[#a1a1aa] hover:bg-white/5 disabled:opacity-50"
                  >
                    {L("−1 stamp", "−1 điểm")}
                  </button>
                </div>
              </div>
            )}

            {lookupFailed && <p role="alert" className="text-sm text-nq-muted">{L("Unable to look up the card. Please try again.", "Chưa tra cứu được thẻ. Vui lòng thử lại.")}</p>}
            {msg && <p role="status" className="text-xs text-[#a1a1aa]">{msg}</p>}
          </div>
        </>
      ) : (
        <p className="text-xs text-[#a1a1aa]">
          {L("No program configured.", "Chưa thiết lập chương trình.")}{" "}
          <a href={`/dashboard/${slug}/setup/loyalty`} className="inline-flex min-h-11 items-center text-[#D4AF37] hover:underline">
            {L("Set up loyalty", "Thiết lập tích điểm")} →
          </a>
        </p>
      )}
    </div>
  );
}
