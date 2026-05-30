/**
 * /party/[token] — Public party link page.
 *
 * No auth required.  The token is an opaque, unguessable 16-hex-char string.
 * Server component loads safe data (no phone numbers), then mounts the
 * interactive PartyClaimClient for the claim form.
 *
 * Language detection: prefers ?lang=vi/en query param, falls back to the
 * Accept-Language request header.  Defaults to English.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { loadPartyLinkPage } from "@/shared/booking/partyLinkActions";
import { bookingEn } from "@/shared/i18n/booking/en";
import { bookingVi } from "@/shared/i18n/booking/vi";
import PartyClaimClient from "./_components/PartyClaimClient";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ lang?: string }>;
};

// ─── Language helpers ─────────────────────────────────────────────

function detectLang(
  queryLang: string | undefined,
  acceptLanguage: string | null,
): "en" | "vi" {
  // 1. Explicit ?lang= param wins.
  if (queryLang === "vi" || queryLang === "en") return queryLang;
  // 2. Parse Accept-Language header — prefer vi if present.
  if (acceptLanguage) {
    const langs = acceptLanguage
      .split(",")
      .map((s) => s.split(";")[0]!.trim().toLowerCase());
    for (const l of langs) {
      if (l.startsWith("vi")) return "vi";
      if (l.startsWith("en")) return "en";
    }
  }
  return "en";
}

// ─── Metadata ─────────────────────────────────────────────────────

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const data = await loadPartyLinkPage(token);
  if (!data) {
    return { title: "Group Booking · NailIQ", robots: { index: false, follow: false } };
  }
  return {
    title: `Group Booking at ${data.salonName} · NailIQ`,
    description: `You've been invited to a group booking at ${data.salonName}. Claim your slot!`,
    robots: { index: false, follow: false },
  };
}

// ─── Page ─────────────────────────────────────────────────────────

export default async function PartyLinkPage({ params, searchParams }: Props) {
  const [{ token }, { lang: queryLang }, headerList] = await Promise.all([
    params,
    searchParams,
    headers(),
  ]);

  const lang = detectLang(queryLang, headerList.get("accept-language"));
  const t = (lang === "vi" ? bookingVi : bookingEn).partyPage;

  const data = await loadPartyLinkPage(token);

  if (!data) {
    return <PartyErrorPage reason="not_found" t={t} />;
  }

  const waveCount = new Set(data.slots.map((s) => s.waveNumber)).size;
  const isWave = waveCount > 1;
  const modeLabel = data.mode === "sync_finish" ? t.modeFinish : t.modeStart;
  const modeIcon = data.mode === "sync_finish" ? "🏁" : "🚶";

  return (
    <main className="min-h-screen bg-gradient-to-b from-[#faf6f0] via-[#f6f1ea] to-[#f1e8da] px-4 py-10 text-[#2c2620] sm:py-14">
      <div className="mx-auto max-w-lg">
        {/* Invitation header */}
        <header className="mb-7 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-[#ecd9af] to-[#c8a45c] text-2xl shadow-[0_10px_24px_-10px_rgba(176,138,70,0.65)]">
            <span aria-hidden>✨</span>
          </div>
          <h1 className="text-[26px] font-bold leading-tight tracking-tight sm:text-[30px]">
            {t.invited}
          </h1>
          <p className="mt-1.5 text-sm text-[#857a6c]">
            {t.groupBookingAt}{" "}
            <span className="font-semibold text-[#9c7b43]">{data.salonName}</span>
          </p>
          <p className="mt-3 inline-block rounded-full bg-[#f3e8d4] px-3.5 py-1 text-xs font-medium text-[#8a6a33]">
            {t.invitedSubtext}
          </p>
        </header>

        {/* Group summary card */}
        <div className="mb-6 overflow-hidden rounded-2xl border border-[#ece3d5] bg-white shadow-[0_2px_8px_-2px_rgba(120,90,50,0.08),0_16px_34px_-22px_rgba(120,90,50,0.28)]">
          <div className="p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#9c7b43]">
              {data.groupDateDisplay}
            </p>
            <p className="mt-1.5 text-2xl font-bold tracking-tight">
              {data.groupStartDisplay} <span className="text-[#cbbda4]">–</span> {data.groupEndDisplay}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f6f1ea] px-3 py-1 text-xs font-medium text-[#6b6155]">
                <span aria-hidden>{modeIcon}</span> {modeLabel}
              </span>
              {isWave && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f3e8d4] px-3 py-1 text-xs font-semibold text-[#8a6a33]">
                  <span aria-hidden>🌊</span> {t.wavesBadge.replace("{count}", String(waveCount))}
                </span>
              )}
            </div>
          </div>
          {isWave && (
            <p className="border-t border-[#f0e7d8] bg-[#fcf9f3] px-5 py-3 text-xs leading-relaxed text-[#857a6c]">
              {t.waveExplain}
            </p>
          )}
        </div>

        {/* Expired banner */}
        {data.expired && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            {t.expiredBanner}
          </div>
        )}

        {/* Slot list + claim forms */}
        <PartyClaimClient data={data} t={t} />
      </div>
    </main>
  );
}

// ─── Error states ─────────────────────────────────────────────────

type PartyPageT = (typeof bookingEn)["partyPage"];

function PartyErrorPage({
  reason,
  t,
}: {
  reason: "not_found" | "expired";
  t: PartyPageT;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-[#faf6f0] to-[#f1e8da] px-4 text-[#2c2620]">
      <div className="max-w-sm text-center">
        <div className="mb-4 text-4xl">💅</div>
        {reason === "not_found" ? (
          <>
            <h1 className="text-xl font-bold">{t.notFoundTitle}</h1>
            <p className="mt-2 text-sm text-[#857a6c]">{t.notFoundBody}</p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold">{t.expiredTitle}</h1>
            <p className="mt-2 text-sm text-[#857a6c]">{t.expiredBody}</p>
          </>
        )}
      </div>
    </main>
  );
}
