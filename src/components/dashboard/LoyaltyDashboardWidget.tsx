"use client";

import { useState, useTransition, useEffect } from "react";
import { StampCard } from "@/components/loyalty/StampCard";
import { getClientLoyaltyCard, addStampsManually, getLoyaltyProgram, getLoyaltyStats } from "@/shared/loyalty/loyaltyActions";
import type { LoyaltyCard, LoyaltyProgram, LoyaltyStats } from "@/shared/loyalty/types";

type Props = { slug: string };

export function LoyaltyDashboardWidget({ slug }: Props) {
  const [stats, setStats] = useState<LoyaltyStats | null>(null);
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [phone, setPhone] = useState("");
  const [card, setCard] = useState<LoyaltyCard | null>(null);
  const [looking, startLookup] = useTransition();
  const [adjusting, startAdjust] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([getLoyaltyProgram(slug), getLoyaltyStats(slug)]).then(
      ([prog, st]) => {
        setProgram(prog);
        setStats(st);
        setLoaded(true);
      },
    );
  }, [slug]);

  function handleLookup() {
    if (!phone.trim()) return;
    startLookup(async () => {
      const result = await getClientLoyaltyCard(slug, phone.trim());
      setCard(result);
      setMsg(result ? null : "No card found for this number.");
    });
  }

  function handleAdjust(delta: number) {
    if (!phone.trim()) return;
    startAdjust(async () => {
      const result = await addStampsManually(slug, phone.trim(), delta, "Manual adjustment");
      if (result.ok) {
        setMsg(delta > 0 ? `+${delta} stamp added` : `${delta} stamp removed`);
        handleLookup();
      } else {
        setMsg(result.error ?? "Error");
      }
    });
  }

  if (!loaded) return null;

  return (
    <div className="rounded-2xl border border-white/10 bg-[#1c1c1e] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">🎟 Loyalty</h3>
        <a href={`/dashboard/${slug}/setup/loyalty`} className="text-xs text-[#D4AF37] hover:underline">
          Setup →
        </a>
      </div>

      {program ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-black/20 p-3 text-center">
              <p className="text-2xl font-bold text-white">{stats?.totalCards ?? 0}</p>
              <p className="text-[10px] text-[#a1a1aa] mt-0.5">Total cards</p>
            </div>
            <div className="rounded-xl bg-black/20 p-3 text-center">
              <p className="text-2xl font-bold text-[#D4AF37]">{stats?.stampsIssuedToday ?? 0}</p>
              <p className="text-[10px] text-[#a1a1aa] mt-0.5">Stamps today</p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-[#a1a1aa]">Quick lookup</p>
            <div className="flex gap-2">
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") handleLookup();
                }}
                placeholder="+1 604 555 0100"
                className="flex-1 rounded-lg bg-black/20 border border-white/10 px-3 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-[#D4AF37]/40"
              />
              <button
                onClick={handleLookup}
                disabled={looking}
                className="px-3 py-2 rounded-lg bg-[#D4AF37] text-black text-xs font-semibold hover:brightness-105 disabled:opacity-50"
              >
                {looking ? "…" : "Look up"}
              </button>
            </div>

            {card && (
              <div className="space-y-2">
                <StampCard
                  current={card.stamps_current}
                  required={program.stamps_required}
                  color={program.color}
                  programName={program.name}
                  compact
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAdjust(1)}
                    disabled={adjusting}
                    className="flex-1 rounded-lg border border-white/10 py-1.5 text-xs text-white hover:bg-white/5 disabled:opacity-50"
                  >
                    +1 stamp
                  </button>
                  <button
                    onClick={() => handleAdjust(-1)}
                    disabled={adjusting}
                    className="flex-1 rounded-lg border border-white/10 py-1.5 text-xs text-[#a1a1aa] hover:bg-white/5 disabled:opacity-50"
                  >
                    −1 stamp
                  </button>
                </div>
              </div>
            )}

            {msg && <p className="text-xs text-[#a1a1aa]">{msg}</p>}
          </div>
        </>
      ) : (
        <p className="text-xs text-[#a1a1aa]">
          No program configured.{" "}
          <a href={`/dashboard/${slug}/setup/loyalty`} className="text-[#D4AF37] hover:underline">
            Set up loyalty →
          </a>
        </p>
      )}
    </div>
  );
}
