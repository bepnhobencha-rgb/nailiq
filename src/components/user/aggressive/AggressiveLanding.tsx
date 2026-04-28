"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { getUserMessages, getAggressiveMessages } from "@/shared/i18n/user";
import { setRegisterFlow } from "@/shared/lib/registerFlow";
import { normalizeRegisterPhone } from "@/shared/register/phone";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";
import { AggrSection } from "./AggrSection";
import { MoneyLossCounter } from "./MoneyLossCounter";
import { AggressivePhoneDemo } from "./AggressivePhoneDemo";

function useRotatingIndex(
  len: number,
  intervalMs: number,
  reduced: boolean,
) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduced || len < 2) return;
    const id = window.setInterval(() => {
      setI((j) => (j + 1) % len);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [len, intervalMs, reduced]);
  return reduced ? 0 : i;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setReduced(mq.matches);
    read();
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);
  return reduced;
}

export function AggressiveLanding() {
  const router = useRouter();
  const { language, setLanguage } = useUserLanguage();
  const t = getAggressiveMessages(language);
  const base = getUserMessages(language);
  const reduced = usePrefersReducedMotion();
  const proofI = useRotatingIndex(
    t.socialProof.length,
    2800,
    reduced,
  );

  const onCta = () => {
    const el = document.querySelector<HTMLInputElement>(
      'input[name="phone"]',
    );
    const phone = normalizeRegisterPhone(el?.value ?? "");
    setRegisterFlow({
      phone,
      verified: false,
      completionToken: "",
      salonName: "",
      slug: "",
    });
    router.push("/register");
  };

  return (
    <ResponsiveShell>
      <div className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] z-20 sm:top-4 sm:right-4">
        <UserLanguageToggle
          language={language}
          onLanguageChange={setLanguage}
        />
      </div>

      <MobileStack className="pt-2 sm:pt-4">
        <div className="mx-auto w-full max-w-lg lg:max-w-xl">
          <p className="sr-only text-balance">{t.seoIntro}</p>
          <p className="text-center text-sm font-medium text-nq-primary/80">
            {t.brandName}
          </p>

          <AggrSection className="!pt-4 sm:!pt-6">
            <header className="space-y-4 text-center">
              <h1 className="text-balance text-3xl font-bold leading-[1.08] tracking-[-0.02em] text-nq-foreground sm:text-4xl sm:leading-tight">
                {t.hero.headline}
              </h1>
              <p className="whitespace-pre-line text-pretty text-base leading-relaxed text-nq-muted sm:text-lg">
                {t.hero.subline}
              </p>
              <div className="space-y-3 pt-1">
                <Button
                  type="button"
                  size="lg"
                  className="h-14 min-h-14 w-full"
                  onClick={onCta}
                >
                  {t.hero.cta}
                </Button>
                <p className="text-sm text-nq-muted/95">{t.hero.urgency}</p>
                <Input
                  placeholder={base.phonePlaceholder}
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  inputMode="tel"
                />
              </div>
            </header>
          </AggrSection>

          <AggrSection className="!py-6 sm:!py-8" aria-labelledby="aggr-money">
            <h2 id="aggr-money" className="sr-only">
              {t.moneyLabel}
            </h2>
            <MoneyLossCounter label={t.moneyLabel} />
          </AggrSection>

          <AggrSection aria-labelledby="aggr-problem">
            <h2
              id="aggr-problem"
              className="text-center text-lg font-semibold tracking-tight text-nq-foreground sm:text-xl"
            >
              {t.problem.title}
            </h2>
            <ul className="mt-4 space-y-2.5 pl-5 text-left text-sm leading-relaxed text-nq-muted sm:text-base">
              {t.problem.items.map((line) => (
                <li key={line} className="list-disc marker:text-nq-primary/50">
                  {line}
                </li>
              ))}
            </ul>
          </AggrSection>

          <AggrSection aria-labelledby="aggr-solution">
            <h2
              id="aggr-solution"
              className="text-center text-lg font-semibold tracking-tight text-nq-foreground sm:text-xl"
            >
              {t.solution.title}
            </h2>
            <ul className="mt-4 space-y-2.5 pl-5 text-left text-sm leading-relaxed text-nq-muted sm:text-base">
              {t.solution.items.map((line) => (
                <li key={line} className="list-disc marker:text-nq-primary/50">
                  {line}
                </li>
              ))}
            </ul>
            <div className="mt-6">
              <Button
                type="button"
                size="lg"
                className="h-14 min-h-14 w-full"
                onClick={onCta}
              >
                {t.hero.cta}
              </Button>
            </div>
          </AggrSection>

          <AggrSection aria-labelledby="aggr-demo">
            <h2
              id="aggr-demo"
              className="text-center text-base font-medium text-nq-foreground/95 sm:text-lg"
            >
              {t.sectionLiveDemo}
            </h2>
            <div className="mt-5">
              <AggressivePhoneDemo copy={t} />
            </div>
          </AggrSection>

          <AggrSection className="!py-12 sm:!py-16" aria-label="Key outcomes">
            <p className="text-center text-3xl font-bold leading-tight tracking-tight text-nq-foreground sm:text-4xl">
              {t.benefits.line1}
            </p>
            <p className="mt-3 text-center text-3xl font-bold leading-tight tracking-tight text-nq-foreground/95 sm:text-4xl">
              {t.benefits.line2}
            </p>
            <p className="mt-3 text-center text-3xl font-bold leading-tight text-nq-primary/95 sm:text-4xl">
              {t.benefits.line3}
            </p>
          </AggrSection>

          <AggrSection className="!py-6" aria-live="polite">
            <p className="text-center text-xs text-nq-muted/80 sm:text-sm">
              <span
                key={proofI}
                className="fade-in inline-block"
              >
                {t.socialProof[proofI]}
              </span>
            </p>
          </AggrSection>

          <AggrSection
            className="!py-8 sm:!py-10"
            aria-labelledby="aggr-nobarrier"
          >
            <h2 id="aggr-nobarrier" className="sr-only">
              {t.noBarrier.line1} · {t.noBarrier.line2} · {t.noBarrier.line3}
            </h2>
            <p className="text-center text-xl font-semibold leading-snug text-nq-foreground sm:text-2xl">
              {t.noBarrier.line1}
            </p>
            <p className="mt-2 text-center text-xl font-semibold leading-snug text-nq-foreground/95 sm:text-2xl">
              {t.noBarrier.line2}
            </p>
            <p className="mt-2 text-center text-xl font-semibold leading-snug text-nq-foreground/90 sm:text-2xl">
              {t.noBarrier.line3}
            </p>
          </AggrSection>

          <AggrSection className="!pb-12 sm:!pb-16" aria-labelledby="aggr-final">
            <h2
              id="aggr-final"
              className="text-balance text-center text-2xl font-bold text-nq-foreground sm:text-3xl"
            >
              {t.final.headline}
            </h2>
            <div className="mt-5">
              <Button
                type="button"
                size="lg"
                className="h-14 min-h-14 w-full"
                onClick={onCta}
              >
                {t.final.cta}
              </Button>
            </div>
            <p className="mt-6 text-center text-xs text-nq-muted/85">
              {base.footerPoweredBy}
            </p>
          </AggrSection>
        </div>
      </MobileStack>
    </ResponsiveShell>
  );
}
