"use client";

import { useState, useTransition } from "react";
import { MessageSquare } from "lucide-react";
import { Toggle } from "@/components/ui/Toggle";
import { updateMessagingSettings } from "./messagingAction";

interface Props {
  slug: string;
  /** Operator-level SMS kill-switch. Default true. */
  initialSmsEnabled: boolean;
  /** Operator-level email kill-switch. Default true. */
  initialEmailEnabled: boolean;
  /**
   * Whether this salon has completed US Twilio A2P 10DLC registration.
   * Set by superadmin only — read-only for salon owner/admin.
   */
  smsA2pRegistered: boolean;
}

export function MessagingSettings({
  slug,
  initialSmsEnabled,
  initialEmailEnabled,
  smsA2pRegistered,
}: Props) {
  const [smsEnabled, setSmsEnabled] = useState(initialSmsEnabled);
  const [emailEnabled, setEmailEnabled] = useState(initialEmailEnabled);
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  function handleSave() {
    setToast(null);
    startTransition(async () => {
      const result = await updateMessagingSettings(slug, smsEnabled, emailEnabled);
      if (result.ok) {
        setToast({ kind: "ok", msg: "Đã lưu cài đặt." });
      } else {
        setToast({
          kind: "err",
          msg: result.error === "unauthorized"
            ? "Không có quyền thực hiện thao tác này."
            : "Lưu thất bại — vui lòng thử lại.",
        });
      }
    });
  }

  return (
    <section
      data-testid="messaging-settings"
      className="rounded-xl border border-nq-border bg-nq-surface p-5"
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <MessageSquare className="h-5 w-5 shrink-0 text-nq-primary" aria-hidden />
        <h2 className="text-base font-semibold text-nq-foreground">Tin nhắn &amp; Email</h2>
      </div>

      {/* A2P registration badge (read-only) */}
      <div className="mt-4 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {smsA2pRegistered ? (
            <span
              data-testid="a2p-badge-registered"
              className="inline-flex items-center gap-1 rounded-full bg-nq-success/15 px-3 py-1 text-xs font-semibold text-nq-success"
            >
              ✓ Đã đăng ký A2P
            </span>
          ) : (
            <span
              data-testid="a2p-badge-pending"
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-500"
            >
              Chưa đăng ký A2P
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-nq-muted">
          Tiệm ở Mỹ cần đăng ký A2P 10DLC trước khi gửi SMS; trong lúc chờ, hệ thống tự dùng email.
        </p>
      </div>

      <div className="mt-5 flex flex-col gap-4">
        {/* SMS toggle */}
        <div className="flex items-center justify-between gap-4 rounded-lg border border-nq-border/60 bg-nq-surface-2 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-nq-foreground">Gửi SMS</p>
            <p className="mt-0.5 text-xs text-nq-muted">Tắt để dừng toàn bộ SMS tự động</p>
          </div>
          <Toggle
            checked={smsEnabled}
            disabled={pending}
            aria-label="Gửi SMS"
            onChange={setSmsEnabled}
          />
        </div>

        {/* Email toggle */}
        <div className="flex items-center justify-between gap-4 rounded-lg border border-nq-border/60 bg-nq-surface-2 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-nq-foreground">Gửi email</p>
            <p className="mt-0.5 text-xs text-nq-muted">Tắt để dừng toàn bộ email tự động</p>
          </div>
          <Toggle
            checked={emailEnabled}
            disabled={pending}
            aria-label="Gửi email"
            onChange={setEmailEnabled}
          />
        </div>

        {/* Toast */}
        {toast ? (
          <p
            data-testid="messaging-settings-toast"
            role="status"
            className={
              toast.kind === "ok"
                ? "text-sm text-nq-success"
                : "text-sm text-nq-error"
            }
          >
            {toast.msg}
          </p>
        ) : null}

        {/* Save button */}
        <div>
          <button
            type="button"
            onClick={handleSave}
            disabled={pending}
            className="rounded-xl border border-nq-primary/40 bg-nq-primary/10 px-4 py-2 text-sm font-semibold text-nq-primary transition hover:bg-nq-primary/15 disabled:opacity-50"
          >
            {pending ? "Đang lưu…" : "Lưu cài đặt"}
          </button>
        </div>
      </div>
    </section>
  );
}
