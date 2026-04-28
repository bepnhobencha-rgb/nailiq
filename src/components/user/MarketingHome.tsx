"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { MarketingPhoneAside } from "@/components/user/MarketingPhoneAside";
import { DesktopSplit } from "@/components/layout/DesktopSplit";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { getUserMessages } from "@/shared/i18n/user";
import { setRegisterFlow } from "@/shared/lib/registerFlow";
import { normalizeRegisterPhone } from "@/shared/register/phone";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";
import { cn } from "@/shared/lib/cn";

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
      return;
    }

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const readMotion = () => {
      const next = mq.matches;
      setReduceMotion(next);
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
  return Math.min(40, y * 0.1);
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
    2800,
    reducedMotion,
  );

  const [headlineLine1, ...headlineRest] = t.heroHeadline.split("\n");
  const headlineLine2 = headlineRest.join("\n").trim();

  const onCtaStart = () => {
    const el = document.querySelector<HTMLInputElement>('input[name="phone"]');
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
    <ResponsiveShell showAmbient={false}>
      <div
        className="pointer-events-none fixed inset-0 -z-10 overflow-x-clip"
        aria-hidden
      >
        <div className="absolute top-[-18%] left-1/2 h-[min(520px,58vh)] w-[min(130%,44rem)] max-w-[100vw] -translate-x-1/2 rounded-[50%] bg-gradient-to-b from-nq-primary/[0.14] via-nq-primary/[0.05] to-transparent blur-[110px]" />
        <div className="absolute top-[28%] right-[-25%] hidden h-[min(380px,50vh)] w-[min(32rem,85vw)] rounded-full bg-nq-primary/[0.07] blur-[100px] md:block lg:right-[-12%]" />
        <div className="absolute bottom-[-20%] left-1/2 h-[min(340px,42vh)] w-[min(140%,48rem)] -translate-x-1/2 rounded-[50%] bg-white/[0.03] blur-[90px]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(212,175,55,0.08),transparent_55%)]" />
      </div>

      <div className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] z-20 sm:top-4 sm:right-4 lg:right-[max(1rem,env(safe-area-inset-right))]">
        <UserLanguageToggle language={language} onLanguageChange={setLanguage} />
      </div>
      <MobileStack className="pt-1 sm:pt-2 lg:pt-0">
        <div className="fade-in">
          <p className="sr-only text-balance">{t.seoIntro}</p>

          <DesktopSplit
            className="gap-y-4 sm:gap-y-5 lg:gap-y-10 lg:gap-x-14 xl:gap-x-20"
            head={
              <header className="space-y-3 text-center transition-opacity duration-700 sm:space-y-4 lg:space-y-6 lg:pt-4 lg:text-left">
                <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-nq-muted sm:text-[11px] sm:tracking-[0.2em]">
                  {t.brandName}
                </p>
                <h1 className="mx-auto max-w-[18ch] text-balance text-[1.65rem] font-semibold leading-[1.06] tracking-[-0.035em] text-nq-foreground sm:max-w-none sm:text-4xl sm:leading-[1.05] sm:tracking-[-0.03em] lg:mx-0 lg:text-6xl lg:leading-[1.04] xl:text-7xl xl:tracking-[-0.032em]">
                  <span className="text-nq-foreground/78">{headlineLine1}</span>
                  {headlineLine2 ? (
                    <>
                      <br className="sm:hidden" />
                      <span className="hidden sm:inline" aria-hidden>
                        {" "}
                      </span>
                      <span className="bg-gradient-to-r from-nq-foreground via-nq-primary-soft to-nq-foreground/92 bg-clip-text text-transparent">
                        {headlineLine2}
                      </span>
                    </>
                  ) : null}
                </h1>
                <p className="mx-auto max-w-md text-pretty text-[15px] leading-[1.5] text-nq-muted/95 sm:text-[17px] sm:leading-relaxed lg:mx-0 lg:max-w-lg lg:text-lg lg:leading-[1.55]">
                  {t.heroSubline}
                </p>
              </header>
            }
            rest={
              <div className="flex w-full min-w-0 flex-col space-y-6 sm:space-y-8 lg:space-y-10">
                <div className="relative z-20 flex w-full flex-col gap-3 sm:gap-3.5 lg:max-w-md lg:self-start">
                  <button
                    type="button"
                    className={cn(
                      "nq-booking-luxury-cta",
                      "h-14 min-h-14 w-full rounded-full px-6 text-[15px] font-semibold tracking-tight sm:text-base",
                      "motion-safe:active:scale-[0.99] motion-reduce:active:scale-100",
                    )}
                    onClick={onCtaStart}
                  >
                    <span>{t.cta}</span>
                  </button>
                  <div className="space-y-1.5 text-center lg:text-left">
                    <p className="text-[13px] leading-snug text-nq-muted/88 sm:text-sm sm:leading-normal">
                      {t.ctaSubline}
                    </p>
                    <p className="text-[11px] leading-snug text-nq-muted/65 sm:text-xs">
                      {t.ctaTrustLine}
                    </p>
                  </div>
                  <p
                    className="text-center text-[11px] text-nq-muted/75 motion-safe:animate-nq-urgency-breathe sm:text-xs lg:text-left"
                  >
                    {t.urgencyLine}
                  </p>
                </div>

                <div className="w-full lg:max-w-md lg:self-start">
                  <Input
                    placeholder={t.phonePlaceholder}
                    name="phone"
                    type="tel"
                    autoComplete="tel"
                    inputMode="tel"
                    className="rounded-[14px] border-white/[0.08] bg-nq-bg/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-md sm:rounded-2xl"
                  />
                </div>

                <div className="fade-in-1 space-y-4 text-center sm:space-y-5 lg:text-left">
                  <p className="min-h-[1.25rem] text-[13px] text-nq-muted/90 sm:text-[15px]">
                    <span
                      key={liveProofIndex}
                      className="fade-in inline-block transition-opacity"
                    >
                      {t.liveProof[liveProofIndex]}
                    </span>
                  </p>
                  <Card className="border border-white/[0.06] p-5 shadow-[0_20px_60px_-24px_rgba(0,0,0,0.65),0_0_0_1px_rgba(212,175,55,0.1)] sm:p-7">
                    <div className="relative z-10">
                      <div className="mb-4 flex min-h-11 flex-col gap-3 sm:min-h-12 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                        <h2 className="text-[15px] font-medium leading-tight tracking-tight text-nq-foreground sm:text-base">
                          {t.valueCardTitle}
                        </h2>
                        <Badge
                          variant="default"
                          className="w-fit shrink-0 rounded-full px-3 py-0.5 text-[10px] uppercase tracking-wider sm:text-xs"
                        >
                          {t.valueCardBadge}
                        </Badge>
                      </div>
                      <p className="text-[14px] leading-relaxed text-nq-muted/95 sm:text-[15px]">
                        {t.valueCardBody}
                      </p>
                    </div>
                  </Card>
                </div>

                <section
                  className="fade-in-2 space-y-4 sm:space-y-5 lg:text-left"
                  aria-labelledby="nq-benefits-heading"
                >
                  <h2
                    id="nq-benefits-heading"
                    className="text-center text-[11px] font-medium uppercase tracking-[0.16em] text-nq-muted/80 sm:text-xs sm:tracking-[0.14em] lg:text-left"
                  >
                    {t.benefitsHeading}
                  </h2>
                  <div className="overflow-hidden rounded-[20px] border border-white/[0.06] bg-white/[0.02] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl sm:rounded-[22px]">
                    <ul className="divide-y divide-white/[0.06]">
                      {t.benefits.map((item) => (
                        <li key={item.title}>
                          <article
                            {...(item.phoneScene
                              ? { "data-nq-benefit-scene": item.phoneScene }
                              : {})}
                            className="scroll-mt-6 px-4 py-4 sm:px-5 sm:py-5"
                          >
                            <h3 className="text-[15px] font-medium leading-snug tracking-tight text-nq-foreground sm:text-base">
                              {item.title}
                            </h3>
                            <p className="mt-2 text-[13px] leading-[1.55] text-nq-muted sm:text-[15px] sm:leading-relaxed">
                              {item.body}
                            </p>
                          </article>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>

                <section
                  className="fade-in-2 space-y-4 sm:space-y-5 lg:text-left"
                  aria-labelledby="nq-wow-heading"
                >
                  <h2
                    id="nq-wow-heading"
                    className="text-center text-[11px] font-medium uppercase tracking-[0.16em] text-nq-muted/80 sm:text-xs sm:tracking-[0.14em] lg:text-left"
                  >
                    {t.wowHeading}
                  </h2>
                  <p className="whitespace-pre-line text-center text-[13px] leading-[1.6] text-nq-muted sm:text-[15px] sm:leading-relaxed lg:text-left">
                    {t.wowBody}
                  </p>
                </section>

                <footer className="border-t border-white/[0.06] pt-6 text-center text-[11px] text-nq-muted/70 sm:text-xs lg:border-0 lg:pt-2 lg:text-left">
                  {t.footerPoweredBy}
                </footer>
              </div>
            }
            aside={
              <MarketingPhoneAside
                t={t}
                language={language}
                parallaxY={parallaxY}
                className="will-change-transform lg:-mt-2 xl:mt-0"
              />
            }
          />
        </div>
      </MobileStack>
    </ResponsiveShell>
  );
}
