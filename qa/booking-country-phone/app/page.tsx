"use client";
import { useState, type CSSProperties } from "react";
import CountryPhoneField from "@/components/booking/CountryPhoneField";
import { buildBookingThemeVars } from "@/shared/booking/bookingThemeVars";

function Sample({ mode, language }: { mode: "light" | "dark"; language: "en" | "vi" }) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const id = `${mode}-${language}`;
  return <section aria-label={id} className="p-4" style={{ ...buildBookingThemeVars("#D4AF37", mode), background: "var(--booking-bg)", color: "var(--booking-text)" } as CSSProperties}>
    <label htmlFor={id}>{language === "vi" ? "Số điện thoại" : "Phone number"}</label>
    <CountryPhoneField id={id} testId={id} value={value} onChange={setValue} salonTimezone="America/Vancouver" language={language} invalid={invalid} describedBy={`${id}-error`} />
    <output data-testid={`${id}-value`}>{value}</output>
    <label><input type="checkbox" data-testid={`${id}-invalid`} checked={invalid} onChange={event => setInvalid(event.target.checked)} /> Show validation error</label>
    {invalid && <p id={`${id}-error`}>Invalid phone number</p>}
  </section>;
}
export default function Page() {
  return <main>{(["light", "dark"] as const).flatMap(mode => (["en", "vi"] as const).map(language => <Sample key={`${mode}-${language}`} mode={mode} language={language} />))}</main>;
}
