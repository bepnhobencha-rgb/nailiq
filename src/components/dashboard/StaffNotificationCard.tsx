"use client";

import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getUserMessages } from "@/shared/i18n/user";
import {
  DEFAULT_STAFF_NOTIFICATION_SETTINGS,
  type StaffNotificationSettings,
} from "@/shared/dashboard/staffNotificationSettings";
import {
  getStaffNotificationSettings,
  saveStaffNotificationSettings,
} from "@/shared/dashboard/staffNotificationActions";

/** Events that actually send a customer notification (no_show is owner-only). */
const SHOWN_EVENTS = ["create", "reschedule", "cancel"] as const;

/**
 * Admin Settings card — per-salon defaults for the "notify the customer?" step
 * on staff create / reschedule / cancel. Self-contained: loads, edits, saves.
 */
export function StaffNotificationCard({
  slug,
  smsOutboundEnabled,
  emailOutboundEnabled,
}: {
  slug: string;
  smsOutboundEnabled: boolean;
  emailOutboundEnabled: boolean;
}) {
  const { language } = useUserLanguage();
  const t = getUserMessages(language).salonSettings.staffNotifications;

  const [settings, setSettings] = useState<StaffNotificationSettings>(
    DEFAULT_STAFF_NOTIFICATION_SETTINGS,
  );
  const [loaded, setLoaded] = useState(false);
  const [saving, startSave] = useTransition();
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    void getStaffNotificationSettings(slug).then((r) => {
      if (!alive) return;
      if (r.ok) setSettings(r.settings);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [slug]);

  function onSave() {
    setToast(null);
    const sanitizedSettings: StaffNotificationSettings = {
      ...settings,
      channels: {
        sms: smsOutboundEnabled && settings.channels.sms,
        email: emailOutboundEnabled && settings.channels.email,
      },
    };
    startSave(async () => {
      const r = await saveStaffNotificationSettings(slug, sanitizedSettings);
      if (r.ok) {
        setSettings(r.settings);
        setToast({ kind: "ok", msg: t.saved });
      } else {
        setToast({ kind: "err", msg: t.saveError });
      }
    });
  }

  return (
    <section
      data-testid="staff-notifications-card"
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
              data-testid="staff-notif-enabled"
              checked={settings.enabled}
              onChange={(e) =>
                setSettings((s) => ({ ...s, enabled: e.target.checked }))
              }
              className="size-4 accent-nq-primary"
            />
            <span className="text-sm font-medium text-nq-foreground">
              {t.enabledLabel}
            </span>
          </label>

          {settings.enabled ? (
            <>
              {/* Channels offered */}
              <div className="flex flex-col gap-2 border-t border-nq-border/40 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
                  {t.channelsHeading}
                </p>
                {(["sms", "email"] as const).map((ch) => {
                  const available =
                    ch === "sms" ? smsOutboundEnabled : emailOutboundEnabled;
                  return (
                  <label
                    key={ch}
                    className={`flex items-center gap-3 ${
                      available ? "cursor-pointer" : "cursor-not-allowed opacity-60"
                    }`}
                  >
                    <input
                      type="checkbox"
                      data-testid={`staff-notif-channel-${ch}`}
                      checked={available && settings.channels[ch]}
                      disabled={!available}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          channels: { ...s.channels, [ch]: e.target.checked },
                        }))
                      }
                      className="size-4 accent-nq-primary"
                    />
                    <span className="text-sm text-nq-foreground">
                      {ch === "sms" ? t.smsLabel : t.emailLabel}
                      {!available
                        ? language === "vi"
                          ? " · đang tắt ở Kênh liên lạc với khách"
                          : " · disabled in Customer communication"
                        : ""}
                    </span>
                  </label>
                  );
                })}
              </div>

              {/* Per-event defaults */}
              <div className="flex flex-col gap-2 border-t border-nq-border/40 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
                  {t.eventsHeading}
                </p>
                {SHOWN_EVENTS.map((ev) => (
                  <label key={ev} className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      data-testid={`staff-notif-event-${ev}`}
                      checked={settings.eventDefaults[ev]}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          eventDefaults: {
                            ...s.eventDefaults,
                            [ev]: e.target.checked,
                          },
                        }))
                      }
                      className="size-4 accent-nq-primary"
                    />
                    <span className="text-sm text-nq-foreground">
                      {t.eventLabels[ev]}
                    </span>
                  </label>
                ))}
                <span className="text-xs text-nq-muted">{t.eventsHint}</span>
              </div>

              {/* Default language */}
              <div className="flex flex-col gap-2 border-t border-nq-border/40 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
                  {t.languageHeading}
                </p>
                <div className="flex gap-4">
                  {(["en", "vi"] as const).map((lc) => (
                    <label key={lc} className="flex cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name="staff-notif-locale"
                        data-testid={`staff-notif-locale-${lc}`}
                        checked={settings.defaultLocale === lc}
                        onChange={() =>
                          setSettings((s) => ({ ...s, defaultLocale: lc }))
                        }
                        className="size-4 accent-nq-primary"
                      />
                      <span className="text-sm text-nq-foreground">
                        {lc === "en" ? t.langEn : t.langVi}
                      </span>
                    </label>
                  ))}
                </div>
                <span className="text-xs text-nq-muted">{t.languageHint}</span>
              </div>
            </>
          ) : null}

          {toast ? (
            <p
              data-testid="staff-notif-toast"
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

          <div>
            <Button onClick={onSave} loading={saving} disabled={saving}>
              {t.save}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
