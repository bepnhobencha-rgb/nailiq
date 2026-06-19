"use client";

import { useMemo, useState } from "react";
import {
  PHONE_COUNTRIES,
  countryByIso,
  defaultPhoneCountry,
  neighborCluster,
  toE164Input,
  type PhoneCountry,
} from "@/shared/booking/phoneCountries";

type Props = {
  /** Source-of-truth phone string in `+<dial><national>` form (validated upstream
   *  by `validateGuestPhone`). Empty string when nothing entered yet. */
  value: string;
  /** Emits the full `+<dial><national>` string (or "" when national is empty). */
  onChange: (fullE164: string) => void;
  /** Salon timezone → used to pick the default country on first render. */
  salonTimezone?: string | null;
  language?: "en" | "vi";
  id?: string;
  testId?: string;
  inputClassName?: string;
  autoComplete?: string;
};

/** Pick the country whose dial code is the longest prefix of the E.164 digits.
 *  For shared codes (+1 US/CA) prefer `preferred` when it also matches. */
function detectCountry(value: string, preferred: PhoneCountry): {
  country: PhoneCountry;
  national: string;
} | null {
  const v = value.trim();
  if (!v.startsWith("+")) return null;
  const digits = v.slice(1).replace(/\D/g, "");
  if (!digits) return null;
  const matches = PHONE_COUNTRIES.filter((c) => digits.startsWith(c.dial)).sort(
    (a, b) => b.dial.length - a.dial.length,
  );
  if (matches.length === 0) return null;
  const top = matches[0];
  const country =
    top.dial === preferred.dial && matches.some((m) => m.iso === preferred.iso)
      ? preferred
      : top;
  return { country, national: digits.slice(country.dial.length) };
}

export default function CountryPhoneField({
  value,
  onChange,
  salonTimezone,
  language = "en",
  id = "country-phone",
  testId = "country-phone",
  autoComplete = "tel",
}: Props) {
  const fallback = useMemo(
    () => defaultPhoneCountry(salonTimezone),
    [salonTimezone],
  );
  // The salon's regional cluster (salon country + daily-crossing neighbours).
  const cluster = useMemo(() => neighborCluster(fallback.iso), [fallback.iso]);
  const detected = useMemo(() => detectCountry(value, fallback), [value, fallback]);

  const initialIso = detected?.country.iso ?? fallback.iso;
  const [iso, setIso] = useState<string>(initialIso);
  // National digits the user typed (display value of the text input).
  const [national, setNational] = useState<string>(detected?.national ?? "");
  // Expand to the full worldwide list when the customer picks "Other", or when
  // a prefilled number is from a country outside the salon's cluster.
  const [showAll, setShowAll] = useState<boolean>(
    !cluster.some((c) => c.iso === initialIso),
  );

  const country = countryByIso(iso) ?? fallback;
  const label = (c: PhoneCountry) => (language === "vi" ? c.nameVi : c.name);

  function emit(nextCountry: PhoneCountry, nextNational: string) {
    onChange(toE164Input(nextCountry, nextNational));
  }

  function onCountryChange(nextIso: string) {
    if (nextIso === "__other__") {
      setShowAll(true);
      return;
    }
    if (nextIso === "__cluster__") {
      setShowAll(false);
      if (!cluster.some((c) => c.iso === iso)) {
        setIso(fallback.iso);
        emit(fallback, national);
      }
      return;
    }
    setIso(nextIso);
    const c = countryByIso(nextIso) ?? fallback;
    emit(c, national);
  }

  function onNationalChange(raw: string) {
    // Keep digits + common separators so the cursor doesn't fight the user;
    // toE164Input strips to digits for the stored value.
    const cleaned = raw.replace(/[^\d\s()\-.]/g, "");
    setNational(cleaned);
    emit(country, cleaned);
  }

  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "stretch" }}>
      <select
        aria-label={language === "vi" ? "Chọn quốc gia" : "Select country"}
        data-testid={`${testId}-country`}
        value={iso}
        onChange={(e) => onCountryChange(e.target.value)}
        className="nq-booking-field"
        style={{ width: showAll ? "150px" : "78px", flexShrink: 0 }}
      >
        {showAll ? (
          <>
            <option value="__cluster__">
              {language === "vi" ? "‹ Khu vực gần" : "‹ Nearby"}
            </option>
            {PHONE_COUNTRIES.map((c) => (
              <option key={c.iso} value={c.iso} title={label(c)}>
                {c.iso}  {label(c)}
              </option>
            ))}
          </>
        ) : (
          <>
            {cluster.map((c) => (
              <option key={c.iso} value={c.iso} title={label(c)}>
                {c.iso}
              </option>
            ))}
            <option value="__other__">
              {language === "vi" ? "Khác…" : "Other…"}
            </option>
          </>
        )}
      </select>

      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: "6px",
          minWidth: 0,
        }}
        className="nq-booking-field"
      >
        <span
          aria-hidden="true"
          style={{ flexShrink: 0, opacity: 0.7, whiteSpace: "nowrap" }}
        >
          +{country.dial}
        </span>
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete={autoComplete}
          data-testid={testId}
          value={national}
          placeholder={language === "vi" ? "Số điện thoại" : "Phone number"}
          maxLength={20}
          onChange={(e) => onNationalChange(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            padding: 0,
            font: "inherit",
            color: "inherit",
          }}
        />
      </div>
    </div>
  );
}
