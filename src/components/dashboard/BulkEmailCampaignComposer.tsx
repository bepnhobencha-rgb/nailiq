"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { CheckCircle2, Eye, MailPlus, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import {
  approveBulkEmailCampaignAction,
  createBulkEmailCampaignAction,
  prepareBulkEmailCampaignAction,
} from "@/app/dashboard/[slug]/marketing/actions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Campaign = {
  id: string;
  name: string;
  subject: string;
  status: "draft" | "prepared" | "approved" | "sending" | "completed" | "cancelled";
  audienceCount: number;
  excludedNoConsent: number;
  excludedInvalidEmail: number;
  excludedOptout: number;
  excludedProviderSuppression: number;
  excludedDuplicate: number;
  createdAt: string;
};

const inputClass = "mt-1.5 min-h-11 w-full rounded-xl border border-nq-border bg-nq-bg/40 px-3 py-2.5 text-sm text-nq-foreground outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/60";

export function BulkEmailCampaignComposer({
  slug,
  salonName,
  available,
  campaigns,
}: {
  slug: string;
  salonName: string;
  available: boolean;
  campaigns: Campaign[];
}) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const t = (en: string, viText: string) => (vi ? viText : en);
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [form, setForm] = useState({
    name: "",
    subject: "",
    preheader: "",
    headline: "",
    body: "",
    imageUrl: "",
    ctaLabel: t("Book now", "Đặt lịch ngay"),
    ctaUrl: `https://nailiq.ca/${slug}`,
    canarySize: 25,
    batchSize: 100,
    sendAfter: "",
  });

  const latest = campaigns.slice(0, 6);

  function update(key: keyof typeof form, value: string | number) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function createDraft() {
    setBusyId("create");
    const result = await createBulkEmailCampaignAction(slug, form);
    setBusyId(null);
    if (!result.ok) {
      setToast({
        variant: "error",
        message: result.code === "invalid_input"
          ? t("Please check every required field and HTTPS link.", "Kiểm tra các mục bắt buộc và đường dẫn HTTPS.")
          : t("The draft could not be saved.", "Chưa thể lưu bản nháp."),
      });
      return;
    }
    setToast({ variant: "success", message: t("Draft saved. Nothing was sent.", "Đã lưu bản nháp. Chưa gửi gì cả.") });
    setShowComposer(false);
    router.refresh();
  }

  async function prepare(campaignId: string) {
    setBusyId(campaignId);
    const result = await prepareBulkEmailCampaignAction(slug, campaignId);
    setBusyId(null);
    setToast(result.ok
      ? {
          variant: "success",
          message: t(
            `${result.audienceCount ?? 0} consented customers are ready. Nothing was sent.`,
            `${result.audienceCount ?? 0} khách đã đồng ý đang sẵn sàng. Chưa gửi gì cả.`,
          ),
        }
      : { variant: "error", message: t("Audience check failed safely.", "Kiểm tra người nhận đã dừng an toàn.") });
    if (result.ok) router.refresh();
  }

  async function approve(campaignId: string) {
    setBusyId(campaignId);
    const result = await approveBulkEmailCampaignAction(slug, campaignId);
    setBusyId(null);
    setToast(result.ok
      ? { variant: "success", message: t("Approved. Sending remains locked.", "Đã duyệt. Chức năng gửi vẫn đang khóa.") }
      : { variant: "error", message: t("Approval failed safely.", "Duyệt đã dừng an toàn.") });
    if (result.ok) router.refresh();
  }

  const statusLabel: Record<Campaign["status"], string> = {
    draft: t("Draft", "Bản nháp"),
    prepared: t("Audience ready", "Đã kiểm tra khách"),
    approved: t("Approved · sending locked", "Đã duyệt · đang khóa gửi"),
    sending: t("Sending", "Đang gửi"),
    completed: t("Completed", "Hoàn tất"),
    cancelled: t("Cancelled", "Đã huỷ"),
  };

  return (
    <section className="mb-6 rounded-2xl border border-nq-primary/35 bg-nq-surface p-5" aria-labelledby="bulk-email-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-nq-primary">NailIQ Campaign Studio</p>
          <h2 id="bulk-email-heading" className="mt-1 text-lg font-semibold text-nq-foreground">
            {t("Bulk email campaign", "Chiến dịch email hàng loạt")}
          </h2>
          <p className="mt-1 max-w-xl text-sm text-nq-muted">
            {t(
              "Write once. NailIQ selects only consented customers, removes opt-outs and duplicates, then shows the exact audience before approval.",
              "Soạn một lần. NailIQ chỉ chọn khách đã đồng ý, loại người từ chối và email trùng, rồi hiện đúng số người nhận trước khi duyệt.",
            )}
          </p>
        </div>
        <Button leftIcon={<MailPlus className="h-4 w-4" />} onClick={() => setShowComposer((value) => !value)} disabled={!available}>
          {showComposer ? t("Close", "Đóng") : t("Create campaign", "Tạo chiến dịch")}
        </Button>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {[
          ["1", t("Write & preview", "Soạn & xem trước")],
          ["2", t("Check consent", "Kiểm tra đồng ý")],
          ["3", t("Owner approves", "Chủ tiệm duyệt")],
        ].map(([step, label]) => (
          <div key={step} className="flex min-h-11 items-center gap-2 rounded-xl border border-nq-border/70 bg-nq-bg/30 px-3 text-sm text-nq-foreground">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-nq-primary/15 text-xs font-semibold text-nq-primary">{step}</span>
            {label}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-start gap-2 rounded-xl border border-nq-success/30 bg-nq-success/10 px-3 py-2.5 text-sm text-nq-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-nq-success" aria-hidden />
        <span>{t("Safe preview: no provider call and no customer email can be sent from this screen.", "Preview an toàn: màn hình này không gọi nhà cung cấp và không thể gửi email cho khách.")}</span>
      </div>

      {!available ? (
        <p role="status" className="mt-4 rounded-xl border border-nq-warning/30 bg-nq-warning/10 px-3 py-3 text-sm text-nq-foreground">
          {t("Campaign database foundation is not installed in this environment yet.", "Nền dữ liệu chiến dịch chưa được cài trong môi trường này.")}
        </p>
      ) : null}

      {showComposer && available ? (
        <div className="mt-5 grid gap-5 border-t border-nq-border/60 pt-5 lg:grid-cols-[1.1fr_.9fr]">
          <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void createDraft(); }}>
            <label className="text-sm text-nq-muted">{t("Internal campaign name", "Tên chiến dịch nội bộ")}
              <input className={inputClass} required maxLength={80} value={form.name} onChange={(event) => update("name", event.target.value)} />
            </label>
            <label className="text-sm text-nq-muted">{t("Email subject", "Tiêu đề email")}
              <input className={inputClass} required maxLength={150} value={form.subject} onChange={(event) => update("subject", event.target.value)} />
            </label>
            <label className="text-sm text-nq-muted">{t("Inbox preview line", "Dòng xem trước trong hộp thư")}
              <input className={inputClass} maxLength={180} value={form.preheader} onChange={(event) => update("preheader", event.target.value)} />
            </label>
            <label className="text-sm text-nq-muted">{t("Main headline", "Tiêu đề chính")}
              <input className={inputClass} required maxLength={120} value={form.headline} onChange={(event) => update("headline", event.target.value)} />
            </label>
            <label className="text-sm text-nq-muted">{t("Message", "Nội dung")}
              <textarea className={`${inputClass} min-h-32 resize-y`} required maxLength={4000} value={form.body} onChange={(event) => update("body", event.target.value)} />
            </label>
            <label className="text-sm text-nq-muted">{t("Image HTTPS URL (optional)", "Link ảnh HTTPS (không bắt buộc)")}
              <input className={inputClass} inputMode="url" placeholder="https://…" value={form.imageUrl} onChange={(event) => update("imageUrl", event.target.value)} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm text-nq-muted">{t("Button text", "Chữ trên nút")}
                <input className={inputClass} required maxLength={60} value={form.ctaLabel} onChange={(event) => update("ctaLabel", event.target.value)} />
              </label>
              <label className="text-sm text-nq-muted">{t("Button HTTPS link", "Link HTTPS của nút")}
                <input className={inputClass} required inputMode="url" value={form.ctaUrl} onChange={(event) => update("ctaUrl", event.target.value)} />
              </label>
            </div>
            <Button type="submit" loading={busyId === "create"} leftIcon={<CheckCircle2 className="h-4 w-4" />}>
              {t("Save safe draft", "Lưu bản nháp an toàn")}
            </Button>
          </form>

          <div aria-label={t("Email preview", "Xem trước email")} className="self-start overflow-hidden rounded-2xl border border-nq-border bg-white text-neutral-900">
            <div className="flex items-center gap-2 bg-neutral-950 px-5 py-4 text-white">
              <Eye className="h-4 w-4 text-amber-400" aria-hidden />
              <span className="text-sm font-semibold">{t("Live preview", "Xem trước trực tiếp")}</span>
            </div>
            {form.imageUrl.startsWith("https://") ? (
              <Image
                src={form.imageUrl}
                alt=""
                width={600}
                height={320}
                unoptimized
                className="max-h-64 w-full object-cover"
              />
            ) : null}
            <div className="p-5">
              <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">{salonName}</p>
              <h3 className="mt-2 text-2xl font-bold">{form.headline || t("Your headline", "Tiêu đề của bạn")}</h3>
              <p className="mt-3 whitespace-pre-line text-sm leading-6 text-neutral-700">{form.body || t("Your customer message appears here.", "Nội dung gửi khách sẽ hiện ở đây.")}</p>
              <span className="mt-5 inline-flex min-h-11 items-center rounded-full bg-amber-400 px-5 text-sm font-semibold text-neutral-950">{form.ctaLabel}</span>
              <p className="mt-5 border-t border-neutral-200 pt-3 text-xs text-neutral-500">{t("Salon identity, address and one-click unsubscribe are added automatically.", "Tên tiệm, địa chỉ và nút ngừng nhận được thêm tự động.")}</p>
            </div>
          </div>
        </div>
      ) : null}

      {latest.length > 0 ? (
        <div className="mt-5 border-t border-nq-border/60 pt-4">
          <h3 className="text-sm font-semibold text-nq-foreground">{t("Recent campaigns", "Chiến dịch gần đây")}</h3>
          <ul className="mt-2 grid gap-2">
            {latest.map((campaign) => (
              <li key={campaign.id} className="rounded-xl border border-nq-border/70 bg-nq-bg/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-nq-foreground">{campaign.name}</p>
                    <p className="truncate text-xs text-nq-muted">{campaign.subject}</p>
                  </div>
                  <span className="rounded-full bg-nq-surface px-2.5 py-1 text-xs text-nq-muted">{statusLabel[campaign.status]}</span>
                </div>
                {campaign.status !== "draft" ? (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-nq-muted">
                    <Users className="h-3.5 w-3.5" aria-hidden />
                    {t(`${campaign.audienceCount} consented`, `${campaign.audienceCount} đã đồng ý`)} · {t(`${campaign.excludedNoConsent + campaign.excludedOptout + campaign.excludedProviderSuppression + campaign.excludedInvalidEmail + campaign.excludedDuplicate} excluded safely`, `${campaign.excludedNoConsent + campaign.excludedOptout + campaign.excludedProviderSuppression + campaign.excludedInvalidEmail + campaign.excludedDuplicate} đã loại an toàn`)}
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {campaign.status === "draft" ? <Button size="sm" variant="secondary" loading={busyId === campaign.id} onClick={() => void prepare(campaign.id)}>{t("Check audience", "Kiểm tra khách")}</Button> : null}
                  {campaign.status === "prepared" ? <Button size="sm" loading={busyId === campaign.id} onClick={() => void approve(campaign.id)}>{t("Approve", "Duyệt")}</Button> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <SetupToast toast={toast} onDismiss={() => setToast(null)} autoDismissMs={5000} />
    </section>
  );
}
