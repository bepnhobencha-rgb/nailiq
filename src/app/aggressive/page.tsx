"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";
import {
  getAggressiveMessages,
  getUserMessages,
  type AggressiveMessages,
} from "@/shared/i18n/user";
import type { UserLanguage } from "@/shared/i18n/user/types";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { cn } from "@/shared/lib/cn";

function stripUrgencyEmoji(s: string) {
  return s.replace(/^\s*⚡\s*/u, "").trim();
}

function heroHeadlineParts(
  headline: string,
  lang: UserLanguage,
): { lead: string; accent: string } {
  if (lang === "vi") {
    const acc = "ngay bây giờ";
    if (headline.endsWith(acc)) {
      return {
        lead: headline.slice(0, headline.length - acc.length).trimEnd(),
        accent: acc,
      };
    }
  }
  const acc = "right now";
  if (headline.toLowerCase().endsWith(acc)) {
    return {
      lead: headline.slice(0, headline.length - acc.length).trimEnd(),
      accent: acc,
    };
  }
  return { lead: headline, accent: "" };
}

function solutionTitleParts(title: string, lang: UserLanguage) {
  if (lang === "vi") {
    const m = title.match(/^(.+?)\s+(ngay)(\s*:)$/iu);
    if (m) {
      return { before: m[1]!, emphasis: m[2]!, after: m[3]! };
    }
  }
  const m = title.match(/^(.+?)\s+(instantly)(\s*:)$/iu);
  if (m) {
    return { before: m[1]!, emphasis: m[2]!, after: m[3]! };
  }
  return { before: title, emphasis: "", after: "" };
}

const DEMO_FEAT_DOT = [
  "bg-nq-success",
  "bg-nq-primary",
  "bg-nq-muted",
] as const;

/**
 * /aggressive — mobile + desktop 2-col layout, NailIQ theme (globals.css + nq-* tokens).
 */

export default function AggressivePage() {
  const { language, setLanguage } = useUserLanguage();
  const t = getAggressiveMessages(language);
  const base = getUserMessages(language);

  return (
    <ResponsiveShell>
      <div
        className="pointer-events-auto absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] z-[60] sm:top-4 sm:right-4"
      >
        <UserLanguageToggle language={language} onLanguageChange={setLanguage} />
      </div>

      <main className="relative z-0 w-full min-w-0 text-nq-foreground antialiased selection:bg-nq-primary/35 selection:text-nq-foreground">
        <p className="sr-only text-balance">{t.seoIntro}</p>
        <Hero t={t} language={language} />
        <Divider wide />
        <MoneyCounter t={t} />
        <Divider />
        <Problem t={t} />
        <Divider />
        <Solution t={t} language={language} />
        <Divider wide />
        <PhoneDemo t={t} />
        <Divider />
        <Benefits t={t} />
        <Divider />
        <SocialProof t={t} />
        <Divider />
        <NoBarrier t={t} />
        <FinalCTA t={t} base={base} />
      </main>
    </ResponsiveShell>
  );
}

/* ─────────────────────────────────────────
   Layout primitives
───────────────────────────────────────── */

function Section({
  children,
  className = "",
  wide = false,
}: {
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <section className={cn("py-20 md:py-24", className)}>
      <div
        className={cn(
          "mx-auto w-full",
          wide ? "max-w-5xl" : "max-w-md md:max-w-xl",
        )}
      >
        {children}
      </div>
    </section>
  );
}

function Divider({ wide = false }: { wide?: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "mx-auto h-px bg-nq-border/50",
        wide ? "max-w-5xl" : "max-w-md md:max-w-xl",
      )}
    />
  );
}

function PrimaryCTA({
  label,
  href = "/register",
  variant = "dark",
  fullWidth = true,
}: {
  label: string;
  href?: string;
  variant?: "dark" | "light";
  fullWidth?: boolean;
}) {
  const styles =
    variant === "dark"
      ? "bg-nq-primary text-nq-bg shadow-nq-sm hover:bg-nq-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
      : "border border-nq-border bg-nq-surface text-nq-primary shadow-nq-sm hover:bg-nq-surface/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-surface";
  return (
    <a
      href={href}
      className={cn(
        "inline-flex items-center justify-center rounded-full px-6 py-4 text-base font-semibold transition active:scale-[0.98]",
        styles,
        fullWidth && "w-full",
      )}
    >
      {label}
      <span className="ml-2 opacity-90" aria-hidden>
        →
      </span>
    </a>
  );
}

