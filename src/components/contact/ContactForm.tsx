"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { submitContactInquiry } from "@/shared/contact/submitContactInquiry";
import { cn } from "@/shared/lib/cn";

type FormState = "idle" | "success";
type PosValue = "" | "square" | "clover" | "toast" | "other" | "none";
type PlanValue = "" | "monthly" | "annual" | "unsure";

function readQueryParam(name: string): string {
  if (typeof window === "undefined") return "";
  try {
    return new URLSearchParams(window.location.search).get(name) ?? "";
  } catch {
    return "";
  }
}

export function ContactForm() {
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.contact,
    [language],
  );

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [salon, setSalon] = useState("");
  const [pos, setPos] = useState<PosValue>("");
  const [posOther, setPosOther] = useState("");
  const [plan, setPlan] = useState<PlanValue>("");
  const [intent, setIntent] = useState<"pilot" | "demo" | "">("");
  const [message, setMessage] = useState("");
  // Hidden honeypot — real users leave it untouched.
  const [botField, setBotField] = useState("");

  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    email?: string;
    message?: string;
  }>({});
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [state, setState] = useState<FormState>("idle");
  const [pending, startTransition] = useTransition();

  // Hydrate optional prefills from URL: /contact?intent=pilot&plan=monthly
  // Client-only + one-shot: safer than useSearchParams (avoids requiring a
  // Suspense boundary in the caller) and cheaper than useSyncExternalStore
  // for a single mount-time read that never changes afterward.
  useEffect(() => {
    const rawIntent = readQueryParam("intent");
    const rawPlan = readQueryParam("plan");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount hydration; URL params never change while mounted
    if (rawIntent === "pilot" || rawIntent === "demo") setIntent(rawIntent);
    if (rawPlan === "monthly" || rawPlan === "annual" || rawPlan === "unsure")
      setPlan(rawPlan);
  }, []);

  function validate(): boolean {
    const errs: typeof fieldErrors = {};
    if (name.trim().length === 0) errs.name = t.errors.nameRequired;
    if (email.trim().length === 0) errs.email = t.errors.emailRequired;
    else if (!isValidEmailFormat(email.trim()))
      errs.email = t.errors.emailInvalid;
    if (message.trim().length === 0) errs.message = t.errors.messageRequired;
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBannerError(null);
    if (!validate()) return;
    startTransition(async () => {
      const res = await submitContactInquiry({
        name: name.trim(),
        email: email.trim(),
        salon: salon.trim() || undefined,
        pos: pos || undefined,
        posOther: pos === "other" ? posOther.trim() || undefined : undefined,
        plan: plan || undefined,
        intent: intent || undefined,
        message: message.trim(),
        _botField: botField,
      });
      if (res.ok) {
        setState("success");
        return;
      }
      if (res.reason === "rate_limited") setBannerError(t.errors.rateLimited);
      else if (res.reason === "invalid_email")
        setFieldErrors((s) => ({ ...s, email: t.errors.emailInvalid }));
      else if (res.reason === "invalid_name")
        setFieldErrors((s) => ({ ...s, name: t.errors.nameRequired }));
      else if (res.reason === "invalid_message")
        setFieldErrors((s) => ({ ...s, message: t.errors.messageRequired }));
      else setBannerError(t.errors.serverError);
    });
  }

  if (state === "success") {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="contact-success"
        className="rounded-2xl border border-nq-primary/40 bg-nq-primary/5 p-6 md:p-8"
      >
        <h2 className="text-xl font-semibold text-nq-foreground md:text-2xl">
          {t.successHeading}
        </h2>
        <p className="mt-3 text-sm text-nq-muted md:text-base">
          {t.successBody}
        </p>
        <button
          type="button"
          onClick={() => {
            setName("");
            setEmail("");
            setSalon("");
            setPos("");
            setPosOther("");
            setPlan("");
            setMessage("");
            setFieldErrors({});
            setBannerError(null);
            setState("idle");
          }}
          className="mt-5 inline-flex items-center justify-center rounded-full border border-nq-border/50 bg-nq-surface/60 px-5 py-2.5 text-sm font-medium text-nq-foreground transition hover:bg-nq-surface"
        >
          {t.sendAnother}
        </button>
      </div>
    );
  }

  const intentBannerCopy =
    intent === "pilot"
      ? t.intentPilot
      : intent === "demo"
        ? t.intentDemo
        : null;

  return (
    <form
      onSubmit={onSubmit}
      method="post"
      noValidate
      data-testid="contact-form"
      className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-6 md:p-8"
    >
      {intentBannerCopy ? (
        <div
          data-testid={`contact-intent-${intent}`}
          className="mb-6 rounded-xl border border-nq-primary/30 bg-nq-primary/10 px-4 py-3 text-sm text-nq-primary-soft"
        >
          {intentBannerCopy}
        </div>
      ) : null}

      <h2 className="text-xl font-semibold text-nq-foreground md:text-2xl">
        {t.formHeading}
      </h2>

      <div className="mt-6 space-y-5">
        {/* Name */}
        <div>
          <label
            htmlFor="contact-name"
            className="mb-2 block text-sm font-medium text-nq-foreground"
          >
            {t.nameLabel}
          </label>
          <input
            id="contact-name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder={t.namePlaceholder}
            aria-invalid={Boolean(fieldErrors.name) || undefined}
            aria-describedby={
              fieldErrors.name ? "contact-name-error" : undefined
            }
            className={cn(
              "w-full rounded-xl border bg-nq-bg/50 px-4 py-3 text-base text-nq-foreground placeholder:text-nq-muted/50 focus:outline-none focus:ring-2 focus:ring-nq-primary/50",
              fieldErrors.name
                ? "border-nq-error/50"
                : "border-nq-border/40",
            )}
          />
          {fieldErrors.name ? (
            <p
              id="contact-name-error"
              role="alert"
              className="mt-1.5 text-xs text-nq-error"
            >
              {fieldErrors.name}
            </p>
          ) : null}
        </div>

        {/* Email */}
        <div>
          <label
            htmlFor="contact-email"
            className="mb-2 block text-sm font-medium text-nq-foreground"
          >
            {t.emailLabel}
          </label>
          <input
            id="contact-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            placeholder={t.emailPlaceholder}
            aria-invalid={Boolean(fieldErrors.email) || undefined}
            aria-describedby={
              fieldErrors.email ? "contact-email-error" : undefined
            }
            className={cn(
              "w-full rounded-xl border bg-nq-bg/50 px-4 py-3 text-base text-nq-foreground placeholder:text-nq-muted/50 focus:outline-none focus:ring-2 focus:ring-nq-primary/50",
              fieldErrors.email
                ? "border-nq-error/50"
                : "border-nq-border/40",
            )}
          />
          {fieldErrors.email ? (
            <p
              id="contact-email-error"
              role="alert"
              className="mt-1.5 text-xs text-nq-error"
            >
              {fieldErrors.email}
            </p>
          ) : null}
        </div>

        {/* Salon */}
        <div>
          <label
            htmlFor="contact-salon"
            className="mb-2 block text-sm font-medium text-nq-foreground"
          >
            {t.salonLabel}
          </label>
          <input
            id="contact-salon"
            type="text"
            autoComplete="organization"
            value={salon}
            onChange={(e) => setSalon(e.target.value)}
            maxLength={200}
            placeholder={t.salonPlaceholder}
            className="w-full rounded-xl border border-nq-border/40 bg-nq-bg/50 px-4 py-3 text-base text-nq-foreground placeholder:text-nq-muted/50 focus:outline-none focus:ring-2 focus:ring-nq-primary/50"
          />
        </div>

        {/* Current POS */}
        <fieldset>
          <legend className="mb-2 block text-sm font-medium text-nq-foreground">
            {t.posLabel}
          </legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { key: "square", label: t.posOptions.square },
                { key: "clover", label: t.posOptions.clover },
                { key: "toast", label: t.posOptions.toast },
                { key: "other", label: t.posOptions.other },
                { key: "none", label: t.posOptions.none },
              ] as const
            ).map((opt) => {
              const active = pos === opt.key;
              return (
                <label
                  key={opt.key}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-sm transition",
                    active
                      ? "border-nq-primary/60 bg-nq-primary/15 text-nq-primary-soft"
                      : "border-nq-border/40 bg-nq-surface/40 text-nq-muted hover:text-nq-foreground",
                  )}
                >
                  <input
                    type="radio"
                    name="pos"
                    value={opt.key}
                    checked={active}
                    onChange={() => setPos(opt.key)}
                    className="sr-only"
                    data-testid={`contact-pos-${opt.key}`}
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
          {pos === "other" ? (
            <input
              id="contact-pos-other"
              type="text"
              value={posOther}
              onChange={(e) => setPosOther(e.target.value)}
              maxLength={80}
              placeholder={t.posOtherPlaceholder}
              aria-label={t.posOtherLabel}
              className="mt-3 w-full rounded-xl border border-nq-border/40 bg-nq-bg/50 px-4 py-3 text-base text-nq-foreground placeholder:text-nq-muted/50 focus:outline-none focus:ring-2 focus:ring-nq-primary/50"
            />
          ) : null}
        </fieldset>

        {/* Plan preference */}
        <fieldset>
          <legend className="mb-2 block text-sm font-medium text-nq-foreground">
            {t.planLabel}
          </legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { key: "monthly", label: t.planOptions.monthly },
                { key: "annual", label: t.planOptions.annual },
                { key: "unsure", label: t.planOptions.unsure },
              ] as const
            ).map((opt) => {
              const active = plan === opt.key;
              return (
                <label
                  key={opt.key}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-sm transition",
                    active
                      ? "border-nq-primary/60 bg-nq-primary/15 text-nq-primary-soft"
                      : "border-nq-border/40 bg-nq-surface/40 text-nq-muted hover:text-nq-foreground",
                  )}
                >
                  <input
                    type="radio"
                    name="plan"
                    value={opt.key}
                    checked={active}
                    onChange={() => setPlan(opt.key)}
                    className="sr-only"
                    data-testid={`contact-plan-${opt.key}`}
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Message */}
        <div>
          <label
            htmlFor="contact-message"
            className="mb-2 block text-sm font-medium text-nq-foreground"
          >
            {t.messageLabel}
          </label>
          <textarea
            id="contact-message"
            required
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={4000}
            rows={5}
            placeholder={t.messagePlaceholder}
            aria-invalid={Boolean(fieldErrors.message) || undefined}
            aria-describedby={
              fieldErrors.message ? "contact-message-error" : undefined
            }
            className={cn(
              "w-full resize-y rounded-xl border bg-nq-bg/50 px-4 py-3 text-base text-nq-foreground placeholder:text-nq-muted/50 focus:outline-none focus:ring-2 focus:ring-nq-primary/50",
              fieldErrors.message
                ? "border-nq-error/50"
                : "border-nq-border/40",
            )}
          />
          {fieldErrors.message ? (
            <p
              id="contact-message-error"
              role="alert"
              className="mt-1.5 text-xs text-nq-error"
            >
              {fieldErrors.message}
            </p>
          ) : null}
        </div>

        {/* Honeypot — hidden from sighted + assistive tech, but
            scrapers/bots that fill every input get a silent drop. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: "-9999px",
            top: "-9999px",
            width: 1,
            height: 1,
            overflow: "hidden",
          }}
        >
          <label htmlFor="contact-website">
            Website (leave empty)
          </label>
          <input
            id="contact-website"
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={botField}
            onChange={(e) => setBotField(e.target.value)}
          />
        </div>

        {bannerError ? (
          <p
            role="alert"
            data-testid="contact-banner-error"
            className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
          >
            {bannerError}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          data-testid="contact-submit"
          className="inline-flex w-full items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-6 py-3.5 text-base font-semibold text-nq-bg shadow-[0_8px_28px_-8px_rgba(212,175,55,0.55)] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:min-w-[16rem]"
        >
          {pending ? t.submitting : t.submit}
        </button>
      </div>
    </form>
  );
}
