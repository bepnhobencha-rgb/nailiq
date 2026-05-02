"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getUserMessages } from "@/shared/i18n/user";
import type { UserLanguage } from "@/shared/i18n/user/types";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type FeedCard = {
  id: string;
  service: string;
  price: number;
  hour: number;
};

function LandingBookingFeed({
  services,
  newBookingLabel,
}: {
  services: readonly string[];
  newBookingLabel: string;
}) {
  const [cards, setCards] = useState<FeedCard[]>([]);

  useEffect(() => {
    if (services.length === 0) return;
    let cancelled = false;
    let timeoutId: number | null = null;

    const addCard = () => {
      if (cancelled) return;
      const service = services[Math.floor(Math.random() * services.length)]!;
      const price = Math.floor(Math.random() * 21) + 30;
      const hour = Math.floor(Math.random() * 10) + 9;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      setCards((prev) => [{ id, service, price, hour }, ...prev].slice(0, 4));
    };

    const loop = () => {
      if (cancelled) return;
      const delay = Math.floor(Math.random() * 3000) + 3000;
      timeoutId = window.setTimeout(() => {
        addCard();
        loop();
      }, delay);
    };

    const startId = window.setTimeout(() => {
      if (cancelled) return;
      addCard();
      window.setTimeout(() => {
        if (!cancelled) addCard();
      }, 1000);
      loop();
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(startId);
      if (timeoutId != null) window.clearTimeout(timeoutId);
    };
  }, [services]);

  return (
    <div className="landing-html-booking-feed" aria-hidden>
      {cards.map((c) => (
        <div
          key={c.id}
          className="landing-html-booking-card landing-html-glass-card flex items-center gap-4 p-5 shadow-xl"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-yellow-500/20 text-xl font-black text-yellow-500">
            ＋
          </div>
          <div>
            <div className="text-sm font-black text-white">{newBookingLabel}</div>
            <div className="text-[11px] font-bold tracking-wide text-gray-400 uppercase">
              {c.hour}:00 PM — {c.service} • ${c.price}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LandingSocialProof({
  lines,
  proofVisible,
  setProofVisible,
}: {
  lines: readonly string[];
  proofVisible: boolean;
  setProofVisible: Dispatch<SetStateAction<boolean>>;
}) {
  const [proofIndex, setProofIndex] = useState(0);

  useEffect(() => {
    if (lines.length === 0) return;

    let fadeTimeoutId: number | null = null;
    const intervalId = window.setInterval(() => {
      if (fadeTimeoutId != null) {
        window.clearTimeout(fadeTimeoutId);
        fadeTimeoutId = null;
      }
      setProofVisible(false);
      fadeTimeoutId = window.setTimeout(() => {
        fadeTimeoutId = null;
        setProofIndex((i) => (i + 1) % lines.length);
        setProofVisible(true);
      }, 500);
    }, 4000);

    return () => {
      window.clearInterval(intervalId);
      if (fadeTimeoutId != null) window.clearTimeout(fadeTimeoutId);
    };
  }, [lines.length, setProofVisible]);

  return (
    <div
      className="flex h-6 items-center gap-2 text-sm font-bold text-gray-400 transition-opacity duration-500"
      style={{ opacity: proofVisible ? 1 : 0 }}
    >
      <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" />
      <span>{lines[proofIndex]}</span>
    </div>
  );
}

export function HomeLanding() {
  const router = useRouter();
  const { language, setLanguage } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language), [language]);
  const [proofVisible, setProofVisible] = useState(true);

  useEffect(() => {
    setProofVisible(true);
  }, [language]);

  const headlineParts = useMemo(() => {
    const [first = "", second = ""] = t.home.landingH1Line1.split("|");
    return [first.trim(), second.trim()] as const;
  }, [t.home.landingH1Line1]);

  const socialLines = useMemo(
    () => [
      t.home.landingSocialProof1,
      t.home.landingSocialProof2,
      t.home.landingSocialProof3,
      t.home.landingSocialProof4,
    ],
    [t],
  );

  const goRegister = useCallback(() => {
    router.push("/register");
  }, [router]);

  const setLang = (next: UserLanguage) => setLanguage(next);

  return (
    <div className="landing-html min-h-dvh overflow-x-hidden pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <p className="sr-only">{t.seoIntro}</p>

      <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-8 md:px-12">
        <Link
          href="/"
          className={cn(
            "landing-html-wordmark-wrap text-base font-semibold tracking-tight text-white md:text-lg not-italic",
            "font-[family-name:var(--font-landing-inter),system-ui,sans-serif]",
          )}
        >
          <span aria-label={t.brandName}>{t.brandName}</span>
        </Link>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1 text-xs font-black tracking-widest uppercase opacity-50">
            <button
              type="button"
              onClick={() => setLang("en")}
              className={cn(
                "cursor-pointer transition hover:opacity-100",
                language === "en" ? "opacity-100" : "opacity-50",
              )}
            >
              EN
            </button>
            <span className="opacity-40" aria-hidden>
              |
            </span>
            <button
              type="button"
              onClick={() => setLang("vi")}
              className={cn(
                "cursor-pointer transition hover:opacity-100",
                language === "vi" ? "opacity-100" : "opacity-50",
              )}
            >
              VI
            </button>
          </span>
        </div>
      </nav>

      <section className="mx-auto max-w-7xl px-6 pt-8 pb-24 md:px-12 md:pt-16">
        <div className="grid grid-cols-1 items-center gap-12 md:grid-cols-2 md:gap-20">
          <div className="space-y-10">
            <p className="landing-html-urgency-glow text-sm font-black tracking-widest text-yellow-500 uppercase">
              {t.home.landingUrgency}
            </p>

            <h1 className="text-5xl leading-[1.05] font-black tracking-tight text-white md:text-8xl">
              {headlineParts[0]}
              <br />
              {headlineParts[1]}
              <br />
              <span className="landing-html-title-gold italic">
                {t.home.landingH1Gold}
              </span>
            </h1>

            <div className="space-y-3 text-lg font-medium text-gray-400 md:text-2xl leading-relaxed">
              <p>{t.home.landingBody1}</p>
            </div>

            <p className="text-base text-gray-400/80 md:text-lg">
              {t.home.autoLine}
            </p>

            <div className="space-y-6">
              <div className="flex max-w-md flex-col gap-4">
                <button
                  type="button"
                  onClick={goRegister}
                  className="landing-html-cta w-full rounded-2xl py-6 text-xl font-extrabold text-black shadow-2xl"
                >
                  {t.home.landingCta}
                </button>
              </div>
              <p className="text-center text-xs font-medium text-gray-500 md:text-left">
                {t.home.landingMicrotrust}
              </p>
              <p className="text-center text-[13px] font-medium text-gray-500/90 md:text-left">
                {t.home.ctaSpeed}
              </p>
              <LandingSocialProof
                key={language}
                lines={socialLines}
                proofVisible={proofVisible}
                setProofVisible={setProofVisible}
              />
            </div>
          </div>

          <div className="relative flex justify-center">
            <div className="absolute inset-0 -z-10 rounded-full bg-yellow-500/10 blur-[150px]" />
            <div className="w-full max-w-sm space-y-6">
              <div className="landing-html-glass-card relative z-20 border-yellow-500/40 bg-white/5 p-8 shadow-2xl">
                <div className="landing-html-urgency-glow text-4xl font-black text-white">
                  {t.home.landingEarnedTitle}
                </div>
                <div className="mt-2 text-[11px] font-black tracking-widest text-gray-500 uppercase">
                  {t.home.landingEarnedSub}
                </div>
              </div>
              <LandingBookingFeed
                services={t.home.landingFeedServices}
                newBookingLabel={t.home.landingFeedNewBooking}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-white/5 bg-white/[0.02] py-24">
        <div className="mx-auto max-w-7xl px-6">
          <p className="mb-3 text-center text-xs font-black tracking-widest text-yellow-500 uppercase">
            {t.home.landingSectionEyebrow}
          </p>
          <h2 className="mb-16 text-center text-4xl font-black text-white md:text-5xl">
            {t.home.landingSectionTitle}
          </h2>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
            {[
              { emoji: "📞", title: t.home.landingProblem1 },
              { emoji: "⏰", title: t.home.landingProblem2 },
              { emoji: "💔", title: t.home.landingProblem3 },
            ].map((card) => (
              <div
                key={card.title}
                className="landing-html-glass-card space-y-5 p-12 text-center transition hover:bg-white/5"
              >
                <div className="text-2xl" aria-hidden>
                  {card.emoji}
                </div>
                <h3 className="text-xl leading-tight font-black">{card.title}</h3>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-40 text-center">
        <div className="mx-auto max-w-4xl space-y-10">
          <h2 className="text-6xl font-black tracking-tighter text-white md:text-8xl">
            {t.home.landingClosingLine1} <br />
            {t.home.landingClosingLine2}
          </h2>
          <p className="mx-auto max-w-2xl text-2xl font-bold text-gray-400">
            {t.home.landingClosingSub}
          </p>
          <div className="mx-auto max-w-md pt-6">
            <button
              type="button"
              onClick={goRegister}
              className="landing-html-cta w-full rounded-2xl py-6 text-2xl font-black tracking-tight text-black italic"
            >
              {t.home.landingClosingCta}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
