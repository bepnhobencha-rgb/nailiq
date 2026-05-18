"use client";

import { useState, useTransition, useMemo } from "react";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { submitContactInquiry } from "@/shared/contact/submitContactInquiry";
import { cn } from "@/shared/lib/cn";

type FormState = "idle" | "success";

export function ContactForm() {
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.contact,
    [language],
  );

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [salon, setSalon] = useState("");
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
        message: message.trim(),
        _botField: botField,
      });
      if (res.ok) {
        setState("success");
        return;
      }
      // Map server-side reasons back to copy. Server already
      // mirrors client-side checks, so a `reason` here generally
      // means a server-only path (rate limit, Resend down).
      if (res.reason === "rate_limited")
        setBannerError(t.errors.rateLimited);
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

  return (
    <form
      onSubmit={onSubmit}
      method="post"
      noValidate
      data-testid="contact-form"
      className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-6 md:p-8"
    >
      <h2 className="text-xl font-semibold text-nq-foreground md:text-2xl">
        {t.formHeading}
      </h2>

      <div className="mt-6 space-y-5">
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

        <div>
          <label
            htmlFor="contact-message"
            className="mb-2 block text-sm font-medium text-nq-foreground"
          >
            {t.messageLabel}
          </label>
          <textarea
            id="contact-message"
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
            scrapers/bots that fill every input get a silent drop.
            `tabIndex={-1}` + `autoComplete="off"` keep real users
            from accidentally tabbing into it. */}
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
