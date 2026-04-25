"use client";

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

export function MarketingHome() {
  const { language, setLanguage } = useUserLanguage();
  const t = getUserMessages(language);

  return (
    <ResponsiveShell>
      <div className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] z-20 sm:top-4 sm:right-4">
        <UserLanguageToggle
          language={language}
          onLanguageChange={setLanguage}
        />
      </div>
      <MobileStack className="pt-4 sm:pt-6 lg:pt-0">
        <DesktopSplit
          head={
            <header className="space-y-2 text-center sm:space-y-2.5 lg:space-y-4 lg:text-left">
              <p className="text-base font-medium tracking-wide text-nq-primary/70 lg:text-lg">
                {t.brandName}
              </p>
              <h1 className="text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl sm:leading-tight sm:tracking-tight lg:text-6xl lg:leading-[1.08] lg:tracking-tight xl:text-7xl xl:leading-[1.05]">
                {t.heroHeadline}
              </h1>
              <p className="text-pretty text-base leading-snug text-nq-foreground/90 sm:text-base sm:leading-normal lg:text-lg lg:leading-normal xl:text-xl">
                {t.seoIntro}
              </p>
              <p className="text-balance text-base font-medium leading-snug text-nq-primary-soft sm:text-lg sm:leading-normal lg:text-xl">
                {t.tagline}
              </p>
              <p className="text-pretty text-sm text-nq-muted sm:text-sm lg:text-base lg:text-lg">
                {t.setupTime}
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
                  <span className="lg:hidden">{t.ctaMobile}</span>
                  <span className="hidden lg:inline">{t.cta}</span>
                </Button>
              </div>

              <div className="flex w-full flex-col gap-2 sm:gap-2">
                <Input
                  placeholder={t.phonePlaceholder}
                  name="contact"
                  type="tel"
                  autoComplete="tel"
                />
                <p className="text-center text-xs text-nq-muted sm:text-sm lg:text-left">
                  {t.phoneHint}
                </p>
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
            <div className="relative -mt-0.5 w-full min-w-0 max-w-[17.5rem] sm:-mt-0 sm:max-w-[17.5rem] lg:mx-auto lg:max-w-[21rem] xl:max-w-[22.5rem]">
              <div
                className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-[min(28rem,70vh)] w-[min(28rem,90vw)] max-w-full -translate-x-1/2 -translate-y-1/2"
                aria-hidden
              >
                <div className="hidden h-full w-full rounded-full bg-nq-primary/20 blur-[100px] opacity-90 lg:block" />
              </div>
              <PhoneFrame
                className="relative z-10 max-w-full py-0 sm:max-w-full lg:max-w-none"
                statusLabel="9:41"
                serviceStrip={t.serviceStrip}
              >
                <p className="p-1 text-center text-xs leading-relaxed text-nq-primary-soft sm:text-sm">
                  {t.phoneScreenBody}
                </p>
              </PhoneFrame>
            </div>
          }
        />
      </MobileStack>
    </ResponsiveShell>
  );
}
