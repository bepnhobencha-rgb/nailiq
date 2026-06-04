"use client";

import { useState, useTransition } from "react";
import {
  connectSalonDomain,
  disconnectSalonDomain,
  refreshSalonDomain,
  type SalonDomainInfo,
} from "@/shared/dashboard/domainActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
  initial: SalonDomainInfo;
};

/**
 * Owner-only: connect the salon's own domain to its public booking page.
 * Shows the DNS record to set + live Vercel status. Degrades gracefully when
 * Vercel automation isn't configured (still persists the mapping so routing
 * works; the owner attaches the domain in Vercel manually).
 */
export function DomainSettings({ slug, initial }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [info, setInfo] = useState<SalonDomainInfo>(initial);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const errText = (code: string) =>
    ({
      invalid_domain: vi ? "Tên miền không hợp lệ." : "Invalid domain.",
      domain_taken: vi ? "Tên miền đã được salon khác dùng." : "Domain already used by another salon.",
      vercel_failed: vi ? "Vercel từ chối tên miền (có thể đang gắn ở project khác)." : "Vercel rejected the domain (it may be on another project).",
      forbidden: vi ? "Chỉ chủ tiệm mới đổi được." : "Owner only.",
    })[code] ?? (vi ? "Có lỗi xảy ra." : "Something went wrong.");

  function handleConnect() {
    setError(null);
    startTransition(async () => {
      const res = await connectSalonDomain(slug, draft);
      if (res.ok) {
        setInfo(res.info);
        setDraft("");
      } else {
        setError(errText(res.error) + (res.message ? ` (${res.message})` : ""));
      }
    });
  }

  function handleRefresh() {
    setError(null);
    startTransition(async () => setInfo(await refreshSalonDomain(slug)));
  }

  function handleDisconnect() {
    setError(null);
    startTransition(async () => {
      const res = await disconnectSalonDomain(slug);
      if (res.ok) {
        setInfo({ domain: null, routingRecord: null, status: null, automationConfigured: info.automationConfigured });
      } else {
        setError(errText(res.error ?? ""));
      }
    });
  }

  const rec = info.routingRecord;
  const st = info.status;
  const badge = !info.domain
    ? null
    : st?.connected
      ? { text: vi ? "Đã kết nối" : "Connected", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" }
      : !info.automationConfigured
        ? { text: vi ? "Chờ trỏ DNS" : "Set DNS", cls: "border-amber-500/40 bg-amber-500/10 text-amber-400" }
        : st?.misconfigured
          ? { text: vi ? "Chờ DNS" : "Pending DNS", cls: "border-amber-500/40 bg-amber-500/10 text-amber-400" }
          : { text: vi ? "Chờ xác minh" : "Verifying", cls: "border-amber-500/40 bg-amber-500/10 text-amber-400" };

  return (
    <section
      data-testid="settings-domain"
      className="mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold text-nq-foreground">
          {vi ? "Tên miền riêng" : "Custom domain"}
        </p>
        {badge ? (
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
            {badge.text}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-nq-muted">
        {vi
          ? "Phục vụ trang đặt lịch trên tên miền của bạn (vd. hiliteheadspa.com)."
          : "Serve your booking page on your own domain (e.g. hiliteheadspa.com)."}
      </p>

      {!info.domain ? (
        <div className="mt-3 flex flex-col gap-2">
          <input
            type="text"
            inputMode="url"
            placeholder="hiliteheadspa.com"
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full rounded-xl border border-nq-border/40 bg-nq-surface/60 px-3 py-2.5 text-sm text-nq-foreground placeholder:text-nq-muted/60 focus:border-nq-primary/40 focus:outline-none focus:ring-1 focus:ring-nq-primary/30 disabled:opacity-50"
          />
          {error ? <p className="text-xs text-nq-error">{error}</p> : null}
          <button
            type="button"
            disabled={pending || !draft.trim()}
            onClick={handleConnect}
            className="self-start rounded-xl border border-nq-primary/40 bg-nq-primary/10 px-3 py-1.5 text-xs font-semibold text-nq-primary transition hover:bg-nq-primary/15 disabled:opacity-50"
          >
            {pending ? (vi ? "Đang kết nối…" : "Connecting…") : vi ? "Kết nối" : "Connect"}
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm font-medium text-nq-foreground">{info.domain}</p>

          {rec ? (
            <div className="rounded-xl border border-nq-border/40 bg-nq-surface/50 p-3">
              <p className="text-xs text-nq-muted">
                {vi
                  ? "Vào nhà cung cấp tên miền, thêm bản ghi DNS này:"
                  : "At your domain provider, add this DNS record:"}
              </p>
              <div className="mt-2 flex items-center justify-between gap-2 font-mono text-xs text-nq-foreground">
                <span>
                  {rec.type} &nbsp; {rec.name} &nbsp;→&nbsp; {rec.value}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(rec.value);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="shrink-0 rounded-lg border border-nq-border/40 px-2 py-1 text-[10px] text-nq-muted hover:text-nq-foreground"
                >
                  {copied ? (vi ? "Đã chép" : "Copied") : vi ? "Chép" : "Copy"}
                </button>
              </div>
              {st?.ownershipRecords?.length ? (
                <div className="mt-2 border-t border-nq-border/30 pt-2">
                  <p className="text-[11px] text-nq-muted">
                    {vi ? "Bản ghi xác minh (TXT):" : "Ownership record (TXT):"}
                  </p>
                  {st.ownershipRecords.map((o, i) => (
                    <p key={i} className="mt-1 break-all font-mono text-[11px] text-nq-foreground">
                      {o.type} {o.name} → {o.value}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {!info.automationConfigured ? (
            <p className="text-[11px] text-amber-400">
              {vi
                ? "Tự động hoá Vercel chưa bật — sau khi trỏ DNS, gắn tên miền vào project trên Vercel để cấp SSL."
                : "Vercel automation is off — after setting DNS, attach the domain to the project in Vercel for SSL."}
            </p>
          ) : null}

          {error ? <p className="text-xs text-nq-error">{error}</p> : null}

          <div className="flex items-center gap-3">
            {info.automationConfigured ? (
              <button
                type="button"
                disabled={pending}
                onClick={handleRefresh}
                className="rounded-xl border border-nq-primary/40 bg-nq-primary/10 px-3 py-1.5 text-xs font-semibold text-nq-primary transition hover:bg-nq-primary/15 disabled:opacity-50"
              >
                {pending ? (vi ? "Đang kiểm tra…" : "Checking…") : vi ? "Kiểm tra lại" : "Re-check"}
              </button>
            ) : null}
            <button
              type="button"
              disabled={pending}
              onClick={handleDisconnect}
              className="rounded-xl border border-nq-border/40 px-3 py-1.5 text-xs font-semibold text-nq-muted transition hover:text-nq-error disabled:opacity-50"
            >
              {vi ? "Ngắt kết nối" : "Disconnect"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
