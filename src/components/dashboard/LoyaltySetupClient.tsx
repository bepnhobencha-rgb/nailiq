"use client";

import { useState, useTransition } from "react";
import { StampCard } from "@/components/loyalty/StampCard";
import { createOrUpdateLoyaltyProgram } from "@/shared/loyalty/loyaltyActions";
import { createGiftCard } from "@/shared/loyalty/giftCardActions";
import { GIFT_CARD_PURCHASE_ENABLED } from "@/shared/loyalty/giftCardConfig";
import { formatPublicMonthlyPrice } from "@/shared/subscriptions/pricingCatalog";
import type { LoyaltyProgram, GiftCard } from "@/shared/loyalty/types";

const inputClass = "w-full rounded-lg bg-[#1c1c1e] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#a1a1aa]/40 focus:outline-none focus:border-[#d4af37]/40";
const labelClass = "text-xs text-[#a1a1aa] mb-1 block";
const selectClass = "w-full rounded-lg bg-[#1c1c1e] border border-white/10 px-3 py-2 text-sm text-white focus:outline-none focus:border-[#d4af37]/40";

const PRESET_COLORS = ["#D4AF37", "#E57373", "#64B5F6", "#81C784", "#BA68C8", "#FF8A65"];
const GIFT_DENOMINATIONS = [2500, 5000, 7500, 10000];

type Props = {
  slug: string;
  salonId: string;
  isPremium: boolean;
  program: LoyaltyProgram | null;
  giftCards: GiftCard[];
  services: { id: string; name: string }[];
};