/* ─────────────────────────────────────────
   Shared counter hook
───────────────────────────────────────── */

function useMoneyCounter(start = 135) {
  const [value, setValue] = useState(start);
  useEffect(() => {
    const id = setInterval(() => {
      setValue((v) => v + 15 + Math.floor(Math.random() * 25));
    }, 2000);
    return () => clearInterval(id);
  }, []);
  return value;
}

/* ─────────────────────────────────────────
   1. HERO
───────────────────────────────────────── */

function Hero({
  t,
  language,
}: {
  t: AggressiveMessages;
  language: UserLanguage;
}) {
  const money = useMoneyCounter(135);
  const { lead, accent } = heroHeadlineParts(t.hero.headline, language);
  const v2 = t.aggressivePageV2;

  return (
    <Section wide className="pt-8 md:pt-12">
      <div className="md:grid md:grid-cols-2 md:items-center md:gap-16 lg:gap-20">
        <div>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-nq-error/35 bg-nq-error/10 px-3 py-1 text-xs font-medium text-nq-error">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-nq-error" />
            {stripUrgencyEmoji(t.hero.urgency)}
          </div>

          <h1 className="text-[44px] font-black leading-[0.93] tracking-tight md:text-[52px] lg:text-[64px]">
            {lead}
            {accent ? (
              <>
                {" "}
                <span className="text-nq-error">{accent}</span>
                {language === "en" ? "." : ""}
              </>
            ) : null}
          </h1>

          <p className="mt-5 whitespace-pre-line text-lg leading-snug text-nq-muted">
            {t.hero.subline}
          </p>

          <div className="mt-8">
            <PrimaryCTA label={t.hero.cta} />
            <p className="mt-3 text-center text-xs text-nq-muted/90">
              {v2.heroTrustMicroLine}
            </p>
          </div>
        </div>

        <div className="hidden md:flex md:justify-center">
          <div className="w-full max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface/50 p-10 text-center shadow-nq-card">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-nq-muted/90">
              {t.moneyLabel}
            </p>
            <span
              key={money}
              className="mt-5 block text-7xl font-black tabular-nums text-nq-foreground animate-nq-phone-tick"
            >
              ${money.toLocaleString()}
            </span>
            <p className="mt-5 whitespace-pre-line text-sm text-nq-muted">
              {v2.moneyCounterSubline}
            </p>
            <div className="mt-8">
              <PrimaryCTA label={v2.heroCtaFix} />
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ─────────────────────────────────────────
   2. MONEY COUNTER — mobile only
───────────────────────────────────────── */

function MoneyCounter({ t }: { t: AggressiveMessages }) {
  const value = useMoneyCounter(135);
  const v2 = t.aggressivePageV2;

  return (
    <section className="py-16 md:hidden">
      <div className="mx-auto w-full max-w-md">
        <p className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-nq-muted/90">
          {t.moneyLabel}
        </p>
        <div className="mt-4 text-center">
          <span
            key={value}
            className="inline-block text-6xl font-black tabular-nums text-nq-foreground animate-nq-phone-tick"
          >
            ${value.toLocaleString()}
          </span>
        </div>
        <p className="mt-4 whitespace-pre-line text-center text-sm text-nq-muted">
          {v2.moneyCounterSubline}
        </p>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────
   3. PROBLEM
───────────────────────────────────────── */

function Problem({ t }: { t: AggressiveMessages }) {
  return (
    <Section>
      <h2 className="text-3xl font-black leading-tight tracking-tight text-nq-foreground md:text-4xl">
        {t.problem.title}
      </h2>
      <ul className="mt-8 space-y-4">
        {t.problem.items.map((item) => (
          <li
            key={item}
            className="flex items-start gap-3 text-lg leading-snug text-nq-foreground/95"
          >
            <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-nq-error" />
            {item}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ─────────────────────────────────────────
   4. SOLUTION
───────────────────────────────────────── */

function Solution({
  t,
  language,
}: {
  t: AggressiveMessages;
  language: UserLanguage;
}) {
  const { before, emphasis, after } = solutionTitleParts(
    t.solution.title,
    language,
  );
  const v2 = t.aggressivePageV2;

  return (
    <Section>
      <h2 className="text-3xl font-black leading-tight tracking-tight text-nq-foreground md:text-4xl">
        {emphasis ? (
          <>
            {before}
            <span className="underline decoration-nq-primary decoration-4 underline-offset-4">
              {emphasis}
            </span>
            {after}
          </>
        ) : (
          t.solution.title
        )}
      </h2>
      <ul className="mt-8 space-y-4">
        {t.solution.items.map((item) => (
          <li
            key={item}
            className="flex items-start gap-3 text-lg leading-snug text-nq-foreground/95"
          >
            <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-nq-success" />
            {item}
          </li>
        ))}
      </ul>
      <div className="mt-10">
        <PrimaryCTA label={v2.solutionMidCta} />
      </div>
    </Section>
  );
}

/* ─────────────────────────────────────────
   5. PHONE DEMO
───────────────────────────────────────── */

const PHONE_DEMO_SERVICE_ICONS = ["🦶", "💎", "✨"] as const;

function PhoneDemo({ t }: { t: AggressiveMessages }) {
  const v2 = t.aggressivePageV2;
  const phone = t.phone;
  const featColors = DEMO_FEAT_DOT;

  const phoneUI = (
    <PhoneFrame>
      <div className="flex h-full w-full min-h-0 flex-col p-3">
        <div className="min-h-0 flex-1 overflow-y-auto pb-2 [scrollbar-width:thin]">
          <header className="flex items-center justify-between gap-2 pr-0.5">
            <p className="text-[11px] font-semibold leading-snug text-nq-foreground/95">
              {phone.phoneAppBar}
            </p>
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-neutral-100 text-lg leading-none"
              aria-hidden
            >
              💅
            </div>
          </header>

          <ul className="mt-2.5 space-y-1.5">
            {phone.serviceStrip.map((name, idx) => {
              const active = idx === 0;
              return (
                <li key={name}>
                  <div
                    className={cn(
                      "flex items-center gap-3 rounded-2xl px-3.5 py-2.5",
                      active
                        ? "bg-neutral-900 text-white"
                        : "border border-neutral-100 bg-neutral-50",
                    )}
                  >
                    <span className="text-xl leading-none" aria-hidden>
                      {PHONE_DEMO_SERVICE_ICONS[idx]}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold leading-tight">{name}</p>
                      <p
                        className={cn(
                          "mt-0.5 text-[11px] font-medium",
                          active ? "text-white/75" : "text-neutral-500",
                        )}
                      >
                        {phone.phoneServiceDurations[idx]} ·{" "}
                        {phone.phoneServicePrices[idx]}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 -mx-0.5">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-nq-muted/90">
              {t.phoneBooking.stepTime}
            </p>
            <div
              className="flex gap-2 overflow-x-auto pb-1 pt-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {phone.phoneTimeSlots.map((slot, idx) => {
                const active = idx === 0;
                return (
                  <span
                    key={slot}
                    className={cn(
                      "shrink-0 rounded-full px-3.5 py-2 text-xs font-semibold",
                      active
                        ? "bg-neutral-900 text-white"
                        : "border border-neutral-200 bg-neutral-50 text-neutral-600",
                    )}
                  >
                    {slot}
                  </span>
                );
              })}
            </div>
          </div>
        </div>

        <div className="niq-animate-aggr-sheet mt-1.5 w-full max-w-full shrink-0 overflow-hidden rounded-t-2xl border border-neutral-100 bg-white px-3.5 pb-3.5 pt-2.5 text-neutral-900 shadow-nq-sm">
          <div
            className="mx-auto h-1 w-9 rounded-full bg-neutral-200"
            aria-hidden
          />

          <div className="mt-3.5 flex flex-col items-center">
            <div className="niq-animate-aggr-check-bubble flex h-14 w-14 items-center justify-center rounded-full bg-nq-success">
              <svg
                className="h-7 w-7"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path
                  className="niq-check-path"
                  d="M5 12.5L10.5 18L19.5 6.5"
                  pathLength="100"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.4"
                />
              </svg>
            </div>

            <div className="mt-3.5 w-full rounded-xl border border-nq-success/20 bg-nq-success/10 px-3 py-2 text-center">
              <p className="text-sm font-bold text-nq-success">
                {phone.phoneBookingCounter}
              </p>
            </div>

            <button
              type="button"
              className="mt-3 w-full rounded-xl bg-black py-2.5 text-sm font-semibold text-white"
            >
              {phone.phoneViewSchedule}
            </button>
          </div>
        </div>
      </div>
    </PhoneFrame>
  );

  return (
    <Section wide>
      <div className="md:hidden">
        <p className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-nq-muted/90">
          {v2.demoKicker}
        </p>
        <div className="mt-8 flex justify-center">{phoneUI}</div>
      </div>

      <div className="hidden md:grid md:grid-cols-2 md:items-center md:gap-16 lg:gap-20">
        <div className="flex justify-center">{phoneUI}</div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-nq-muted/90">
            {v2.demoKicker}
          </p>
          <h2 className="mt-4 text-4xl font-black leading-[1.0] tracking-tight text-nq-foreground lg:text-[48px]">
            {v2.demoHeadline}
          </h2>

          <ul className="mt-10 space-y-7">
            {v2.demoFeats.map((f, idx) => (
              <li key={f.title} className="flex gap-4">
                <span
                  className={cn(
                    "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                    featColors[idx] ?? "bg-nq-muted",
                  )}
                />
                <div>
                  <p className="font-bold text-nq-foreground">{f.title}</p>
                  <p className="mt-1 text-sm leading-snug text-nq-muted">
                    {f.desc}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-10">
            <PrimaryCTA label={v2.demoCta} />
            <p className="mt-3 text-center text-xs text-nq-muted/90">
              {v2.demoCtaHint}
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}

function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-[560px] w-[280px] rounded-[44px] border-[10px] border-nq-border/80 bg-nq-surface shadow-nq-card-luxury">
      <div className="absolute left-1/2 top-0 z-10 h-5 w-24 -translate-x-1/2 rounded-b-2xl bg-nq-foreground/85" />
      <div className="h-full w-full overflow-hidden rounded-[34px] bg-nq-bg">
        {children}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────
   6. BENEFITS
───────────────────────────────────────── */

function Benefits({ t }: { t: AggressiveMessages }) {
  return (
    <Section>
      <p className="text-center text-4xl font-black leading-[1.05] tracking-tight text-nq-foreground md:text-5xl">
        {t.benefits.line1}.
        <br />
        <span className="text-nq-muted">{t.benefits.line2}.</span>
        <br />
        <span className="text-nq-primary/95">{t.benefits.line3}.</span>
      </p>
    </Section>
  );
}

/* ─────────────────────────────────────────
   7. SOCIAL PROOF
───────────────────────────────────────── */

function SocialProof({ t }: { t: AggressiveMessages }) {
  const messages = t.socialProof;
  const [i, setI] = useState(0);

  useEffect(() => {
    if (messages.length < 2) return;
    const id = setInterval(() => {
      setI((prev) => (prev + 1) % messages.length);
    }, 3000);
    return () => clearInterval(id);
  }, [messages.length]);

  return (
    <Section className="py-12 md:py-16">
      <div className="flex items-center justify-center gap-2 text-sm text-nq-muted">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-nq-success" />
        <span key={i} className="fade-in inline-block text-center">
          {messages[i]}
        </span>
      </div>
    </Section>
  );
}

/* ─────────────────────────────────────────
   8. NO BARRIER
───────────────────────────────────────── */

function NoBarrier({ t }: { t: AggressiveMessages }) {
  return (
    <Section>
      <p className="text-center text-2xl font-bold leading-snug text-nq-foreground md:text-3xl">
        {t.noBarrier.line1}.
        <br />
        {t.noBarrier.line2}.
        <br />
        {t.noBarrier.line3}.
      </p>
    </Section>
  );
}

/* ─────────────────────────────────────────
   9. FINAL CTA
───────────────────────────────────────── */

function FinalCTA({
  t,
  base,
}: {
  t: AggressiveMessages;
  base: ReturnType<typeof getUserMessages>;
}) {
  const v2 = t.aggressivePageV2;

  return (
    <section className="border-t border-nq-border/60 bg-nq-surface/80 px-0 py-24 md:py-32">
      <div className="mx-auto w-full max-w-md px-[var(--pad-nq-section-mobile)] md:px-0">
        <h2 className="text-4xl font-black leading-[0.95] tracking-tight text-nq-foreground md:text-5xl">
          {t.final.headline}
        </h2>
        <p className="mt-4 text-lg leading-snug text-nq-muted">
          {v2.finalCompetitorLine}
        </p>
        <div className="mt-8">
          <PrimaryCTA label={t.final.cta} variant="light" />
          <p className="mt-3 text-center text-xs text-nq-muted/85">
            {v2.repeatedNoCard}
          </p>
        </div>
        <p className="mt-6 text-center text-xs text-nq-muted/85">
          {base.footerPoweredBy}
        </p>
      </div>
    </section>
  );
}
