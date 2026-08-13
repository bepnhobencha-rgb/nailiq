"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { SaveButton, type SaveButtonStatus } from "@/components/ui/SaveButton";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { updateAddress } from "@/shared/dashboard/setupActions";
import {
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  type Currency,
} from "@/shared/lib/currencyFormat";
import {
  SETUP_COUNTRY_OPTIONS,
  filterSalonPhoneInput,
  isAllowedCountry,
  isValidPhone,
  isValidPostalCode,
  parseStoredAddress,
  validateCity,
  validateProvince,
  validateStreet,
} from "@/shared/dashboard/addressSetupValidation";
import {
  SETUP_TIMEZONE_DEFAULT,
  SETUP_TIMEZONE_OPTIONS,
  isAllowedTimezone,
} from "@/shared/dashboard/timezoneOptions";
import { cn } from "@/shared/lib/cn";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

const TOAST_ERR = "✗ Could not save. Check your connection.";
const ERR = {
  street: "Please enter street address",
  city: "Please enter city",
  province: "Please enter province or state",
  postal: "Please enter a valid postal or ZIP code",
  country: "Please select country",
  phone: "Please enter a valid phone number (8–15 digits)",
  timezone: "Timezone is required",
} as const;

type FieldKey =
  "street" | "city" | "province" | "postal" | "country" | "phone" | "timezone";

type AddressFormState = {
  street: string;
  city: string;
  province: string;
  postal: string;
  country: string;
  salonPhone: string;
  currency: Currency;
  description: string;
  timezone: string;
};

function addressFormSignature(state: AddressFormState): string {
  return JSON.stringify(state);
}

function serverErrorMessage(code: string): string {
  switch (code) {
    case "invalid_phone":
      return "Invalid phone number";
    case "invalid_street":
      return ERR.street;
    case "invalid_city":
      return ERR.city;
    case "invalid_province":
      return ERR.province;
    case "invalid_postal":
      return ERR.postal;
    case "invalid_country":
      return ERR.country;
    case "invalid_timezone":
      return ERR.timezone;
    case "invalid_address":
      return "Address could not be saved.";
    default:
      return "Could not save. Try again.";
  }
}

function formIsValid(parts: {
  street: string;
  city: string;
  province: string;
  postal: string;
  country: string;
  salonPhone: string;
  timezone: string;
}): boolean {
  return (
    validateStreet(parts.street) &&
    validateCity(parts.city) &&
    validateProvince(parts.province) &&
    isValidPostalCode(parts.postal) &&
    parts.country.trim().length > 0 &&
    isAllowedCountry(parts.country) &&
    isValidPhone(parts.salonPhone) &&
    isAllowedTimezone(parts.timezone)
  );
}

