"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { acceptGroupReplacement, type loadGroupReplacementPreview } from "@/shared/booking/groupSlotRecoveryActions";
import { groupRecoveryPrice, groupRecoveryRequestId, groupRecoveryTime } from "@/shared/booking/groupRecoveryPresentation";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import { groupRecoveryMessages, groupRecoveryError, type GroupRecoveryLanguage } from "@/shared/i18n/booking/groupRecovery";

type Preview = Awaited<ReturnType<typeof loadGroupReplacementPreview>>;
type Props = { token: string; language: GroupRecoveryLanguage; preview: Preview };

export default function GroupReplacementAccept({ token, language, preview }: Props) {
  const t = groupRecoveryMessages(language);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [taken, setTaken] = useState(false);
  const [terminalError, setTerminalError] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const material = useRef<{ name: string; phone: string; consentAccepted: boolean } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || accepted) return;
    if (!material.current) {
      if (!isValidCustomerName(name)) { setError(t.invalidName); return; }
      if (!validateGuestPhone(phone).ok) { setError(t.invalidPhone); return; }
      if (!consent) { setError(t.consentRequired); return; }
      material.current = { name: name.trim(), phone: phone.trim(), consentAccepted: true };
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const requestId = await groupRecoveryRequestId(token, "accept");
      const result = await acceptGroupReplacement({ token, requestId, ...material.current });
      if (result.ok && result.state === "accepted") {
        setAccepted(true);
        setUncertain(false);
      } else if (!result.ok) {
        setError(groupRecoveryError(result.code, language));
        if (result.code === "already_accepted") {
          setTaken(true);
        } else if (["invalid_input", "different_guest_required"].includes(result.code)) {
          // These rejections precede mutation; the same request may correct its
          // material because the server has not persisted a success receipt.
          material.current = null;
          setUncertain(false);
        } else if (["request_expired", "slot_changed", "feature_disabled", "contact_salon"].includes(result.code)) {
          setTerminalError(true);
        } else {
          // Unknown result must keep the exact request/material for recovery.
          setUncertain(true);
        }
      }
    } catch {
      setUncertain(true);
      setError(t.error);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (!preview.ok) return <Card padding="lg"><h1 className="text-xl font-semibold">{t.title}</h1><p role="alert" className="mt-4 text-nq-muted">{groupRecoveryError(preview.code, language, "preview")}</p></Card>;
  if (accepted || taken || preview.state === "accepted") return (
    <Card padding="lg">
      <h1 className="text-2xl font-semibold text-nq-text" data-testid="replacement-accepted">{t.accepted}</h1>
      <p role="status" className="mt-4 text-nq-muted">{accepted ? t.acceptedBody : t.alreadyAcceptedBody}</p>
    </Card>
  );

  return (
    <Card padding="lg">
      <h1 className="text-2xl font-semibold text-nq-text">{t.title}</h1>
      <p className="mt-3 text-sm text-nq-muted">{t.intro}</p>
      <div className="mt-6 space-y-2 rounded-xl border border-nq-border p-4">
        <p className="font-semibold">{preview.salonName}</p>
        <p>{preview.serviceName}</p>
        <p className="text-sm">{groupRecoveryTime(preview.startTimeUtc, preview.timezone, language)} – {groupRecoveryTime(preview.endTimeUtc, preview.timezone, language)}</p>
        <p className="text-xs text-nq-muted">{t.salonTime}: {preview.timezone}</p>
        <p>{t.servicePrice}: <strong>{groupRecoveryPrice(preview.priceCents, preview.currency, language)}</strong></p>
        <p className="text-xs text-nq-muted">{t.expires}: {groupRecoveryTime(preview.expiresAt, preview.timezone, language)}</p>
      </div>
      {terminalError ? <p role="alert" className="mt-4 text-nq-error">{error}</p> : preview.requiresCard ? <p className="mt-4 text-nq-muted">{t.cardRequired}</p> : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block space-y-2"><span>{t.name}</span><Input name="name" autoComplete="name" maxLength={BOOKING_GUEST_NAME_MAX} value={name} disabled={busy || uncertain} onChange={event => setName(event.target.value)} required /></label>
          <label className="block space-y-2"><span>{t.phone}</span><Input name="phone" type="tel" autoComplete="tel" maxLength={30} value={phone} disabled={busy || uncertain} onChange={event => setPhone(event.target.value)} required /></label>
          <label className="flex min-h-12 items-center gap-3 text-sm"><input type="checkbox" checked={consent} disabled={busy || uncertain} onChange={event => setConsent(event.target.checked)} className="h-5 w-5 shrink-0 accent-nq-primary" /><span>{t.agreement}</span></label>
          <p className="text-sm text-nq-muted">{t.noCardTransfer}</p>
          {error && <p role="alert" className="text-sm text-nq-error">{error}</p>}
          <Button type="submit" size="lg" fullWidth loading={busy} disabled={!consent} data-testid="replacement-accept">{busy ? t.checking : uncertain ? t.retry : t.accept}</Button>
        </form>
      )}
    </Card>
  );
}
