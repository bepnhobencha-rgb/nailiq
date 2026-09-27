"use client";
import { useState } from "react";
import { SaveCardButton } from "@/components/receptionist/BookingDetailDrawer";
import { Button } from "@/components/ui/Button";
export function CardRetryEmailHarness() {
  const [language, setLanguage] = useState<"en" | "vi">("en");
  const [failure, setFailure] = useState(false);
  const [round, setRound] = useState(0);
  const [calls, setCalls] = useState<string[]>([]);
  return <main className="p-4 max-w-xl">
    <h1>QA synthetic — no network sending</h1>
    <Button onClick={() => { setLanguage(language === "en" ? "vi" : "en"); setRound(round + 1); }}>English / Tiếng Việt</Button>
    <Button onClick={() => { setFailure(!failure); setRound(round + 1); }}>Mode: {failure ? "failure" : "success"}</Button>
    <SaveCardButton key={round} slug="synthetic" bookingId="synthetic" language={language} sendLink={async (_slug, input) => {
      setCalls(previous => [...previous, input.channel ?? "legacy"]);
      await new Promise(resolve => setTimeout(resolve, 300));
      return failure ? { ok: false, error: "email_send_failed" } : { ok: true, url: "https://example.invalid", emailSent: input.channel === "email_only", smsSent: input.sendSms === true };
    }} />
    <p role="status">Mock calls: {calls.join(", ") || "none"}</p>
  </main>;
}
