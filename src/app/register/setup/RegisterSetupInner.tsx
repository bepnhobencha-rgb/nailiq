"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { getUserMessages } from "@/shared/i18n/user";
import { DEMO_SALON_SLUG } from "@/shared/lib/demoOtpMode";
import { REG_COMPLETION_TOKEN_KEY } from "@/shared/lib/registerSessionKeys";
import { slugifySalonName } from "@/shared/lib/slugifySalonName";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { completeSalonRegistration } from "@/shared/register/completeSalonRegistrationAction";

/**
 * Reads the completion token, preferring the URL `?ct=…` param (survives
 * reload — written by `/register/verify` after OTP success) and falling
 * back to sessionStorage for back-compat with in-flight tabs.
 */
function readCompletionToken(urlToken: string | null): string | null {
  const fromUrl = urlToken?.trim();
  if (fromUrl && fromUrl.length > 0) return fromUrl;
  if (typeof window === "undefined") return null;
  const fromSession = window.sessionStorage.getItem(REG_COMPLETION_TOKEN_KEY);
  return fromSession?.trim() ? fromSession.trim() : null;
}

/** Pre-fills the name input in demo mode; slugifies to DEMO_SALON_SLUG. */
const DEMO_SALON_DISPLAY_NAME = "Demo Salon";

/**
 * Wizard timezone select options. Mirror of the `ALLOWED_WIZARD_TIMEZONES`
 * server allowlist in completeSalonRegistrationAction.ts. Default is
 * America/Vancouver per the QA spec (primary B2C market: Vietnamese-speaking
 * salon owners in BC).
 */
const TIMEZONE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "America/Vancouver", label: "BC · Vancouver (Pacific)" },
  { value: "America/Edmonton", label: "Alberta · Edmonton (Mountain)" },
  { value: "America/Toronto", label: "Ontario · Toronto (Eastern)" },
  { value: "America/Los_Angeles", label: "California · Los Angeles (Pacific)" },
  { value: "Asia/Ho_Chi_Minh", label: "Việt Nam (TP. Hồ Chí Minh)" },
];

const DEFAULT_TIMEZONE = "America/Vancouver";

/**
 * Server-side prefill payload for users who already own a salon but
 * haven't finished the wizard (setup_wizard_completed_at IS NULL).
 * The wizard then runs as an UPDATE rather than INSERT — see
 * completeSalonRegistration's existing-member rename branch.
 */
export type RegisterSetupInitial = {
  mode: "rename";
  currentSlug: string;
  name: string;
  timezone: string | null;
};

