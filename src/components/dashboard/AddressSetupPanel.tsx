"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { SaveButton, type SaveButtonStatus } from "@/components/ui/SaveButton";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { updateAddress } from "@/shared/dashboard/setupActions";
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
import { cn } from "@/shared/lib/cn";

const TOAST_ERR = "✗ Could not save. Check your connection.";
const ERR = {
  street: "Please enter street address",
  city: "Please enter city",
  province: "Please enter province or state",
  postal: "Please enter a valid postal or ZIP code",
  country: "Please select country",
  phone: "Please enter a valid phone number (8–15 digits)",
} as const;

type FieldKey =
  | "street"
  | "city"
  | "province"
  | "postal"
  | "country"
  | "phone";

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
}): boolean {
  return (
    validateStreet(parts.street) &&
    validateCity(parts.city) &&
    validateProvince(parts.province) &&
    isValidPostalCode(parts.postal) &&
    parts.country.trim().length > 0 &&
    isAllowedCountry(parts.country) &&
    isValidPhone(parts.salonPhone)
  );
}

export function AddressSetupPanel({
  slug,
  initialAddress,
  initialSalonPhone,
}: {
  slug: string;
  initialAddress: string;
  initialSalonPhone: string;
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

  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<FieldKey, string | undefined>>
  >({});
  const [saveStatus, setSaveStatus] = useState<SaveButtonStatus>("idle");
  const [saveBannerError, setSaveBannerError] = useState<string | null>(null);
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    setFieldErrors({});
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initialAddress, initialSalonPhone]);

  const setFieldError = useCallback((key: FieldKey, message: string | null) => {
    setFieldErrors((prev) => {
      if (message === null) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: message };
    });
  }, []);

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

  const canSave = formIsValid({
    street,
    city,
    province,
    postal,
    country,
    salonPhone,
  });

  const save = useCallback(async () => {
    setSaveBannerError(null);
    clearStatusTimer();
    setSaveStatus("saving");
    const res = await updateAddress(slug, {
      street,
      city,
      province,
      postal,
      country,
      salon_phone: salonPhone,
    });
    if (!res.ok) {
      setSaveStatus("error");
      setSaveBannerError(serverErrorMessage(res.error));
      setToast({ variant: "error", message: TOAST_ERR });
      statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
      return;
    }
    setSaveStatus("saved");
    setToast({ variant: "success", message: "✓ Address saved" });
    statusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
    router.refresh();
  }, [
    city,
    clearStatusTimer,
    country,
    postal,
    province,
    router,
    salonPhone,
    slug,
    street,
  ]);

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
        <span>Street address</span>
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
        <span>City</span>
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
        <span>Province / state</span>
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
        <span>Postal code / ZIP</span>
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
        <span>Country</span>
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

      <label className={labelClass}>
        <span>Salon phone</span>
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

      <SaveButton
        status={saveStatus}
        onSave={() => {
          void save();
        }}
        disabled={!canSave}
        className="min-h-[48px] w-full sm:w-full"
      />
    </div>
  );
}
