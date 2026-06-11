"use client";

import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getUserMessages } from "@/shared/i18n/user";
import {
  DEFAULT_OWNER_NOTIFICATION_SETTINGS,
  OWNER_NOTIFICATION_EVENTS,
  type OwnerNotificationEvent,
  type OwnerNotificationSettings,
} from "@/shared/dashboard/ownerNotificationSettings";
import {
  getOwnerNotificationSettings,
  saveOwnerNotificationSettings,
  sendOwnerNotificationTestAction,
} from "@/shared/dashboard/ownerNotificationActions";

/**
 * Admin Settings card — owner/admin email alerts for booking events.
 * Self-contained: loads its own settings, saves, and sends a test email.
 */
export function OwnerNotificationCard({ slug }: { slug: string }) {
  const { language } = useUserLanguage();
  const t = getUserMessages(language).salonSettings.ownerNotifications;

  const [settings, setSettings] = useState<OwnerNotificationSettings>(
    DEFAULT_OWNER_NOTIFICATION_SETTINGS,
  );
  const [emailsText, setEmailsText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    void getOwnerNotificationSettings(slug).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setSettings(r.settings);
        setEmailsText(r.settings.customEmails.join(", "));
      }
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [slug]);

  function patch(p: Partial<OwnerNotificationSettings>) {
    setSettings((s) => ({ ...s, ...p }));
  }
  function patchEvent(ev: OwnerNotificationEvent, on: boolean) {
    setSettings((s) => ({ ...s, events: { ...s.events, [ev]: on } }));
  }

  function onSave() {
    setToast(null);
    startSave(async () => {
      const payload = { ...settings, customEmails: emailsText };
      const r = await saveOwnerNotificationSettings(slug, payload);
      if (r.ok) {
        setSettings(r.settings);
        setEmailsText(r.settings.customEmails.join(", "));
        setToast({ kind: "ok", msg: t.saved });
      } else {
        setToast({ kind: "err", msg: t.saveError });
      }
    });
  }

  function onTest() {
    setToast(null);
    startTest(async () => {
      const r = await sendOwnerNotificationTestAction(slug);
      if (r.ok) {
        setToast({ kind: "ok", msg: t.testSent.replace("{n}", String(r.recipientCount)) });
      } else {
        const map: Record<string, string> = {
          not_enabled: t.testErrorNotEnabled,
          no_recipients: t.testErrorNoRecipients,
          no_resend: t.testErrorNoResend,
        };
        setToast({ kind: "err", msg: map[r.error] ?? t.testErrorGeneric });
      }
    });
  }

  return (
    <section
      data-testid="owner-notifications-card"
      className="rounded-xl border border-nq-border bg-nq-surface p-5"
    >
      <h2 className="text-base font-semibold text-nq-foreground">{t.title}</h2>
      <p className="mt-1 text-sm text-nq-muted">{t.subtitle}</p>

      {!loaded ? (
        <p className="mt-4 text-sm italic text-nq-muted">{t.loading}</p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {/* Master toggle */}
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              data-testid="owner-notif-enabled"
              checked={settings.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
              className="size-4 accent-nq-primary"
            />
            <span className="text-sm font-medium text-nq-foreground">
              {t.enabledLabel}
            </span>
          </label>

          {settings.enabled ? (
            <>
              {/* Recipients */}
              <div className="flex flex-col gap-2 border-t border-nq-border/40 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
                  {t.recipientsHeading}
                </p>
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    data-testid="owner-notif-members"
                    checked={settings.notifyMembers}
                    onChange={(e) => patch({ notifyMembers: e.target.checked })}
                    className="size-4 accent-nq-primary"
                  />
                  <span className="text-sm text-nq-foreground">
                    {t.notifyMembersLabel}
                  </span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-nq-foreground">
                    {t.customEmailsLabel}
                  </span>
                  <input
                    type="text"
                    data-testid="owner-notif-emails"
                    value={emailsText}
                    onChange={(e) => setEmailsText(e.target.value)}
                    placeholder={t.customEmailsPlaceholder}
                    className="rounded-lg border border-nq-border bg-nq-bg px-3 py-2 text-sm text-nq-foreground"
                  />
                  <span className="text-xs text-nq-muted">{t.customEmailsHint}</span>
                </label>
              </div>

              {/* Events */}
              <div className="flex flex-col gap-2 border-t border-nq-border/40 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
                  {t.eventsHeading}
                </p>
                {OWNER_NOTIFICATION_EVENTS.map((ev) => (
                  <label key={ev} className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      data-testid={`owner-notif-event-${ev}`}
                      checked={settings.events[ev]}
                      onChange={(e) => patchEvent(ev, e.target.checked)}
                      className="size-4 accent-nq-primary"
                    />
                    <span className="text-sm text-nq-foreground">
                      {t.eventLabels[ev]}
                    </span>
                  </label>
                ))}
              </div>
            </>
          ) : null}

          {toast ? (
            <p
              data-testid="owner-notif-toast"
              className={
                toast.kind === "ok"
                  ? "text-sm text-nq-success"
                  : "text-sm text-nq-error"
              }
              role="status"
            >
              {toast.msg}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={onSave} loading={saving} disabled={saving}>
              {t.save}
            </Button>
            {settings.enabled ? (
              <Button
                variant="secondary"
                onClick={onTest}
                loading={testing}
                disabled={testing}
              >
                {t.sendTest}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