export function LoyaltySetupClient({ slug, salonId, isPremium, program, giftCards, services }: Props) {
  const [tab, setTab] = useState<"stamp" | "gift">("stamp");

  if (!isPremium) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <h1 className="text-2xl font-semibold text-white mb-2">Loyalty & Gift Cards</h1>
        <div className="mt-8 rounded-2xl border border-[#D4AF37]/30 bg-[#D4AF37]/05 p-8 text-center">
          <div className="text-4xl mb-4">⭐</div>
          <h2 className="text-lg font-semibold text-white mb-2">Studio Feature</h2>
          <p className="text-sm text-[#a1a1aa] mb-6">
            Loyalty stamp cards and gift cards are available on the <strong className="text-white">Studio plan ({formatPublicMonthlyPrice("premium")}/month)</strong>.
          </p>
          <a
            href={`/dashboard/${slug}/settings`}
            className="inline-flex items-center gap-2 rounded-full bg-[#D4AF37] px-6 py-2.5 text-sm font-semibold text-black hover:brightness-105 transition-all"
          >
            Upgrade to Studio →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold text-white mb-1">Loyalty & Gift Cards</h1>
      <p className="text-sm text-[#a1a1aa] mb-6">Tính năng Studio — giữ chân khách hàng</p>

      <div className="flex gap-1 mb-6 bg-[#1c1c1e] rounded-xl p-1 w-fit">
        {(["stamp", "gift"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t ? "bg-[#2c2c2e] text-white" : "text-[#a1a1aa] hover:text-white"
            }`}
          >
            {t === "stamp" ? "🎟 Stamp Card" : "🎁 Gift Cards"}
          </button>
        ))}
      </div>

      {tab === "stamp" ? (
        <StampCardTab slug={slug} program={program} services={services} />
      ) : (
        <GiftCardTab slug={slug} salonId={salonId} giftCards={giftCards} />
      )}
    </div>
  );
}

function StampCardTab({
  slug,
  program,
  services,
}: {
  slug: string;
  program: LoyaltyProgram | null;
  services: { id: string; name: string }[];
}) {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");

  const [isActive, setIsActive] = useState(program?.is_active ?? true);
  const [name, setName] = useState(program?.name ?? "Loyalty Rewards");
  const [stampsRequired, setStampsRequired] = useState(program?.stamps_required ?? 10);
  const [stampsPerVisit, setStampsPerVisit] = useState(program?.stamps_per_visit ?? 1);
  const [minSpend, setMinSpend] = useState((program?.min_spend_cents ?? 0) / 100);
  const [rewardType, setRewardType] = useState<"free_service" | "percent_off" | "amount_off">(
    program?.reward_type ?? "free_service"
  );
  const [rewardServiceId, setRewardServiceId] = useState(program?.reward_service_id ?? "");
  const [rewardPercent, setRewardPercent] = useState(program?.reward_percent_off ?? 10);
  const [rewardAmount, setRewardAmount] = useState((program?.reward_amount_off_cents ?? 0) / 100);
  const [color, setColor] = useState(program?.color ?? "#D4AF37");
  // Voucher validity (days). Empty → platform default (90). Per-salon.
  const [voucherValidDays, setVoucherValidDays] = useState(
    program?.voucher_valid_days ?? 90,
  );

  function rewardLabel() {
    if (rewardType === "percent_off") return `${rewardPercent}% off`;
    if (rewardType === "amount_off") return `$${rewardAmount} off`;
    const svc = services.find((s) => s.id === rewardServiceId);
    return svc ? `free ${svc.name}` : "free service";
  }

  function handleSave() {
    startTransition(async () => {
      const result = await createOrUpdateLoyaltyProgram(slug, {
        name,
        is_active: isActive,
        stamps_required: stampsRequired,
        stamps_per_visit: stampsPerVisit,
        min_spend_cents: Math.round(minSpend * 100),
        reward_type: rewardType,
        reward_service_id: rewardType === "free_service" ? rewardServiceId || null : null,
        reward_percent_off: rewardType === "percent_off" ? rewardPercent : null,
        reward_amount_off_cents: rewardType === "amount_off" ? Math.round(rewardAmount * 100) : null,
        color,
        voucher_valid_days: voucherValidDays,
      });
      setStatus(result.ok ? "saved" : "error");
      setTimeout(() => setStatus("idle"), 2500);
    });
  }

  return (
    <div className="grid lg:grid-cols-[1fr_320px] gap-6">
      <div className="space-y-5">
        <div className="flex items-center justify-between p-4 rounded-xl bg-[#1c1c1e] border border-white/10">
          <div>
            <p className="text-sm font-medium text-white">Enable loyalty program</p>
            <p className="text-xs text-[#a1a1aa] mt-0.5">Auto-stamp when booking is marked completed</p>
          </div>
          <button
            onClick={() => setIsActive(!isActive)}
            className={`relative h-6 w-11 rounded-full transition-colors ${isActive ? "bg-[#D4AF37]" : "bg-[#3a3a3c]"}`}
          >
            <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${isActive ? "translate-x-5" : ""}`} />
          </button>
        </div>

        <div>
          <label className={labelClass}>Program name</label>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Loyalty Rewards" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Stamps needed for reward ({stampsRequired})</label>
            <input type="range" min={3} max={20} value={stampsRequired} onChange={(e) => setStampsRequired(+e.target.value)} className="w-full accent-[#D4AF37]" />
            <div className="flex justify-between text-[10px] text-[#a1a1aa] mt-1"><span>3</span><span>20</span></div>
          </div>
          <div>
            <label className={labelClass}>Stamps per visit ({stampsPerVisit})</label>
            <input type="range" min={1} max={3} value={stampsPerVisit} onChange={(e) => setStampsPerVisit(+e.target.value)} className="w-full accent-[#D4AF37]" />
            <div className="flex justify-between text-[10px] text-[#a1a1aa] mt-1"><span>1</span><span>3</span></div>
          </div>
        </div>

        <div>
          <label className={labelClass}>Minimum spend per visit ($)</label>
          <input type="number" className={inputClass} min={0} step={5} value={minSpend} onChange={(e) => setMinSpend(+e.target.value)} placeholder="0" />
          <p className="text-[10px] text-[#a1a1aa] mt-1">0 = no minimum</p>
        </div>

        <div>
          <label className={labelClass}>Reward voucher valid for (days)</label>
          <input
            type="number"
            className={inputClass}
            min={7}
            max={365}
            step={1}
            value={voucherValidDays}
            onChange={(e) => setVoucherValidDays(+e.target.value)}
            placeholder="90"
          />
          <p className="text-[10px] text-[#a1a1aa] mt-1">
            How long a redeemed reward stays usable (7–365). Default 90.
          </p>
        </div>

        <div>
          <label className={labelClass}>Reward type</label>
          <div className="space-y-2">
            {(["free_service", "percent_off", "amount_off"] as const).map((rt) => (
              <label key={rt} className="flex items-center gap-3 cursor-pointer">
                <input type="radio" name="rewardType" checked={rewardType === rt} onChange={() => setRewardType(rt)} className="accent-[#D4AF37]" />
                <span className="text-sm text-white">
                  {rt === "free_service" ? "Free service" : rt === "percent_off" ? "% discount" : "$ amount off"}
                </span>
              </label>
            ))}
          </div>

          {rewardType === "free_service" && (
            <div className="mt-3">
              <select className={selectClass} value={rewardServiceId} onChange={(e) => setRewardServiceId(e.target.value)}>
                <option value="">Select service…</option>
                {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {rewardType === "percent_off" && (
            <div className="mt-3">
              <input type="number" className={inputClass} min={1} max={100} value={rewardPercent} onChange={(e) => setRewardPercent(+e.target.value)} placeholder="10" />
              <p className="text-[10px] text-[#a1a1aa] mt-1">% discount on next visit</p>
            </div>
          )}
          {rewardType === "amount_off" && (
            <div className="mt-3">
              <input type="number" className={inputClass} min={1} value={rewardAmount} onChange={(e) => setRewardAmount(+e.target.value)} placeholder="20" />
              <p className="text-[10px] text-[#a1a1aa] mt-1">$ off next visit</p>
            </div>
          )}
        </div>

        <div>
          <label className={labelClass}>Card color</label>
          <div className="flex gap-2 flex-wrap">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`h-8 w-8 rounded-full border-2 transition-transform ${color === c ? "border-white scale-110" : "border-transparent"}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={isPending}
            className="px-6 py-2.5 rounded-full bg-[#D4AF37] text-black text-sm font-semibold hover:brightness-105 disabled:opacity-50 transition-all"
          >
            {isPending ? "Saving…" : "Save program"}
          </button>
          {status === "saved" && <span className="text-xs text-green-400">Saved ✓</span>}
          {status === "error" && <span className="text-xs text-red-400">Error saving</span>}
        </div>
      </div>

      <div className="space-y-4">
        <p className="text-xs text-[#a1a1aa] font-medium uppercase tracking-widest">Preview</p>
        <StampCard
          current={3}
          required={stampsRequired}
          color={color}
          programName={name}
          rewardLabel={rewardLabel()}
        />
        <p className="text-[10px] text-[#a1a1aa]">Preview shows 3/{stampsRequired} stamps</p>
      </div>
    </div>
  );
}

function GiftCardTab({
  slug,
  salonId,
  giftCards,
}: {
  slug: string;
  salonId: string;
  giftCards: GiftCard[];
}) {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "created" | "error">("idle");
  const [newCode, setNewCode] = useState<string | null>(null);
  const [valueCents, setValueCents] = useState(5000);
  const [fromName, setFromName] = useState("");
  const [message, setMessage] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");

  function handleCreate() {
    startTransition(async () => {
      const result = await createGiftCard(slug, {
        valueCents,
        fromName: fromName || undefined,
        message: message || undefined,
        recipientPhone: recipientPhone || undefined,
      });
      if (result.ok && result.voucher) {
        setNewCode(result.voucher.code);
        setStatus("created");
        setFromName("");
        setMessage("");
        setRecipientPhone("");
      } else {
        setStatus("error");
      }
      setTimeout(() => { setStatus("idle"); setNewCode(null); }, 5000);
    });
  }

  const publicUrl = typeof window !== "undefined"
    ? `${window.location.origin}/${slug}/gift`
    : `nailiq.ca/${slug}/gift`;

  return (
    <div className="space-y-6">
      {GIFT_CARD_PURCHASE_ENABLED && (
      <div className="p-4 rounded-xl bg-[#1c1c1e] border border-white/10">
        <p className="text-sm text-white font-medium mb-1">Public gift card page</p>
        <p className="text-xs text-[#a1a1aa] mb-3">Share this link so customers can purchase gift cards online.</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-lg bg-black/30 px-3 py-2 text-xs text-[#D4AF37] truncate">
            nailiq.ca/{slug}/gift
          </code>
          <button
            onClick={() => navigator.clipboard?.writeText(`https://nailiq.ca/${slug}/gift`)}
            className="shrink-0 px-3 py-2 rounded-lg border border-white/10 text-xs text-[#a1a1aa] hover:text-white transition-colors"
          >
            Copy
          </button>
        </div>
      </div>
      )}

      <div className="p-5 rounded-xl bg-[#1c1c1e] border border-white/10 space-y-4">
        <p className="text-sm font-semibold text-white">Issue gift card manually</p>

        <div>
          <label className={labelClass}>Value</label>
          <div className="flex gap-2 flex-wrap">
            {GIFT_DENOMINATIONS.map((d) => (
              <button
                key={d}
                onClick={() => setValueCents(d)}
                className={`px-4 py-1.5 rounded-full text-sm border transition-colors ${
                  valueCents === d
                    ? "bg-[#D4AF37] text-black border-[#D4AF37]"
                    : "border-white/20 text-white hover:border-white/40"
                }`}
              >
                ${d / 100}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>From (optional)</label>
            <input className={inputClass} value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Sender name" />
          </div>
          <div>
            <label className={labelClass}>Recipient phone (optional)</label>
            <input className={inputClass} value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} placeholder="+1 604 555 0100" />
          </div>
        </div>

        <div>
          <label className={labelClass}>Message (optional)</label>
          <input className={inputClass} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Happy birthday! Enjoy your treatment." />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleCreate}
            disabled={isPending}
            className="px-5 py-2 rounded-full bg-[#D4AF37] text-black text-sm font-semibold hover:brightness-105 disabled:opacity-50 transition-all"
          >
            {isPending ? "Creating…" : `Issue $${valueCents / 100} gift card`}
          </button>
          {status === "error" && <span className="text-xs text-red-400">Error</span>}
        </div>

        {newCode && (
          <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20">
            <p className="text-xs text-green-400 mb-1">Gift card created!</p>
            <code className="text-sm font-bold text-white tracking-widest">{newCode}</code>
          </div>
        )}
      </div>

      {giftCards.length > 0 && (
        <div>
          <p className="text-xs text-[#a1a1aa] font-medium uppercase tracking-widest mb-3">Recent gift cards</p>
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="px-4 py-3 text-left text-xs text-[#a1a1aa]">Code</th>
                  <th className="px-4 py-3 text-left text-xs text-[#a1a1aa]">Value</th>
                  <th className="px-4 py-3 text-left text-xs text-[#a1a1aa]">From</th>
                  <th className="px-4 py-3 text-left text-xs text-[#a1a1aa]">Status</th>
                </tr>
              </thead>
              <tbody>
                {giftCards.map((gc) => (
                  <tr key={gc.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="px-4 py-3 font-mono text-xs text-[#D4AF37]">{gc.code}</td>
                    <td className="px-4 py-3 text-white">${(gc.gift_card_value_cents ?? 0) / 100}</td>
                    <td className="px-4 py-3 text-[#a1a1aa]">{gc.gift_card_from_name ?? "—"}</td>
                    <td className="px-4 py-3">
                      {gc.revoked_at ? (
                        <span className="text-red-400 text-xs">Revoked</span>
                      ) : gc.used_count >= gc.max_uses ? (
                        <span className="text-[#a1a1aa] text-xs">Used</span>
                      ) : (
                        <span className="text-green-400 text-xs">Active</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
