"use client";

import { useId, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { formatPhoneInputProgressive } from "@/shared/lib/phoneFormat";

import type { QueueItem } from "./WalkinQueueSidebar";

const MOBILE_DRAWER_QUERY = "(max-width: 767px)";

function subscribeMobileDrawer(callback: () => void) {
  const query = window.matchMedia(MOBILE_DRAWER_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function mobileDrawerSnapshot() {
  return window.matchMedia(MOBILE_DRAWER_QUERY).matches;
}

function mobileDrawerServerSnapshot() {
  return false;
}

export type WalkinContactDrawerLabels = {
  title: string;
  stepOutTitle: string;
  description: string;
  stepOutDescription: string;
  close: string;
  phone: string;
  email: string;
  phonePlaceholder: string;
  emailPlaceholder: string;
  noContact: string;
  stepOutContactRequired: string;
  contactReady: string;
  smsConsentYes: string;
  smsConsentNo: string;
  consentTruth: string;
  invalidPhone: string;
  invalidEmail: string;
  save: string;
  saveAndHold: string;
  saving: string;
  call: string;
  copyPhone: string;
  copyEmail: string;
  copied: string;
  saveFailed: string;
};

export type WalkinContactDrawerProps = {
  item: QueueItem | null;
  mode: "details" | "step_out";
  onClose: () => void;
  onSave: (input: {
    bookingId: string;
    clientPhone: string | null;
    clientEmail: string | null;
    holdAfterSave: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  labels: WalkinContactDrawerLabels;
};

export function WalkinContactDrawer({
  item,
  mode,
  onClose,
  onSave,
  labels,
}: WalkinContactDrawerProps) {
  if (!item) return null;
  return (
    <WalkinContactDrawerContent
      key={`${item.id}:${mode}`}
      item={item}
      mode={mode}
      onClose={onClose}
      onSave={onSave}
      labels={labels}
    />
  );
}

function WalkinContactDrawerContent({
  item,
  mode,
  onClose,
  onSave,
  labels,
}: Omit<WalkinContactDrawerProps, "item"> & { item: QueueItem }) {
  const [phone, setPhone] = useState(() =>
    formatPhoneInputProgressive(item.client_phone ?? ""),
  );
  const [email, setEmail] = useState(() => item.client_email ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<"phone" | "email" | null>(null);
  const phoneId = useId();
  const emailId = useId();
  const isMobile = useSyncExternalStore(
    subscribeMobileDrawer,
    mobileDrawerSnapshot,
    mobileDrawerServerSnapshot,
  );

  const submit = async () => {
    if (saving) return;
    const phoneRaw = phone.trim();
    const emailRaw = email.trim().toLowerCase();
    if (phoneRaw && !validateGuestPhone(phoneRaw).ok) {
      setError(labels.invalidPhone);
      return;
    }
    if (emailRaw && !isValidEmailFormat(emailRaw)) {
      setError(labels.invalidEmail);
      return;
    }
    if (mode === "step_out" && !phoneRaw && !emailRaw) {
      setError(labels.stepOutContactRequired);
      return;
    }

    setSaving(true);
    setError(null);
    const result = await onSave({
      bookingId: item.id,
      clientPhone: phoneRaw || null,
      clientEmail: emailRaw || null,
      holdAfterSave: mode === "step_out",
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error || labels.saveFailed);
      return;
    }
    onClose();
  };

  const copy = async (kind: "phone" | "email", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setError(labels.saveFailed);
    }
  };

  const hasContact = Boolean(item.client_phone || item.client_email);

  return (
    <Drawer
      isOpen
      onClose={onClose}
      variant={isMobile ? "bottom" : "right"}
      size="sm"
      title={mode === "step_out" ? labels.stepOutTitle : labels.title}
      description={
        mode === "step_out" ? labels.stepOutDescription : labels.description
      }
      closeButtonLabel={labels.close}
      footer={
        <Button
          type="button"
          variant="primary"
          size="lg"
          loading={saving}
          disabled={saving}
          onClick={() => void submit()}
          className="w-full"
          data-testid="walkin-contact-save"
        >
          {saving
            ? labels.saving
            : mode === "step_out"
              ? labels.saveAndHold
              : labels.save}
        </Button>
      }
    >
      <div className="space-y-5" data-testid="walkin-contact-drawer">
          <section className="rounded-xl border border-nq-border bg-nq-bg/35 p-3">
            <p className="text-lg font-semibold text-nq-foreground">
              {item.client_name}
            </p>
            <p className="mt-1 text-sm text-nq-muted">{item.service_name}</p>
            <p
              className="mt-2 text-xs font-semibold text-nq-primary"
              data-testid="walkin-contact-readiness"
            >
              {hasContact ? labels.contactReady : labels.noContact}
            </p>
          </section>

          <div>
            <label htmlFor={phoneId} className="mb-1 block text-sm font-medium text-nq-foreground">
              {labels.phone}
            </label>
            <input
              id={phoneId}
              type="tel"
              value={phone}
              autoComplete="tel"
              onChange={(event) => {
                setPhone(formatPhoneInputProgressive(event.target.value));
                setError(null);
              }}
              placeholder={labels.phonePlaceholder}
              className="h-11 w-full rounded-lg border border-nq-border bg-nq-bg px-3 text-base text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/40"
              data-testid="walkin-contact-phone"
            />
            {item.client_phone ? (
              <div className="mt-2 flex gap-2">
                <a
                  href={`tel:${item.client_phone}`}
                  className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-nq-border px-3 text-sm font-semibold text-nq-foreground"
                >
                  {labels.call}
                </a>
                <button
                  type="button"
                  className="min-h-11 flex-1 rounded-lg border border-nq-border px-3 text-sm font-semibold text-nq-foreground"
                  onClick={() => void copy("phone", item.client_phone ?? "")}
                >
                  {copied === "phone" ? labels.copied : labels.copyPhone}
                </button>
              </div>
            ) : null}
          </div>

          <div>
            <label htmlFor={emailId} className="mb-1 block text-sm font-medium text-nq-foreground">
              {labels.email}
            </label>
            <input
              id={emailId}
              type="email"
              value={email}
              autoComplete="email"
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
              placeholder={labels.emailPlaceholder}
              className="h-11 w-full rounded-lg border border-nq-border bg-nq-bg px-3 text-base text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/40"
              data-testid="walkin-contact-email"
            />
            {item.client_email ? (
              <button
                type="button"
                className="mt-2 min-h-11 w-full rounded-lg border border-nq-border px-3 text-sm font-semibold text-nq-foreground"
                onClick={() => void copy("email", item.client_email ?? "")}
              >
                {copied === "email" ? labels.copied : labels.copyEmail}
              </button>
            ) : null}
          </div>

          <section className="rounded-xl border border-nq-info/35 bg-nq-info/10 p-3 text-sm text-nq-foreground">
            <p className="font-semibold">
              {item.sms_consent_at ? labels.smsConsentYes : labels.smsConsentNo}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-nq-muted">
              {labels.consentTruth}
            </p>
          </section>

          {error ? (
            <p role="alert" className="text-sm font-medium text-nq-error">
              {error}
            </p>
          ) : null}
      </div>
    </Drawer>
  );
}
