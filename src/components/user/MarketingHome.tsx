"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { MarketingPhoneAside } from "@/components/user/MarketingPhoneAside";
import { DesktopSplit } from "@/components/layout/DesktopSplit";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { getUserMessages } from "@/shared/i18n/user";
import { setRegisterFlow } from "@/shared/lib/registerFlow";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";

function usePhoneParallaxPx() {
  const [y, setY] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [isLg, setIsLg] = useState(false);

  useEffect(() => {
    const mqLg = window.matchMedia("(min-width: 1024px)");
    const readLg = () => setIsLg(mqLg.matches);
    readLg();
    mqLg.addEventListener("change", readLg);
    return () => mqLg.removeEventListener("change", readLg);
  }, []);

  useEffect(() => {
    if (!isLg) {
      setY(0);
      return;
    }

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const readMotion = () => {
      const next = mq.matches;
      setReduceMotion(next);
      if (next) setY(0);
    };
    readMotion();
    mq.addEventListener("change", readMotion);

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setY(0);
        } else {
          setY(window.scrollY);
        }
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      mq.removeEventListener("change", readMotion);
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [isLg]);

  if (reduceMotion || !isLg) return 0;
  return Math.min(32, y * 0.09);
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
    return () => clearInterval(id);
  }, [len, intervalMs, reduced]);
  return reduced ? 0 : i;
}

export function MarketingHome() {
  const router = useRouter();
  const { language, setLanguage } = useUserLanguage();
  const t = getUserMessages(language);
  const parallaxY = usePhoneParallaxPx();
  const reducedMotion = usePrefersReducedMotion();
  const liveProofIndex = useRotatingIndex(
    t.liveProof.length,
    2600,
    reducedMotion,
  );

  const [headlineLine1, ...headlineRest] = t.heroHeadline.split("\n");
  const headlineLine2 = headlineRest.join("\n").trim();

  const onCtaStart = () => {
    const el = document.querySelector<HTMLInputElement>('input[name="phone"]');
    const phone = el?.value?.trim() ?? "";
    setRegisterFlow({
      phone,
      verified: false,
      salonName: "",
      slug: "",
    });
    router.push("/register/verify");
  };

  return (
    <ResponsiveShell>
      <div className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] z-20 sm:top-4 sm:right-4">
        <UserLanguageToggle
          language={language}
          onLanguageChange={setLanguage}
        />
      </div>
      <MobileStack className="pt-2 sm:pt-4 lg:pt-0">
        <div className="fade-in">
          <p className="sr-only text-balance">{t.seoIntro}</p>

          <DesktopSplit
            className="gap-y-4 sm:gap-y-5 lg:gap-y-8"
            head={
              <header className="space-y-1.5 text-center transition-opacity duration-700 sm:space-y-2 lg:space-y-3 lg:text-left">
                <p className="text-sm font-medium tracking-wide text-nq-primary/70 sm:text-base">
                  {t.brandName}
                </p>
                <h1 className="text-balance text-2xl font-bold leading-[1.04] tracking-[-0.012em] text-nq-foreground sm:text-4xl sm:leading-tight sm:tracking-tight lg:text-6xl lg:leading-[1.08] lg:tracking-tight xl:text-7xl">
                  <span className="text-nq-foreground/86">{headlineLine1}</span>
                  {headlineLine2 ? (
                    <>
                      <br className="sm:hidden" />
                      <span className="hidden sm:inline" aria-hidden>
                        {" "}
                      </span>
                      <span className="text-nq-foreground">{headlineLine2}</span>
                    </>
                  ) : null}
                </h1>
                <p className="line-clamp-2 text-pretty text-sm leading-snug text-nq-foreground/88 sm:text-base sm:leading-normal">
                  {t.heroSubline}
                </p>
              </header>
            }
            rest={
              <div className="flex w-full min-w-0 flex-col space-y-5 sm:space-y-6 lg:space-y-8">
                <div className="relative z-20 flex w-full flex-col gap-2.5 sm:gap-3">
                  <Button
                    type="button"
                    size="lg"
                    className="relative z-20 h-14 min-h-14 w-full self-center sm:max-w-md lg:max-w-md lg:self-start"
                    onClick={onCtaStart}
                  >
                    {t.cta}
                  </Button>
                  <p className="text-center text-xs leading-snug text-nq-muted/90 sm:text-sm">
                    {t.ctaSubline}
                  </p>
                  <p className="text-center text-[11px] leading-snug text-nq-muted/75 sm:text-xs">
                    {t.ctaTrustLine}
                  </p>
                  <p
                    className="text-center text-xs text-nq-muted animate-nq-urgency-breathe"
                  >
                    {t.urgencyLine}
                  </p>
                </div>

                <div className="flex w-full flex-col gap-2 sm:gap-2">
                  <Input
                    placeholder={t.phonePlaceholder}
                    name="phone"
                    type="tel"
                    autoComplete="tel"
                    inputMode="tel"
                  />
                  <p
                    className="min-h-5 text-center text-xs text-nq-muted"
                    aria-hidden="true"
                  >
                    <span
                      key={liveProofIndex}
                      className="fade-in inline-block"
                    >
                      {t.liveProof[liveProofIndex]}
                    </span>
                  </p>
                </div>

                <div className="fade-in-1 space-y-3 text-center sm:space-y-4 lg:text-left">
                  <p className="text-sm text-nq-muted sm:text-[15px] lg:text-base">
                    {t.socialProof}
                  </p>
                  <Card className="text-left transition-shadow duration-500 ring-1 ring-nq-border/15 shadow-[0_0_24px_-12px_rgba(212,175,55,0.1)]">
                    <div className="relative z-10">
                      <div className="mb-3 flex min-h-12 items-center justify-between gap-2">
                        <h2 className="text-sm font-medium text-nq-foreground sm:text-base">
                          {t.valueCardTitle}
                        </h2>
                        <Badge variant="default">{t.valueCardBadge}</Badge>
                      </div>
                      <p className="text-sm text-nq-muted sm:text-[15px] sm:leading-relaxed">
                        {t.valueCardBody}
                      </p>
                    </div>
                  </Card>
                </div>

                <section
                  className="fade-in-2 space-y-3 text-center sm:space-y-4 lg:text-left"
                  aria-labelledby="nq-benefits-heading"
                >
                  <h2
                    id="nq-benefits-heading"
                    className="text-lg font-semibold tracking-tight text-nq-foreground sm:text-xl"
                  >
                    {t.benefitsHeading}
                  </h2>
                  <ul className="space-y-3 text-left sm:space-y-4">
                    {t.benefits.map((item) => (
                      <li key={item.title}>
                        <article
                          {...(item.phoneScene
                            ? { "data-nq-benefit-scene": item.phoneScene }
                            : {})}
                          className="scroll-mt-6 rounded-2xl border border-white/10 bg-nq-surface/40 px-4 py-4 sm:px-5"
                        >
                          <h3 className="text-base font-medium text-nq-foreground">
                            {item.title}
                          </h3>
                          <p className="mt-2 text-sm leading-relaxed text-nq-muted sm:text-[15px]">
                            {item.body}
                          </p>
                        </article>
                      </li>
                    ))}
                  </ul>
                </section>

                <footer className="text-center text-xs text-nq-muted/90 lg:text-left">
                  {t.footerPoweredBy}
                </footer>
              </div>
            }
            aside={
              <MarketingPhoneAside
                t={t}
                language={language}
                parallaxY={parallaxY}
                className="will-change-transform"
              />
            }
          />
        </div>
      </MobileStack>
    </ResponsiveShell>
  );
}
