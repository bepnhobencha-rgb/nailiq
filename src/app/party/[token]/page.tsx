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

  return (
    <main className="min-h-screen bg-[#f9f5f2] py-10 px-4">
      <div className="mx-auto max-w-lg">
        {/* Header */}
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900">{t.invited}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {t.groupBookingAt}{" "}
            <span className="font-semibold text-gray-700">{data.salonName}</span>
          </p>
        </div>

        {/* Group summary card */}
        <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-gray-500 uppercase tracking-wide">
            {data.groupDateDisplay}
          </p>
          <p className="mt-1 text-lg font-semibold text-gray-900">
            {data.groupStartDisplay} – {data.groupEndDisplay}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            {data.mode === "sync_finish" ? t.modeFinish : t.modeStart}
          </p>
        </div>

        {/* Expired banner */}
        {data.expired && (
          <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
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
    <main className="min-h-screen bg-[#f9f5f2] flex items-center justify-center px-4">
      <div className="text-center max-w-sm">
        <div className="text-4xl mb-4">💅</div>
        {reason === "not_found" ? (
          <>
            <h1 className="text-xl font-bold text-gray-900">{t.notFoundTitle}</h1>
            <p className="mt-2 text-sm text-gray-500">{t.notFoundBody}</p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold text-gray-900">{t.expiredTitle}</h1>
            <p className="mt-2 text-sm text-gray-500">{t.expiredBody}</p>
          </>
        )}
      </div>
    </main>
  );
}