export default function RegisterSetupInner({
  isDemoMode,
  initial,
}: {
  /**
   * Server-authoritative demo flag (resolved in `page.tsx` via
   * `isDemoOtpRuntime()`). Passed in to avoid client/server hydration
   * mismatches when only `DEMO_OTP` (server-only) is set.
   */
  isDemoMode: boolean;
  /**
   * Existing-salon prefill for the rename path. Null = fresh signup.
   */
  initial?: RegisterSetupInitial | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlToken = searchParams?.get("ct") ?? null;
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).register, [language]);

  const isRenameMode = !isDemoMode && initial?.mode === "rename";

  const [name, setName] = useState(() => {
    if (isDemoMode) return DEMO_SALON_DISPLAY_NAME;
    return initial?.name ?? "";
  });
  // Editable slug. When `slugTouched === false`, the slug auto-tracks the
  // name. Once the user types in the slug field directly (or we prefilled
  // it from an existing salon), we stop auto-syncing so their custom URL
  // isn't clobbered on the next keystroke.
  const [slug, setSlug] = useState(() => {
    if (isDemoMode) return DEMO_SALON_SLUG;
    return initial?.currentSlug ?? "";
  });
  const [slugTouched, setSlugTouched] = useState(isRenameMode);
  const [timezone, setTimezone] = useState(() => {
    const fromInitial = initial?.timezone?.trim();
    if (fromInitial) return fromInitial;
    return DEFAULT_TIMEZONE;
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    // In demo mode the page bypasses server-side auth gating, so a missing
    // token is the only signal that this surface is being accessed without
    // having gone through /register first. In production the server's
    // auth.getUser() check already gates the page, and OAuth / email
    // magic-link signups land here authenticated but token-less.
    if (!isDemoMode) return;
    if (typeof window === "undefined") return;
    const token = readCompletionToken(urlToken);
    if (!token) {
      router.replace("/register");
    }
  }, [isDemoMode, router, urlToken]);

  // Auto-derive slug from name unless the user has overridden it.
  const derivedSlug = useMemo(() => {
    if (isDemoMode) return DEMO_SALON_SLUG;
    return slugifySalonName(name.trim()) || "my-salon";
  }, [isDemoMode, name]);

  useEffect(() => {
    if (isDemoMode) return;
    if (slugTouched) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror of derivedSlug while user hasn't taken control
    setSlug(derivedSlug);
  }, [derivedSlug, isDemoMode, slugTouched]);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedName = name.trim();
      const trimmedSlug = slug.trim();
      if (!trimmedName) return;
      setFormError(null);
      startTransition(async () => {
        const completionToken = readCompletionToken(urlToken);

        const result = await completeSalonRegistration(
          trimmedName,
          completionToken,
          {
            slug: isDemoMode ? null : trimmedSlug,
            timezone: isDemoMode ? null : timezone,
          },
        );

        if (!result.ok) {
          if (result.error === "unauthorized") {
            router.replace("/register");
            return;
          }
          if (result.error === "invalid_completion_token") {
            setFormError(t.submitErrorExpiredToken);
            return;
          }
          if (result.error === "invalid_name") {
            setFormError(t.salonNameInvalid);
            return;
          }
          if (result.message?.trim()) {
            setFormError(result.message.trim());
            return;
          }
          setFormError(t.submitErrorGeneric);
          return;
        }

        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(REG_COMPLETION_TOKEN_KEY);
        }

        const adj = result.slugAdjusted ? "1" : "0";
        router.replace(
          `/register/success?slug=${encodeURIComponent(result.slug)}&adjusted=${adj}`,
        );
      });
    },
    [
      isDemoMode,
      name,
      router,
      slug,
      timezone,
      urlToken,
      t.submitErrorExpiredToken,
      t.salonNameInvalid,
      t.submitErrorGeneric,
    ],
  );

  return (
    <RegisterStepShell title={t.wizardTitle} subtext={t.wizardSubtext} step={{ current: 2, total: 3 }}>
      <form
        onSubmit={onSubmit}
        method="post"
        className="flex flex-col gap-6"
      >
        <div>
          <label
            htmlFor="register-setup-salon-name"
            className="mb-2 block text-base font-semibold text-nq-foreground"
          >
            {t.salonNameLabel}
          </label>
          <Input
            id="register-setup-salon-name"
            name="salonName"
            placeholder={t.salonNamePlaceholder}
            className="text-base"
            value={name}
            onChange={(e) => {
              if (isDemoMode) return;
              setName(e.target.value);
              if (formError) setFormError(null);
            }}
            autoComplete="organization"
            autoFocus={!isDemoMode}
            readOnly={isDemoMode}
            aria-readonly={isDemoMode || undefined}
            error={Boolean(formError)}
          />
          {!isDemoMode ? (
            <p className="mt-2 text-pretty text-xs leading-relaxed text-nq-muted">
              {t.salonNameHint}
            </p>
          ) : (
            <p
              className="mt-3 text-pretty text-xs leading-relaxed text-nq-muted"
              data-testid="demo-mode-hint"
            >
              Demo mode uses shared salon:{" "}
              <span className="font-mono text-nq-foreground/90">
                {DEMO_SALON_SLUG}
              </span>
              . The name and slug aren&rsquo;t configurable in this build.
            </p>
          )}
        </div>

        <div className="sr-only" aria-hidden="true">
          <label
            htmlFor="register-setup-slug"
            className="mb-2 block text-base font-semibold text-nq-foreground"
          >
            {t.slugLabel}
          </label>
          <div className="flex items-center gap-2 rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2 focus-within:border-nq-primary/80 focus-within:shadow-nq-input-focus">
            <span className="shrink-0 select-none font-mono text-sm text-nq-muted">
              /
            </span>
            <input
              id="register-setup-slug"
              name="salonSlug"
              type="text"
              inputMode="url"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              aria-label={t.slugAriaLabel}
              tabIndex={-1}
              className="min-w-0 flex-1 bg-transparent font-mono text-sm text-nq-foreground outline-none placeholder:text-nq-muted/80 disabled:opacity-70"
              value={slug}
              readOnly={isDemoMode}
              onChange={(e) => {
                if (isDemoMode) return;
                if (!slugTouched) setSlugTouched(true);
                // Sanitize on the way in — only allow slug-friendly chars
                // so the previewed URL never displays something the
                // server would silently strip.
                const next = e.target.value
                  .toLowerCase()
                  .replace(/\s+/g, "-")
                  .replace(/[^a-z0-9-]/g, "")
                  .replace(/-+/g, "-");
                setSlug(next);
                if (formError) setFormError(null);
              }}
            />
          </div>
          {!isDemoMode ? (
            <p className="mt-2 text-pretty text-xs leading-relaxed text-nq-muted">
              {t.slugHint}
            </p>
          ) : null}
        </div>

        <div className="sr-only" aria-hidden="true">
          <label
            htmlFor="register-setup-timezone"
            className="mb-2 block text-base font-semibold text-nq-foreground"
          >
            {t.timezoneLabel}
          </label>
          <select
            id="register-setup-timezone"
            name="salonTimezone"
            value={timezone}
            disabled={isDemoMode}
            tabIndex={-1}
            onChange={(e) => {
              if (isDemoMode) return;
              setTimezone(e.target.value);
            }}
            className="block w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base text-nq-foreground outline-none focus-visible:border-nq-primary/80 focus-visible:shadow-nq-input-focus disabled:opacity-70"
          >
            {TIMEZONE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {!isDemoMode ? (
            <p className="mt-2 text-pretty text-xs leading-relaxed text-nq-muted">
              {t.timezoneHint}
            </p>
          ) : null}
        </div>

        {formError ? (
          <p className="text-sm text-nq-error" role="status">
            {formError}
          </p>
        ) : null}

        <Button
          type="submit"
          size="lg"
          className="w-full min-h-[52px] text-base"
          disabled={!name.trim() || pending}
        >
          {pending ? t.submitCreating : t.submitCreate}
        </Button>
      </form>
    </RegisterStepShell>
  );
}
