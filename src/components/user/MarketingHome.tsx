"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { PhoneFrame } from "@/components/ui/PhoneFrame";
import { DesktopSplit } from "@/components/layout/DesktopSplit";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";

function usePhoneParallaxPx() {
  const [y, setY] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
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
  }, []);

  if (reduceMotion) return 0;
  return Math.min(32, y * 0.09);
}

export function MarketingHome() {
  const { language, setLanguage } = useUserLanguage();
  const t = getUserMessages(language);
  const parallaxY = usePhoneParallaxPx();

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
            className="gap-y-2 sm:gap-y-3 lg:gap-y-8"
            head={
              <header className="space-y-1.5 text-center sm:space-y-2 lg:space-y-3 lg:text-left">
                <p className="text-sm font-medium tracking-wide text-nq-primary/70 sm:text-base">
                  {t.brandName}
                </p>
                <h1 className="text-2xl font-semibold leading-[1.1] tracking-tight sm:text-4xl sm:leading-tight sm:tracking-tight lg:text-6xl lg:leading-[1.08] lg:tracking-tight xl:text-7xl">
                  {t.heroHeadline}
                </h1>
                <p className="line-clamp-2 text-pretty text-sm leading-snug text-nq-foreground/88 sm:text-base sm:leading-normal">
                  {t.heroSubline}
                </p>
              </header>
            }
            rest={
              <div className="flex w-full min-w-0 flex-col space-y-5 sm:space-y-6 lg:space-y-8">
                <div className="flex w-full flex-col gap-2.5 sm:gap-3">
                  <Button
                    type="button"
                    size="lg"
                    className="h-14 min-h-14 w-full self-center sm:max-w-md lg:max-w-md lg:self-start"
                  >
                    {t.cta}
                  </Button>
                </div>

                <div className="flex w-full flex-col gap-2 sm:gap-2">
                  <Input
                    placeholder={t.phonePlaceholder}
                    name="phone"
                    type="tel"
                    autoComplete="tel"
                    inputMode="tel"
                  />
                </div>

                <div className="space-y-3 text-center sm:space-y-4 lg:text-left">
                  <p className="text-sm text-nq-muted sm:text-[15px] lg:text-base">
                    {t.socialProof}
                  </p>
                  <Card className="text-left">
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
                  className="space-y-3 text-center sm:space-y-4 lg:text-left"
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
                        <article className="rounded-2xl border border-white/10 bg-nq-surface/40 px-4 py-4 sm:px-5">
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
              <div
                className="relative w-full min-w-0 max-w-[16rem] will-change-transform sm:max-w-[17rem] lg:mx-auto lg:max-w-[21rem] xl:max-w-[22.5rem]"
                style={{
                  transform: `translate3d(0, ${parallaxY}px, 0)`,
                }}
              >
                <div
                  className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-[min(22rem,50vh)] w-[min(20rem,88vw)] max-w-full -translate-x-1/2 -translate-y-1/2 sm:h-[min(26rem,60vh)] sm:w-[min(26rem,90vw)]"
                  aria-hidden
                >
                  <div className="h-full w-full rounded-full bg-nq-primary/18 blur-[72px] opacity-90 sm:blur-[90px] lg:blur-[100px]" />
                </div>
                <div className="relative z-10 w-full">
                  <PhoneFrame
                    className="max-w-full py-0 sm:max-w-full lg:max-w-none"
                    statusLabel="9:41"
                    serviceStrip={t.serviceStrip}
                  >
                    <p className="p-1 text-center text-xs leading-relaxed text-nq-primary-soft sm:text-sm">
                      {t.phoneScreenBody}
                    </p>
                  </PhoneFrame>
                </div>
              </div>
            }
          />
        </div>
      </MobileStack>
    </ResponsiveShell>
  );
}
