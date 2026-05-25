"use client";

import { useState, useTransition } from "react";

const DENOMINATIONS = [25, 50, 75, 100];

type Props = {
  slug: string;
  salonName: string;
  brandColor: string;
};

export function GiftCardPurchasePanel({ slug, salonName, brandColor }: Props) {
  const [amount, setAmount] = useState(50);
  const [fromName, setFromName] = useState("");
  const [message, setMessage] = useState("");
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState<"select" | "confirm" | "done">("select");
  const [code, setCode] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const inputClass = "w-full rounded-lg bg-white/[0.07] border border-white/10 px-3 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-[var(--salon-primary)]/40";
  const labelClass = "text-xs text-white/50 mb-1 block";

  function handlePurchase() {
    startTransition(async () => {
      const res = await fetch(`/api/gift-card/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, valueCents: amount * 100, fromName, message, recipientPhone: phone }),
      });
      if (res.ok) {
        const data = await res.json();
        setCode(data.code);
        setStep("done");
      }
    });
  }

  if (step === "done" && code) {
    return (
      <div className="text-center space-y-6">
        <div className="text-5xl">🎁</div>
        <h1 className="text-2xl font-semibold text-white">Gift Card Created!</h1>
        <p className="text-white/60 text-sm">Share this code with the recipient.</p>
        <div className="rounded-2xl border-2 p-6" style={{ borderColor: brandColor }}>
          <p className="text-xs text-white/50 mb-2">Gift Card Code</p>
          <p className="text-2xl font-bold tracking-widest" style={{ color: brandColor }}>{code}</p>
          <p className="text-sm text-white/60 mt-2">${amount} at {salonName}</p>
        </div>
        <button
          onClick={() => navigator.clipboard?.writeText(code)}
          className="w-full rounded-full py-3 text-sm font-semibold text-black transition-all hover:brightness-105"
          style={{ background: brandColor }}
        >
          Copy code
        </button>
        <p className="text-xs text-white/40">Valid for 12 months. Redeemable at checkout.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">{salonName}</h1>
        <p className="text-white/60 text-sm mt-1">Gift Cards</p>
      </div>

      <div>
        <label className={labelClass}>Select amount</label>
        <div className="grid grid-cols-4 gap-2">
          {DENOMINATIONS.map((d) => (
            <button
              key={d}
              onClick={() => setAmount(d)}
              className="rounded-xl py-3 text-sm font-semibold border transition-all"
              style={{
                borderColor: amount === d ? brandColor : "rgba(255,255,255,0.1)",
                background: amount === d ? `${brandColor}20` : "transparent",
                color: amount === d ? brandColor : "rgba(255,255,255,0.7)",
              }}
            >
              ${d}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className={labelClass}>From (optional)</label>
          <input className={inputClass} value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Your name" />
        </div>
        <div>
          <label className={labelClass}>Personal message (optional)</label>
          <textarea
            className={`${inputClass} resize-none`}
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Happy birthday! Treat yourself…"
          />
        </div>
        <div>
          <label className={labelClass}>Recipient phone (optional)</label>
          <input className={inputClass} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 604 555 0100" />
        </div>
      </div>

      <button
        onClick={handlePurchase}
        disabled={isPending}
        className="w-full rounded-full py-3.5 text-sm font-semibold text-black transition-all hover:brightness-105 disabled:opacity-50"
        style={{ background: brandColor }}
      >
        {isPending ? "Creating…" : `Get $${amount} Gift Card`}
      </button>

      <p className="text-xs text-white/30 text-center">
        Gift cards are valid for 12 months and can be redeemed at {salonName}.
      </p>
    </div>
  );
}
