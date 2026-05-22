"use client";

// BirthdayField — optional birthday input for the public booking contact-info step.
// Shown in the booking language (EN/VI based on cookie).
// Does NOT render if the customer already has a birthday on file (checked via props).

import { type ChangeEvent } from "react";
import { cn } from "@/shared/lib/cn";

type Props = {
  /** ISO date string YYYY-MM-DD or empty string */
  value: string;
  onChange: (v: string) => void;
  /** If true, the field is not rendered (birthday already known). */
  alreadyOnFile?: boolean;
  /** UI language: 'en' | 'vi'. Defaults to 'vi'. */
  lang?: string;
  className?: string;
};

const LABELS = {
  en: {
    label: "Birthday",
    hint: "Optional — for birthday surprises!",
  },
  vi: {
    label: "Sinh nhật",
    hint: "Không bắt buộc — để nhận quà sinh nhật!",
  },
} as const;

/**
 * Optional birthday date input rendered in the booking contact-info step.
 * Uses the `.nq-booking-field` CSS class so it inherits the booking page theme.
 */
export function BirthdayField({
  value,
  onChange,
  alreadyOnFile = false,
  lang = "vi",
  className,
}: Props) {
  if (alreadyOnFile) return null;

  const resolvedLang = lang === "en" ? "en" : "vi";
  const { label, hint } = LABELS[resolvedLang];

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    onChange(e.target.value);
  }

  return (
    <div className={cn("w-full", className)}>
      <label
        htmlFor="booking-birthday"
        className="mb-1.5 block text-sm font-medium"
        style={{ color: "var(--booking-text, var(--color-nq-foreground))" }}
      >
        {label}{" "}
        <span
          className="text-xs font-normal"
          style={{ color: "var(--booking-text-muted, var(--color-nq-muted))" }}
        >
          {hint}
        </span>
      </label>
      <input
        id="booking-birthday"
        type="date"
        name="birthday"
        autoComplete="bday"
        value={value}
        onChange={handleChange}
        // Limit year range: no future birthdays, no one born before 1900
        max={new Date().toISOString().slice(0, 10)}
        min="1900-01-01"
        className="nq-booking-field"
        // Muted placeholder text shown for empty date pickers
        placeholder="YYYY-MM-DD"
        aria-label={label}
        aria-describedby="booking-birthday-hint"
      />
      <p
        id="booking-birthday-hint"
        className="sr-only"
      >
        {hint}
      </p>
    </div>
  );
}

export default BirthdayField;
