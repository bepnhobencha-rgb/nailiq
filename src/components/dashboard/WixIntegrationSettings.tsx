"use client";

import { useEffect, useState, useTransition } from "react";
import { Toggle } from "@/components/ui/Toggle";
import {
  getWixStatus,
  testWixConnection,
  saveWixCredentials,
  autoMapWixCatalog,
  importWixBookings,
  setWixEnabled,
  setWixAutoApprove,
} from "@/shared/integrations/wix/admin/adminActions";
import type { WixStatus } from "@/shared/integrations/wix/admin/types";

type Props = { slug: string };

const MASK = "••••••••••••";
const inputCls =
  "w-full rounded-xl border border-nq-border/40 bg-nq-surface/60 px-3 py-2.5 text-sm text-nq-foreground placeholder:text-nq-muted/60 focus:border-nq-primary/40 focus:outline-none focus:ring-1 focus:ring-nq-primary/30 disabled:opacity-50";
const btnCls =
  "rounded-xl border border-nq-primary/40 bg-nq-primary/10 px-3 py-1.5 text-xs font-semibold text-nq-primary transition hover:bg-nq-primary/15 disabled:opacity-50";
const btnGhost =
  "rounded-xl border border-nq-border/40 bg-nq-surface/50 px-3 py-1.5 text-xs font-semibold text-nq-foreground transition hover:bg-nq-surface/70 disabled:opacity-50";

