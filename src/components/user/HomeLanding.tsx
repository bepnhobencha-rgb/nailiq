"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";
import { getUserMessages } from "@/shared/i18n/user";
import { REG_SESSION_PHONE_DIGITS_KEY } from "@/shared/lib/registerSessionKeys";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

export function HomeLanding() {
  const router = useRouter();
  const { language, setLanguage } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language), [language]);

  const onStartRegister = useCallback(() => {
    const el = document.querySelector<HTMLInputElement>('input[name="phone"]');
    const phone = normalizeRegisterPhone(el?.value ?? "");
    if (typeof window !== "undefined" && isRegisterPhoneDigitsValid(phone)) {
      window.sessionStorage.setItem(REG_SESSION_PHONE_DIGITS_KEY, phone);
    }
    router.push("/register");
  }, [router]);

  return (
    <ResponsiveShell showAmbient={false}>
      <div
        className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] z-20 sm:top-4 sm:right-4"
      >
        <UserLanguageToggle language={language} onLanguageChange={setLanguage} />
      </div>

      <MobileStack className="flex min-h-[70vh] flex-col justify-center pb-safe pt-10 sm:pt-14">
        <nav
          className="mb-6 flex w-full max-w-full items-center gap-2 sm:mb-8 sm:gap-3"
          aria-label="Site"
        >
          <Link
            href="/"
            className="shrink-0 text-sm font-semibold tracking-tight text-nq-foreground/92"
          >
            {t.brandName}
          </Link>
          <div className="flex min-w-0 flex-1 justify-center px-0.5">
            <Link
              href="/register"
              className={cn(
                "inline-flex items-center gap-0.5 text-sm text-nq-muted/80",
                "transition-colors duration-150 hover:text-nq-primary",
              )}
            >
              <span className="sm:hidden">
                {t.home.navOwnerLoginShort}{" "}
                <span aria-hidden>↗</span>
              </span>
              <span className="hidden sm:inline">
                {t.home.navOwnerLogin}{" "}
                <span aria-hidden>↗</span>
              </span>
            </Link>
          </div>
          <Button
            type="button"
            size="sm"
            variant="primary"
            className="h-9 min-h-9 shrink-0 rounded-full px-3 text-xs font-semibold sm:h-10 sm:min-h-10 sm:px-4 sm:text-sm"
            onClick={onStartRegister}
          >
            {t.home.ctaRegister}
          </Button>
        </nav>

        <p className="sr-only text-balance">{t.seoIntro}</p>

        <header className="space-y-4 text-center sm:space-y-5">
          <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-nq-muted sm:text-[11px]">
            {t.brandName}
          </p>
          <h1 className="mx-auto max-w-[20ch] text-balance text-2xl font-semibold tracking-tight text-nq-foreground sm:max-w-xl sm:text-4xl">
            {t.home.headline}
          </h1>
          <p className="mx-auto max-w-md text-pretty text-[15px] leading-relaxed text-nq-muted sm:text-lg">
            {t.home.subline}
          </p>
        </header>

        <div className="mt-10 flex w-full flex-col gap-4">
          <Button
            type="button"
            size="lg"
            variant="primary"
            className="w-full"
            onClick={onStartRegister}
          >
            {t.home.ctaRegister}
          </Button>

          <div className="flex flex-col">
            <Input
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={
                language === "vi"
                  ? "Số điện thoại (tùy chọn, điền trước khi bấm Bắt đầu)"
                  : "Phone (optional — enter before Get started)"
              }
              aria-label={language === "vi" ? "Số điện thoại" : "Phone number"}
            />
            <p className="mt-3 text-center text-xs text-nq-muted/60 sm:text-[12px]">
              {t.home.alreadySalonPrefix}
              <Link
                href="/register"
                className="text-nq-muted/60 transition-colors duration-150 hover:text-nq-primary"
              >
                {t.home.signInLink}
              </Link>
            </p>
          </div>

          <p className="text-center text-xs text-nq-muted sm:text-sm">
            {t.home.footerNote}{" "}
            <Link
              href="/register"
              className="text-nq-primary-soft underline decoration-nq-primary/30 underline-offset-2"
            >
              {language === "vi" ? "Đăng ký" : "Register"}
            </Link>
          </p>
        </div>
      </MobileStack>
    </ResponsiveShell>
  );
}
