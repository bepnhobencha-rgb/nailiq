"use client";

import { useEffect, useState, useCallback } from "react";

type Props = {
  salonId: string;
  phone: string;
  salonSlug: string;
  salonName: string;
};

type CreateReferralResponse = {
  code: string;
  share_url: string;
  referrer_reward: number;
  referee_reward: number;
};

/**
 * ReferralShareCard — shown on the booking success screen.
 * Fetches or creates a referral code and surfaces share buttons.
 */
export function ReferralShareCard({ salonId, phone, salonSlug, salonName }: Props) {
  const [referral, setReferral] = useState<CreateReferralResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchReferral() {
      try {
        const res = await fetch("/api/referrals/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ salon_id: salonId, phone }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as CreateReferralResponse;
        if (!cancelled) setReferral(data);
      } catch {
        // Silently fail — referral is non-critical
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchReferral();
    return () => {
      cancelled = true;
    };
  }, [salonId, phone]);

  const trackShare = useCallback(
    async (channel: string) => {
      try {
        await fetch("/api/referrals/track-share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ salon_id: salonId, phone, channel }),
        });
      } catch {
        // Non-critical
      }
    },
    [salonId, phone],
  );

  const handleCopy = useCallback(async () => {
    if (!referral) return;
    try {
      await navigator.clipboard.writeText(referral.share_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard not available
    }
    void trackShare("copy");
  }, [referral, trackShare]);

  const handleWhatsApp = useCallback(() => {
    if (!referral) return;
    const text = encodeURIComponent(
      `Book at ${salonName} and get ${referral.referee_reward}% off your first visit! ${referral.share_url}`,
    );
    window.open(`https://wa.me/?text=${text}`, "_blank", "noopener,noreferrer");
    void trackShare("whatsapp");
  }, [referral, salonName, trackShare]);

  const handleZalo = useCallback(() => {
    if (!referral) return;
    // Zalo share via zalo.me deep link
    const text = encodeURIComponent(
      `Đặt lịch tại ${salonName} và nhận giảm ${referral.referee_reward}%! ${referral.share_url}`,
    );
    window.open(`https://zalo.me/share?text=${text}`, "_blank", "noopener,noreferrer");
    void trackShare("zalo");
  }, [referral, salonName, trackShare]);

  const handleInstagram = useCallback(() => {
    if (!referral) return;
    // Instagram doesn't support deep link sharing with URL — copy to clipboard
    // and open Instagram Stories camera as best UX available
    void handleCopy();
    void trackShare("instagram");
    window.open("instagram://camera", "_blank");
  }, [handleCopy, trackShare]);

  if (loading) {
    return (
      <div
        className="w-full animate-pulse rounded-2xl p-4"
        style={{
          background: "rgba(212,175,55,0.05)",
          borderColor: "rgba(212,175,55,0.15)",
          border: "1px solid",
        }}
      >
        <div className="h-4 w-2/3 rounded bg-white/10" />
        <div className="mt-2 h-3 w-1/2 rounded bg-white/5" />
      </div>
    );
  }

  if (!referral) return null;

  return (
    <div
      className="fade-in-1 w-full rounded-2xl p-4"
      style={{
        background: "rgba(212,175,55,0.06)",
        border: "1px solid rgba(212,175,55,0.22)",
      }}
      role="region"
      aria-label="Bring a Friend offer"
    >
      {/* Header */}
      <div className="mb-3 flex items-start gap-3">
        <span
          className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base"
          style={{ background: "rgba(212,175,55,0.15)", color: "#d4af37" }}
          aria-hidden
        >
          🎁
        </span>
        <div>
          <p className="text-sm font-semibold text-white">
            Bring a Friend, Earn {referral.referrer_reward}% Off
          </p>
          <p className="mt-0.5 text-xs" style={{ color: "#a1a1aa" }}>
            Your friend gets {referral.referee_reward}% off their first visit too
          </p>
        </div>
      </div>

      {/* Share URL display */}
      <div
        className="mb-3 flex items-center gap-2 rounded-xl px-3 py-2.5"
        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs" style={{ color: "#d4af37" }}>
          {referral.share_url}
        </span>
      </div>

      {/* Share buttons */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-colors hover:bg-white/10"
          style={{
            background: "rgba(255,255,255,0.07)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: copied ? "#22c55e" : "#ffffff",
          }}
        >
          {copied ? (
            <>
              <span aria-hidden>✓</span> Copied!
            </>
          ) : (
            <>
              <span aria-hidden>🔗</span> Copy link
            </>
          )}
        </button>

        <button
          type="button"
          onClick={handleWhatsApp}
          className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-opacity hover:opacity-90"
          style={{
            background: "#25D366",
            color: "#ffffff",
          }}
        >
          <span aria-hidden>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
            </svg>
          </span>
          WhatsApp
        </button>

        <button
          type="button"
          onClick={handleZalo}
          className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-opacity hover:opacity-90"
          style={{
            background: "#0068FF",
            color: "#ffffff",
          }}
        >
          <span aria-hidden className="font-bold text-sm">Z</span>
          Zalo
        </button>

        <button
          type="button"
          onClick={handleInstagram}
          className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-opacity hover:opacity-90"
          style={{
            background: "linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)",
            color: "#ffffff",
          }}
        >
          <span aria-hidden>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
            </svg>
          </span>
          Stories
        </button>
      </div>
    </div>
  );
}

export default ReferralShareCard;
