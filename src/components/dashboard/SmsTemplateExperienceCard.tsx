"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import {
  getSmsTemplateSettings,
  saveSmsTemplateSettings,
} from "@/shared/dashboard/smsTemplateSettingsActions";
import {
  buildSmsTemplatePreview,
  estimateSmsSegments,
  SMS_TEMPLATE_DEFINITIONS,
  type SmsTemplateKey,
  type SmsTemplateSettings,
} from "@/shared/lib/smsTemplateRegistry";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

const DEFAULT_SELECTED: SmsTemplateKey = "booking_confirmation";

function withPreviewOptOut(body: string, vi: boolean): string {
  return `${body}\n${vi ? "Nhắn STOP để ngừng nhận tin." : "Reply STOP to opt out."}`;
}

export function SmsTemplateExperienceCard({ slug }: { slug: string }) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [selected, setSelected] = useState<SmsTemplateKey>(DEFAULT_SELECTED);
  const [settings, setSettings] = useState<SmsTemplateSettings>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, startSaving] = useTransition();
  const [notice, setNotice] = useState<"saved" | "error" | null>(null);

  useEffect(() => {
    let active = true;
    void getSmsTemplateSettings(slug).then((result) => {
      if (!active) return;
      if (result.ok) setSettings(result.settings);
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [slug]);

  const definition = SMS_TEMPLATE_DEFINITIONS.find(
    (item) => item.key === selected,
  ) ?? SMS_TEMPLATE_DEFINITIONS[0];
  const preview = withPreviewOptOut(
    buildSmsTemplatePreview(selected, vi ? "vi" : "en"),
    vi,
  );
  const estimate = estimateSmsSegments(preview);

  function save() {
    setNotice(null);
    startSaving(async () => {
      const result = await saveSmsTemplateSettings(slug, settings);
      if (result.ok) {
        setSettings(result.settings);
        setNotice("saved");
      } else {
        setNotice("error");
      }
    });
  }

  return (
    <section
      data-testid="sms-template-experience-card"
      className="rounded-xl border border-nq-border bg-nq-surface p-5"
    >
      <h2 className="text-base font-semibold text-nq-foreground">
        {vi ? "Mẫu SMS thống nhất" : "Unified SMS templates"}
      </h2>
      <p className="mt-1 text-sm text-nq-muted">
        {vi
          ? "Xem trước đúng ngôn ngữ, độ dài và trạng thái từng loại tin. Nội dung bắt buộc được khóa để khách luôn có biên nhận."
          : "Preview language, length, and status for every message. Required receipts stay locked so customers are never left without confirmation."}
      </p>

      {!loaded ? (
        <p className="mt-4 text-sm text-nq-muted">
          {vi ? "Đang tải…" : "Loading…"}
        </p>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-2" role="radiogroup" aria-label={vi ? "Loại SMS" : "SMS type"}>
            {SMS_TEMPLATE_DEFINITIONS.map((item) => {
              const enabled = item.required || settings[item.key] !== false;
              const inputId = `sms-template-${item.key}`;
              return (
                <div
                  key={item.key}
                  className="flex min-h-11 items-center gap-3 rounded-lg border border-nq-border/60 bg-nq-surface-2 p-3"
                >
                  <input
                    id={inputId}
                    type="radio"
                    name="sms-template-preview"
                    checked={selected === item.key}
                    onChange={() => setSelected(item.key)}
                    className="size-5 accent-nq-primary"
                  />
                  <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block text-sm font-medium text-nq-foreground">
                      {vi ? item.labelVi : item.labelEn}
                    </span>
                    <span className="block text-xs text-nq-muted">
                      {item.required
                        ? vi ? "Bắt buộc · luôn bật" : "Required · always on"
                        : enabled
                          ? vi ? "Đang bật" : "Enabled"
                          : vi ? "Đang tắt" : "Disabled"}
                    </span>
                  </label>
                  {item.required ? (
                    <span className="text-xs font-semibold text-nq-muted">
                      {vi ? "Khóa" : "Locked"}
                    </span>
                  ) : (
                    <Toggle
                      checked={enabled}
                      disabled={saving}
                      aria-label={`${vi ? item.labelVi : item.labelEn}: ${enabled ? "on" : "off"}`}
                      onChange={(checked) => {
                        setSettings((current) => ({ ...current, [item.key]: checked }));
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className="rounded-lg border border-nq-border/60 bg-nq-bg p-4">
            <p className="text-sm font-semibold text-nq-foreground">
              {vi ? definition.labelVi : definition.labelEn}
            </p>
            <p className="mt-1 text-xs text-nq-muted">
              {vi ? definition.descriptionVi : definition.descriptionEn}
            </p>
            <pre className="mt-4 whitespace-pre-wrap break-words rounded-lg bg-nq-surface-2 p-4 font-sans text-sm leading-relaxed text-nq-foreground">
              {preview}
            </pre>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-nq-muted">
              <span>{estimate.encoding}</span>
              <span aria-hidden>·</span>
              <span>
                {vi
                  ? `${estimate.units} ký tự · ${estimate.segments} đoạn SMS`
                  : `${estimate.units} units · ${estimate.segments} SMS segment${estimate.segments === 1 ? "" : "s"}`}
              </span>
            </div>
            {estimate.segments > 3 ? (
              <p className="mt-2 text-xs text-nq-warning" role="status">
                {vi
                  ? "Mẫu này dài hơn mục tiêu 3 đoạn; cần rút gọn trước khi rollout."
                  : "This exceeds the 3-segment target and should be shortened before rollout."}
              </p>
            ) : null}
          </div>
        </div>
      )}

      {loaded ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={save} loading={saving} disabled={saving}>
            {vi ? "Lưu cài đặt mẫu" : "Save template settings"}
          </Button>
          {notice ? (
            <p
              role={notice === "error" ? "alert" : "status"}
              className={notice === "error" ? "text-sm text-nq-error" : "text-sm text-nq-success"}
            >
              {notice === "saved"
                ? vi ? "Đã lưu." : "Saved."
                : vi ? "Không lưu được. Vui lòng thử lại." : "Could not save. Please try again."}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