export function AddressSetupPanel({
  slug,
  initialAddress,
  initialSalonPhone,
  initialCurrency,
  initialDescription,
  initialTimezone,
  autoSave = false,
}: {
  slug: string;
  initialAddress: string;
  initialSalonPhone: string;
  /** Salon's display currency at load time. Defaulted to CAD upstream
   *  by `parseCurrency`, but kept optional here so callers can drop
   *  the prop without breaking type-check. */
  initialCurrency?: Currency;
  /** P2.8 — owner-written salon tagline shown on the booking page. */
  initialDescription?: string;
  /** Task #04-B — salon's current timezone (IANA). Empty string if
   *  the column was somehow NULL despite the NOT NULL migration —
   *  the dropdown falls back to a blank "choose one" placeholder so
   *  the owner makes a conscious selection. */
  initialTimezone?: string;
  /** Guided Setup only: persist a valid edit after the owner pauses typing. */
  autoSave?: boolean;
}) {
  const router = useRouter();
  const parsed = parseStoredAddress(initialAddress);

  const [street, setStreet] = useState(parsed.street);
  const [city, setCity] = useState(parsed.city);
  const [province, setProvince] = useState(parsed.province);
  const [postal, setPostal] = useState(parsed.postal);
  const [country, setCountry] = useState(parsed.country);
  const [salonPhone, setSalonPhone] = useState(() =>
    filterSalonPhoneInput(initialSalonPhone),
  );
  const [currency, setCurrency] = useState<Currency>(
    initialCurrency ?? DEFAULT_CURRENCY,
  );
  const [description, setDescription] = useState(initialDescription ?? "");
  // Task #04-B — timezone is a required field now. Initial value is
  // the salon's current `timezone` (always present after the
  // 20260512600000 migration); if it doesn't match one of the
  // dropdown options (e.g. legacy "UTC" value on an e2e fixture),
  // the select renders blank-but-required so the owner picks a real
  // one. We DON'T silently coerce to the default — forcing a
  // conscious choice prevents an owner from accepting a wrong
  // timezone they never reviewed.
  const [timezone, setTimezone] = useState<string>(
    initialTimezone && isAllowedTimezone(initialTimezone)
      ? initialTimezone
      : "",
  );
  // P0.1 — shared setup labels for the field text.
  const { language: pageLang } = useUserLanguage();
  const tLabels = getUserMessages(pageLang).setupLabels;

  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<FieldKey, string | undefined>>
  >({});
  const [saveStatus, setSaveStatus] = useState<SaveButtonStatus>("idle");
  const [saveBannerError, setSaveBannerError] = useState<string | null>(null);
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialFormSignature = addressFormSignature({
    street: parsed.street,
    city: parsed.city,
    province: parsed.province,
    postal: parsed.postal,
    country: parsed.country,
    salonPhone: filterSalonPhoneInput(initialSalonPhone),
    currency: initialCurrency ?? DEFAULT_CURRENCY,
    description: initialDescription ?? "",
    timezone:
      initialTimezone && isAllowedTimezone(initialTimezone)
        ? initialTimezone
        : "",
  });
  const lastSavedSignatureRef = useRef(initialFormSignature);
  const lastAutoSaveAttemptRef = useRef(initialFormSignature);

  const clearStatusTimer = useCallback(() => {
    if (statusTimerRef.current !== null) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearStatusTimer();
    },
    [clearStatusTimer],
  );

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- props → local form state */
    const p = parseStoredAddress(initialAddress);
    setStreet(p.street);
    setCity(p.city);
    setProvince(p.province);
    setPostal(p.postal);
    setCountry(p.country);
    setSalonPhone(filterSalonPhoneInput(initialSalonPhone));
    setCurrency(initialCurrency ?? DEFAULT_CURRENCY);
    setDescription(initialDescription ?? "");
    setTimezone(
      initialTimezone && isAllowedTimezone(initialTimezone)
        ? initialTimezone
        : "",
    );
    setFieldErrors({});
    const nextSignature = addressFormSignature({
      street: p.street,
      city: p.city,
      province: p.province,
      postal: p.postal,
      country: p.country,
      salonPhone: filterSalonPhoneInput(initialSalonPhone),
      currency: initialCurrency ?? DEFAULT_CURRENCY,
      description: initialDescription ?? "",
      timezone:
        initialTimezone && isAllowedTimezone(initialTimezone)
          ? initialTimezone
          : "",
    });
    lastSavedSignatureRef.current = nextSignature;
    lastAutoSaveAttemptRef.current = nextSignature;
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [
    initialAddress,
    initialSalonPhone,
    initialCurrency,
    initialDescription,
    initialTimezone,
  ]);

  const setFieldError = useCallback(
    (key: FieldKey, message: string | null) => {
      setFieldErrors((prev) => {
        if (message === null) {
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return { ...prev, [key]: message };
      });
    },
    [setFieldErrors],
  );

  const validateStreetField = useCallback(() => {
    if (!validateStreet(street)) setFieldError("street", ERR.street);
    else setFieldError("street", null);
  }, [street, setFieldError]);

  const validateCityField = useCallback(() => {
    if (!validateCity(city)) setFieldError("city", ERR.city);
    else setFieldError("city", null);
  }, [city, setFieldError]);

  const validateProvinceField = useCallback(() => {
    if (!validateProvince(province)) setFieldError("province", ERR.province);
    else setFieldError("province", null);
  }, [province, setFieldError]);

  const validatePostalField = useCallback(() => {
    if (!isValidPostalCode(postal)) setFieldError("postal", ERR.postal);
    else setFieldError("postal", null);
  }, [postal, setFieldError]);

  const validateCountryField = useCallback(() => {
    if (!country.trim() || !isAllowedCountry(country))
      setFieldError("country", ERR.country);
    else setFieldError("country", null);
  }, [country, setFieldError]);

  const validatePhoneField = useCallback(() => {
    if (!isValidPhone(salonPhone)) setFieldError("phone", ERR.phone);
    else setFieldError("phone", null);
  }, [salonPhone, setFieldError]);

  const validateTimezoneField = useCallback(() => {
    if (!isAllowedTimezone(timezone)) setFieldError("timezone", ERR.timezone);
    else setFieldError("timezone", null);
  }, [timezone, setFieldError]);

  const canSave = formIsValid({
    street,
    city,
    province,
    postal,
    country,
    salonPhone,
    timezone,
  });

  const currentFormSignature = addressFormSignature({
    street,
    city,
    province,
    postal,
    country,
    salonPhone,
    currency,
    description,
    timezone,
  });

  const save = useCallback(
    async (source: "manual" | "auto" = "manual") => {
      setSaveBannerError(null);
      // Task #04-B — guard at the form layer too. `canSave` already
      // disables the button; this is a belt-and-braces check in case
      // a future code path bypasses the disabled state. Surfacing the
      // inline error gives the owner a clearer signal than the
      // generic toast.
      if (!isAllowedTimezone(timezone)) {
        setFieldError("timezone", ERR.timezone);
        return false;
      }
      lastAutoSaveAttemptRef.current = currentFormSignature;
      clearStatusTimer();
      setSaveStatus("saving");
      const res = await updateAddress(slug, {
        street,
        city,
        province,
        postal,
        country,
        salon_phone: salonPhone,
        currency_code: currency,
        description,
        timezone,
      });
      if (!res.ok) {
        setSaveStatus("error");
        setSaveBannerError(serverErrorMessage(res.error));
        setToast({ variant: "error", message: TOAST_ERR });
        statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
        return false;
      }
      lastSavedSignatureRef.current = currentFormSignature;
      setSaveStatus("saved");
      setToast({ variant: "success", message: tLabels.addressSaved });
      statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
      if (source === "manual") router.refresh();
      return true;
    },
    [
      city,
      clearStatusTimer,
      country,
      currentFormSignature,
      currency,
      description,
      postal,
      province,
      router,
      salonPhone,
      setSaveBannerError,
      setSaveStatus,
      setToast,
      setFieldError,
      slug,
      street,
      tLabels.addressSaved,
      timezone,
    ],
  );

  useEffect(() => {
    if (!autoSave || !canSave || saveStatus === "saving") return;
    if (
      currentFormSignature === lastSavedSignatureRef.current ||
      currentFormSignature === lastAutoSaveAttemptRef.current
    ) {
      return;
    }

    const timer = setTimeout(() => {
      lastAutoSaveAttemptRef.current = currentFormSignature;
      void save("auto");
    }, 900);
    return () => clearTimeout(timer);
  }, [autoSave, canSave, currentFormSignature, save, saveStatus]);

  const inputRing =
    "rounded-xl border bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus";
  const labelClass = "block text-sm font-medium text-nq-muted";

  return (
    <div className="flex flex-col gap-4">
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      {saveBannerError ? (
        <p className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {saveBannerError}
        </p>
      ) : null}

      <label className={labelClass}>
        <span>{tLabels.streetAddress}</span>
        <span className="text-[#FF375F]" aria-hidden>
          {" "}
          *
        </span>
        <textarea
          className={cn(
            "mt-1.5 min-h-[88px] w-full resize-y border",
            inputRing,
            fieldErrors.street ? "border-red-500/50" : "border-nq-border/50",
          )}
          value={street}
          disabled={saveStatus === "saving"}
          onBlur={validateStreetField}
          onChange={(e) => {
            setStreet(e.target.value);
            if (fieldErrors.street) setFieldError("street", null);
          }}
          placeholder="123 Main Street"
        />
        {fieldErrors.street ? (
          <p className="mt-1 text-sm text-[#FF375F]" role="alert">
            {fieldErrors.street}
          </p>
        ) : null}
      </label>

      <label className={labelClass}>
        <span>{tLabels.city}</span>
        <span className="text-[#FF375F]" aria-hidden>
          {" "}
          *
        </span>
        <input
          type="text"
          autoComplete="address-level2"
          className={cn(
            "mt-1.5 flex min-h-[44px] w-full border",
            inputRing,
            fieldErrors.city ? "border-red-500/50" : "border-nq-border/50",
          )}
          value={city}
          disabled={saveStatus === "saving"}
          onBlur={validateCityField}
          onChange={(e) => {
            setCity(e.target.value);
            if (fieldErrors.city) setFieldError("city", null);
          }}
          placeholder="Vancouver"
        />
        {fieldErrors.city ? (
          <p className="mt-1 text-sm text-[#FF375F]" role="alert">
            {fieldErrors.city}
          </p>
        ) : null}
      </label>

      <label className={labelClass}>
        <span>{tLabels.provinceState}</span>
        <span className="text-[#FF375F]" aria-hidden>
          {" "}
          *
        </span>
        <input
          type="text"
          autoComplete="address-level1"
          className={cn(
            "mt-1.5 flex min-h-[44px] w-full border",
            inputRing,
            fieldErrors.province ? "border-red-500/50" : "border-nq-border/50",
          )}
          value={province}
          disabled={saveStatus === "saving"}
          onBlur={validateProvinceField}
          onChange={(e) => {
            setProvince(e.target.value);
            if (fieldErrors.province) setFieldError("province", null);
          }}
          placeholder="BC or British Columbia"
        />
        {fieldErrors.province ? (
          <p className="mt-1 text-sm text-[#FF375F]" role="alert">
            {fieldErrors.province}
          </p>
        ) : null}
      </label>

      <label className={labelClass}>
        <span>{tLabels.postalCode}</span>
        <span className="text-[#FF375F]" aria-hidden>
          {" "}
          *
        </span>
        <input
          type="text"
          autoComplete="postal-code"
          className={cn(
            "mt-1.5 flex min-h-[44px] w-full border",
            inputRing,
            fieldErrors.postal ? "border-red-500/50" : "border-nq-border/50",
          )}
          value={postal}
          disabled={saveStatus === "saving"}
          onBlur={validatePostalField}
          onChange={(e) => {
            setPostal(e.target.value);
            if (fieldErrors.postal) setFieldError("postal", null);
          }}
          placeholder="V6B 1A1 or 90210"
        />
        {fieldErrors.postal ? (
          <p className="mt-1 text-sm text-[#FF375F]" role="alert">
            {fieldErrors.postal}
          </p>
        ) : null}
      </label>

      <label className={labelClass}>
        <span>{tLabels.country}</span>
        <span className="text-[#FF375F]" aria-hidden>
          {" "}
          *
        </span>
        <select
          className={cn(
            "mt-1.5 flex min-h-[44px] w-full cursor-pointer appearance-none border bg-[length:1rem_1rem] bg-[right_0.75rem_center] bg-no-repeat pr-10",
            inputRing,
            fieldErrors.country ? "border-red-500/50" : "border-nq-border/50",
          )}
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%239ca3af'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`,
          }}
          value={country}
          disabled={saveStatus === "saving"}
          onBlur={validateCountryField}
          onChange={(e) => {
            setCountry(e.target.value);
            if (fieldErrors.country) setFieldError("country", null);
          }}
        >
          {SETUP_COUNTRY_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {fieldErrors.country ? (
          <p className="mt-1 text-sm text-[#FF375F]" role="alert">
            {fieldErrors.country}
          </p>
        ) : null}
      </label>

      {/* Task #04-B — required timezone dropdown. Sits below Country
          because the salon's IANA zone is conceptually a refinement
          of "which region am I in?". Locked to the 10-option list
          in `timezoneOptions.ts`; any free-form value would corrupt
          downstream salonTime math. */}
      <label className={labelClass}>
        <span>{tLabels.timezone}</span>
        <span className="text-[#FF375F]" aria-hidden>
          {" "}
          *
        </span>
        <select
          data-testid="setup-timezone-select"
          className={cn(
            "mt-1.5 flex min-h-[44px] w-full cursor-pointer appearance-none border bg-[length:1rem_1rem] bg-[right_0.75rem_center] bg-no-repeat pr-10",
            inputRing,
            fieldErrors.timezone ? "border-red-500/50" : "border-nq-border/50",
          )}
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%239ca3af'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`,
          }}
          value={timezone}
          disabled={saveStatus === "saving"}
          onBlur={validateTimezoneField}
          onChange={(e) => {
            setTimezone(e.target.value);
            if (fieldErrors.timezone) setFieldError("timezone", null);
          }}
        >
          {/* Blank placeholder forces a conscious choice when the
              salon currently holds an unrecognised legacy value. */}
          {!isAllowedTimezone(timezone) ? (
            <option value="" disabled>
              — {tLabels.timezone} —
            </option>
          ) : null}
          {SETUP_TIMEZONE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.value} — {pageLang === "vi" ? opt.labelVi : opt.labelEn}
            </option>
          ))}
        </select>
        {fieldErrors.timezone ? (
          <p
            className="mt-1 text-sm text-[#FF375F]"
            role="alert"
            data-testid="setup-timezone-error"
          >
            {fieldErrors.timezone}
          </p>
        ) : null}
        {/* Static default hint — clarifies which zone we'll fall
            back to if the owner skips this step elsewhere (e.g. via
            the register wizard which doesn't yet collect tz). */}
        <span className="mt-1 block text-xs text-nq-muted/80">
          {SETUP_TIMEZONE_DEFAULT}
        </span>
      </label>

      <label className={labelClass}>
        <span>{tLabels.salonPhone}</span>
        <span className="text-[#FF375F]" aria-hidden>
          {" "}
          *
        </span>
        <span className="block text-xs font-normal text-nq-muted/85">
          Different from the number you used to sign up, if you prefer.
        </span>
        <input
          inputMode="tel"
          autoComplete="tel"
          className={cn(
            "mt-1.5 flex min-h-[44px] w-full border",
            inputRing,
            fieldErrors.phone ? "border-red-500/50" : "border-nq-border/50",
          )}
          value={salonPhone}
          disabled={saveStatus === "saving"}
          onBlur={validatePhoneField}
          onChange={(e) => {
            const v = filterSalonPhoneInput(e.target.value);
            setSalonPhone(v);
            if (v.length === 0) {
              setFieldError("phone", null);
            } else if (!isValidPhone(v)) {
              setFieldError("phone", ERR.phone);
            } else {
              setFieldError("phone", null);
            }
          }}
          placeholder="+1 778-868-0738"
        />
        {fieldErrors.phone ? (
          <p className="mt-1 text-sm text-[#FF375F]" role="alert">
            {fieldErrors.phone}
          </p>
        ) : null}
      </label>

      <label className="block text-sm font-medium text-nq-foreground">
        Currency
        <span className="block text-xs font-normal text-nq-muted/85">
          Used to display service prices and revenue totals across the public
          booking page and your dashboard.
        </span>
        <select
          className={cn(
            "mt-1.5 flex min-h-[44px] w-full appearance-none border",
            inputRing,
            "border-nq-border/50",
          )}
          value={currency}
          disabled={saveStatus === "saving"}
          data-testid="salon-currency-select"
          onChange={(e) => setCurrency(e.target.value as Currency)}
        >
          {SUPPORTED_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      {/* P2.8 — owner-written salon description shown on the booking
          page hero. Optional. Replaces the generic "Curated nail
          artistry..." fallback when set. */}
      <label className={labelClass}>
        <span>Mô tả tiệm · Salon description</span>
        <span className="block text-xs font-normal text-nq-muted/85">
          Hiển thị trên trang đặt lịch dưới tên tiệm — tối đa 400 ký tự. Shown
          on the booking page below the salon name (optional, max 400 chars).
        </span>
        <textarea
          data-testid="setup-salon-description"
          className={cn(
            "mt-1.5 min-h-[88px] w-full resize-y border",
            inputRing,
            "border-nq-border/50",
          )}
          value={description}
          disabled={saveStatus === "saving"}
          maxLength={400}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ví dụ: Tiệm nail gia đình ấm cúng tại Vancouver — chuyên sơn gel, đắp acrylic và nail art."
        />
        <span className="mt-1 block text-right text-xs text-nq-muted/70">
          {description.length}/400
        </span>
      </label>

      <SaveButton
        status={saveStatus}
        onSave={() => {
          void save("manual");
        }}
        disabled={!canSave}
        className="min-h-[48px] w-full sm:w-full"
      />
      {autoSave ? (
        <p
          className="text-center text-xs leading-5 text-nq-muted"
          data-testid="guided-autosave-message"
          aria-live="polite"
        >
          {pageLang === "vi"
            ? "Các thay đổi hợp lệ sẽ tự lưu sau khi bạn dừng nhập. Nút Lưu vẫn sẵn sàng để bạn lưu ngay."
            : "Valid changes save automatically after you pause. The Save button remains available to save immediately."}
        </p>
      ) : null}
    </div>
  );
}