export function WixIntegrationSettings({ slug }: Props) {
  const [status, setStatus] = useState<WixStatus | null>(null);
  const [siteId, setSiteId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [showWebhook, setShowWebhook] = useState(false);
  const [pending, start] = useTransition();

  function applyStatus(s: WixStatus) {
    setStatus(s);
    setSiteId((prev) => prev || s.siteId || "");
    if (s.hasApiKey) setApiKey((prev) => (prev && !prev.includes("•") ? prev : MASK));
  }

  async function refresh() {
    const r = await getWixStatus(slug);
    if (r.ok) applyStatus(r.status);
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await getWixStatus(slug);
      if (active && r.ok) applyStatus(r.status);
    })();
    return () => {
      active = false;
    };
  }, [slug]);

  const flash = (kind: "ok" | "err", text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 4000);
  };

  function handleTest() {
    start(async () => {
      const r = await testWixConnection(slug, { siteId, apiKey });
      if (r.ok) flash("ok", `Kết nối OK — thấy ${r.serviceCount} dịch vụ trên Wix`);
      else flash("err", `Lỗi: ${r.error}`);
    });
  }

  function handleSave() {
    start(async () => {
      const r = await saveWixCredentials(slug, { siteId, apiKey });
      if (r.ok) {
        flash("ok", "Đã lưu thông tin Wix");
        await refresh();
      } else flash("err", `Lưu thất bại: ${r.error}`);
    });
  }

  function handleAutoMap() {
    start(async () => {
      const r = await autoMapWixCatalog(slug);
      if (r.ok)
        flash(
          "ok",
          `Dịch vụ: ${r.services.matched} khớp + ${r.services.created} tạo mới · Thợ: ${r.staff.matched} khớp + ${r.staff.created} tạo mới`,
        );
      else flash("err", `Lỗi map: ${r.error}`);
      await refresh();
    });
  }

  function handleImport() {
    start(async () => {
      const r = await importWixBookings(slug);
      if (r.ok) flash("ok", `Nhập booking: ${r.created} mới, ${r.updated} cập nhật`);
      else flash("err", `Lỗi nhập: ${r.error}`);
      await refresh();
    });
  }

  function toggleEnabled(v: boolean) {
    start(async () => {
      await setWixEnabled(slug, v);
      await refresh();
    });
  }
  function toggleAutoApprove(v: boolean) {
    start(async () => {
      await setWixAutoApprove(slug, v);
      await refresh();
    });
  }

  const connected = status?.connected ?? false;
  const origin = typeof window !== "undefined" ? window.location.origin : "https://nailiq.ca";

  return (
    <section
      data-testid="settings-wix"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-nq-foreground">Kết nối Wix</p>
        {status ? (
          <span
            className={
              connected
                ? "rounded-full bg-nq-success/15 px-2 py-0.5 text-[11px] font-semibold text-nq-success"
                : "rounded-full bg-nq-muted/15 px-2 py-0.5 text-[11px] font-semibold text-nq-muted"
            }
          >
            {connected ? "Đã kết nối" : "Chưa kết nối"}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-nq-muted">
        Đồng bộ 2 chiều lịch hẹn với Wix Bookings. Dán API key + Site ID của salon (lấy ở
        manage.wix.com → API Keys).
      </p>

      {/* Credentials */}
      <div className="mt-3 flex flex-col gap-2">
        <label className="text-[11px] font-medium text-nq-muted">Wix Site ID</label>
        <input
          className={inputCls}
          placeholder="bca289a2-f279-4a9a-a484-c036e5f78a34"
          value={siteId}
          disabled={pending}
          onChange={(e) => setSiteId(e.target.value.trim())}
        />
        <label className="mt-1 text-[11px] font-medium text-nq-muted">Wix API Key</label>
        <input
          className={inputCls}
          type="password"
          placeholder="IST.eyJ..."
          value={apiKey}
          disabled={pending}
          onFocus={() => {
            if (apiKey.includes("•")) setApiKey("");
          }}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnGhost} disabled={pending || !siteId} onClick={handleTest}>
            {pending ? "Đang…" : "Kiểm tra kết nối"}
          </button>
          <button type="button" className={btnCls} disabled={pending || !siteId} onClick={handleSave}>
            Lưu
          </button>
        </div>
      </div>

      {/* Setup actions (only once a key is stored) */}
      {connected ? (
        <div className="mt-4 border-t border-nq-border/20 pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">Thiết lập tự động</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={btnGhost} disabled={pending} onClick={handleAutoMap}>
              Tự động nhập dịch vụ + thợ
            </button>
            <button type="button" className={btnGhost} disabled={pending} onClick={handleImport}>
              Nhập booking cũ
            </button>
          </div>
          {status ? (
            <p className="mt-2 text-[11px] text-nq-muted">
              Đã map: {status.mappedServices}/{status.totalServices} dịch vụ · {status.mappedStaff}/
              {status.totalStaff} thợ · {status.syncedBookings} booking đã đồng bộ
            </p>
          ) : null}

          {/* Toggles */}
          <div className="mt-3 flex flex-col gap-2.5">
            <Toggle
              label="Bật đồng bộ"
              checked={status?.enabled ?? false}
              disabled={pending}
              onChange={toggleEnabled}
            />
            <Toggle
              label="Tự duyệt khách quen (an toàn)"
              checked={status?.autoApprove ?? false}
              disabled={pending}
              onChange={toggleAutoApprove}
            />
          </div>
        </div>
      ) : null}

      {/* Webhook (real-time) setup */}
      <div className="mt-4 border-t border-nq-border/20 pt-3">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          onClick={() => setShowWebhook((s) => !s)}
        >
          <span className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
            Real-time (~10s) — tùy chọn
          </span>
          <span className="text-xs text-nq-muted">{showWebhook ? "−" : "+"}</span>
        </button>
        {showWebhook ? (
          <div className="mt-2 space-y-2 text-[11px] text-nq-muted">
            <p>
              Không bắt buộc — chưa làm thì lịch vẫn đồng bộ mỗi ~1 phút. Muốn ~10 giây: vào Wix →
              Automations → tạo 3 cái “Send HTTP request” đến:
            </p>
            <code className="block break-all rounded-lg bg-nq-surface/60 px-2 py-1.5 text-nq-foreground">
              {origin}/api/webhooks/wix
            </code>
            <p>Body mỗi automation (đổi slug = created / updated / cancelled):</p>
            <pre className="overflow-x-auto rounded-lg bg-nq-surface/60 px-2 py-1.5 text-[10px] leading-relaxed text-nq-foreground">
{`{
  "entityFqdn": "wix.bookings.v2.booking",
  "slug": "created",
  "entityId": "{{Booking ID}}",
  "siteId": "${siteId || status?.siteId || "<SITE_ID>"}"
}`}
            </pre>
            {status?.webhookLastReceivedAt ? (
              <p className="text-nq-success">
                ✓ Webhook hoạt động (lần cuối: {new Date(status.webhookLastReceivedAt).toLocaleString("vi-VN")})
              </p>
            ) : (
              <p>Chưa nhận webhook nào (đang dùng polling 1 phút).</p>
            )}
          </div>
        ) : null}
      </div>

      {/* Status footer */}
      {status && (status.lastError || status.lastRunAt) ? (
        <p className="mt-3 text-[11px] text-nq-muted">
          {status.lastError ? (
            <span className="text-nq-error">Lỗi gần nhất: {status.lastError}</span>
          ) : (
            <>Sync gần nhất: {status.lastRunAt ? new Date(status.lastRunAt).toLocaleString("vi-VN") : "—"}</>
          )}
        </p>
      ) : null}

      {/* Flash message */}
      {msg ? (
        <p className={`mt-2 text-xs ${msg.kind === "ok" ? "text-nq-success" : "text-nq-error"}`}>{msg.text}</p>
      ) : null}
    </section>
  );
}
