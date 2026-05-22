"use client";

// PhotoViewClient — full-screen dark UI customer view
// Shows nail photo, service details, emoji star rating, share/download, re-book CTA.

import { useState } from "react";

type Props = {
  photoId: string;
  photoUrl: string | null;
  token: string;
  clientName: string;
  serviceName: string;
  staffName?: string;
  appointmentDate?: string;
  salonName: string;
  salonSlug: string;
  alreadyRated: boolean;
};

type RatingState =
  | { status: "idle" }
  | { status: "hovered"; value: number }
  | { status: "submitting"; value: number }
  | { status: "done"; value: number; redirectUrl: string | null }
  | { status: "error"; message: string };

const EMOJI_STARS = ["😞", "😐", "🙂", "😊", "🤩"] as const;

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-CA", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export default function PhotoViewClient({
  photoId,
  photoUrl,
  token,
  clientName,
  serviceName,
  staffName,
  appointmentDate,
  salonName,
  salonSlug,
  alreadyRated,
}: Props) {
  const [ratingState, setRatingState] = useState<RatingState>({ status: "idle" });
  const [copied, setCopied] = useState(false);

  async function handleRate(rating: number) {
    setRatingState({ status: "submitting", value: rating });
    try {
      const res = await fetch(`/v/${token}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      });
      const data = (await res.json()) as { redirect?: string | null; error?: string };
      if (!res.ok) {
        setRatingState({ status: "error", message: data.error ?? "Failed to save rating" });
        return;
      }
      setRatingState({ status: "done", value: rating, redirectUrl: data.redirect ?? null });
      // Auto-redirect to Google review if returned
      if (data.redirect) {
        setTimeout(() => {
          window.open(data.redirect!, "_blank", "noopener,noreferrer");
        }, 1200);
      }
    } catch {
      setRatingState({ status: "error", message: "Network error. Please try again." });
    }
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: ignore
    }
  }

  const currentHover =
    ratingState.status === "hovered" ? ratingState.value
    : ratingState.status === "done" ? ratingState.value
    : 0;

  return (
    <div
      className="min-h-dvh flex flex-col"
      style={{ background: "#0b0c10" }}
    >
      {/* Photo — full-width, covers top half */}
      <div className="relative w-full" style={{ aspectRatio: "1 / 1", maxHeight: "60vh" }}>
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl}
            alt={`${clientName}'s ${serviceName}`}
            className="w-full h-full object-cover"
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ background: "#111214" }}
          >
            <span className="text-5xl">💅</span>
          </div>
        )}

        {/* NailIQ wordmark overlay */}
        <div
          className="absolute top-4 left-4 px-3 py-1.5 rounded-full text-xs font-bold"
          style={{
            background: "rgba(11,12,16,0.72)",
            color: "#d4af37",
            border: "1px solid rgba(212,175,55,0.35)",
          }}
        >
          NailIQ
        </div>
      </div>

      {/* Info + actions */}
      <div className="flex-1 flex flex-col gap-5 p-5 pb-safe">
        {/* Service info */}
        <div>
          <h1 className="text-xl font-semibold text-white leading-tight">{serviceName}</h1>
          <p className="text-sm text-[#a1a1aa] mt-1">
            {salonName}
            {staffName ? ` · with ${staffName}` : ""}
            {appointmentDate ? ` · ${formatDate(appointmentDate)}` : ""}
          </p>
        </div>

        {/* Rating */}
        {!alreadyRated && ratingState.status !== "done" ? (
          <div
            className="rounded-2xl p-5"
            style={{ background: "#111214", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            <p className="text-sm font-semibold text-white mb-3">How do you love your nails?</p>
            <div className="flex gap-2 justify-between">
              {EMOJI_STARS.map((emoji, idx) => {
                const value = idx + 1;
                const isActive = value <= currentHover;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-label={`Rate ${value} star${value !== 1 ? "s" : ""}`}
                    disabled={ratingState.status === "submitting"}
                    className="flex-1 flex flex-col items-center gap-1 py-3 rounded-xl transition-all duration-150 disabled:opacity-50"
                    style={{
                      background: isActive ? "rgba(212,175,55,0.14)" : "transparent",
                      border: isActive
                        ? "1px solid rgba(212,175,55,0.45)"
                        : "1px solid rgba(255,255,255,0.06)",
                    }}
                    onMouseEnter={() =>
                      ratingState.status === "idle" &&
                      setRatingState({ status: "hovered", value })
                    }
                    onMouseLeave={() =>
                      ratingState.status === "hovered" && setRatingState({ status: "idle" })
                    }
                    onClick={() => handleRate(value)}
                  >
                    <span className="text-2xl">{emoji}</span>
                    <span className="text-xs text-[#a1a1aa]">{value}</span>
                  </button>
                );
              })}
            </div>
            {ratingState.status === "error" && (
              <p className="text-xs text-[#ef4444] mt-2">{ratingState.message}</p>
            )}
          </div>
        ) : ratingState.status === "done" ? (
          <div
            className="rounded-2xl p-5 text-center"
            style={{
              background: "rgba(34,197,94,0.12)",
              border: "1px solid rgba(34,197,94,0.35)",
            }}
          >
            <p className="text-base font-semibold text-white">
              {ratingState.value >= 4 ? "Awesome! Thank you! 🤩" : "Thanks for your feedback!"}
            </p>
            {ratingState.value >= 4 && ratingState.redirectUrl && (
              <p className="text-sm text-[#a1a1aa] mt-1">Opening Google Reviews…</p>
            )}
          </div>
        ) : alreadyRated ? (
          <div
            className="rounded-2xl p-4 text-center"
            style={{ background: "#111214", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <p className="text-sm text-[#a1a1aa]">You&apos;ve already rated this appointment.</p>
          </div>
        ) : null}

        {/* Share / save actions */}
        <div className="flex gap-3">
          {photoUrl && (
            <a
              href={photoUrl}
              download={`nailiq-${photoId}.jpg`}
              className="flex-1 flex items-center justify-center gap-2 rounded-full py-3 text-sm font-semibold"
              style={{
                background: "#d4af37",
                color: "#0b0c10",
              }}
            >
              <span>💾</span>
              Save to Camera Roll
            </a>
          )}
          <button
            type="button"
            onClick={handleCopyLink}
            className="flex-1 flex items-center justify-center gap-2 rounded-full py-3 text-sm font-semibold"
            style={{
              background: "#111214",
              color: copied ? "#22c55e" : "#d4af37",
              border: "1px solid rgba(212,175,55,0.35)",
            }}
          >
            <span>{copied ? "✓" : "🔗"}</span>
            {copied ? "Copied!" : "Copy Link"}
          </button>
        </div>

        {/* Re-book CTA */}
        {salonSlug && (
          <a
            href={`/${salonSlug}`}
            className="block w-full rounded-full py-4 text-center text-sm font-semibold"
            style={{
              background: "#111214",
              color: "#ffffff",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            Book Again at {salonName}
          </a>
        )}

        {/* PIPEDA notice */}
        <p className="text-xs text-[#6b6d76] text-center pb-4">
          To remove your photo or update consent, contact your salon or reply STOP to any SMS.
        </p>
      </div>
    </div>
  );
}
