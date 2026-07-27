"use client";

import { useState } from "react";

/**
 * Owner-facing setup panel for the phone + SMS AI receptionist (Module 3/4).
 *
 * The brain is the SAME agent as the web voice widget — the only extra wiring an
 * owner needs is to point their number's Voice AND Messaging webhooks at us. We
 * do not store the Twilio number (the webhooks carry `?slug=`), so this panel is
 * instructional + shows live usage rather than a stored-number field.
 *
 * The webhook URLs MUST be built from the same base the inbound routes validate
 * Twilio's signature against (NEXT_PUBLIC_APP_URL) — otherwise a copied URL
 * would fail signature verification. The page passes them in already-resolved.
 */
type Props = {
  webhookUrl: string;
  smsWebhookUrl: string;
  enabled: boolean;
  sessionsUsed: number;
  sessionsLimit: number;
  resetAt: string | null;
};

export function formatVoiceUsageResetDate(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const resetDate = new Date(resetAt);
  if (Number.isNaN(resetDate.getTime())) return null;

  // Server rendering runs in UTC while salon browsers can be in any timezone.
  // Pin both locale and timezone so the server and first client render agree.
  return resetDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function CopyableUrl({ id, label, value }: { id: string; label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  }
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-semibold" htmlFor={id}>
        {label}
      </label>
      <div className="flex items-stretch gap-2">
        <input
          id={id}
          type="text"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full select-all rounded-xl border border-[var(--color-border)] bg-transparent px-4 py-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
        />
        <button
          type="button"
          onClick={copy}
          className="flex-shrink-0 rounded-xl border border-[var(--color-border)] px-4 text-sm font-semibold hover:bg-[var(--color-surface-hover,rgba(0,0,0,0.03))] transition-colors"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export function VoicePhoneSetup({ webhookUrl, smsWebhookUrl, enabled, sessionsUsed, sessionsLimit, resetAt }: Props) {
  const pct = sessionsLimit > 0 ? Math.min(100, Math.round((sessionsUsed / sessionsLimit) * 100)) : 0;
  const resetLabel = formatVoiceUsageResetDate(resetAt);

  return (
    <section className="mt-10 space-y-5 border-t border-[var(--color-border)] pt-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Phone receptionist</h2>
          <p className="text-sm text-[var(--color-text-muted)]">
            Let the same AI answer your phone calls. It verifies the caller before
            changing or booking anything.
          </p>
        </div>
        <span
          className={[
            "flex-shrink-0 rounded-full px-3 py-1 text-xs font-semibold",
            enabled ? "bg-green-100 text-green-700" : "bg-zinc-100 text-zinc-500",
          ].join(" ")}
        >
          {enabled ? "AI on" : "AI off"}
        </span>
      </div>

      {!enabled && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
          Turn on <span className="font-semibold">Enable Voice AI</span> above and save
          first — the phone line stays silent until Voice AI is on.
        </p>
      )}

      {/* Webhook URLs to paste into Twilio */}
      <CopyableUrl id="voice-webhook" label="Voice webhook URL (phone calls)" value={webhookUrl} />
      <CopyableUrl id="sms-webhook" label="Messaging webhook URL (text messages)" value={smsWebhookUrl} />

      {/* Setup steps */}
      <ol className="space-y-2 rounded-2xl border border-[var(--color-border)] p-4 text-sm">
        <li className="flex gap-2">
          <span className="font-semibold text-[var(--color-primary)]">1.</span>
          <span>
            In your phone provider (Twilio), open the number you want customers to
            call or text.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="font-semibold text-[var(--color-primary)]">2.</span>
          <span>
            Under <span className="font-semibold">Voice &amp; Fax → A Call Comes In</span>,
            paste the <span className="font-semibold">Voice</span> URL. Under{" "}
            <span className="font-semibold">Messaging → A Message Comes In</span>, paste
            the <span className="font-semibold">Messaging</span> URL. Set both to{" "}
            <span className="font-semibold">Webhook / HTTP POST</span>.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="font-semibold text-[var(--color-primary)]">3.</span>
          <span>Save, then call or text that number — the AI should answer.</span>
        </li>
      </ol>
      <p className="text-xs text-[var(--color-text-muted)]">
        Not sure how? Send this page to NailIQ support and we&apos;ll connect your
        number for you.
      </p>

      {/* Monthly usage */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold">Calls this month</span>
          <span className="text-[var(--color-text-muted)]">
            {sessionsUsed} / {sessionsLimit}
            {resetLabel ? ` · resets ${resetLabel}` : ""}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200">
          <div
            className={[
              "h-full rounded-full transition-all",
              pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-[var(--color-primary)]",
            ].join(" ")}
            style={{ width: `${pct}%` }}
          />
        </div>
        {pct >= 100 && (
          <p className="text-xs text-red-600">
            Monthly limit reached — the AI will stop answering until it resets. Contact
            NailIQ to raise the limit.
          </p>
        )}
      </div>
    </section>
  );
}
