"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/shared/lib/supabase/client";

type NotifRow = {
  id: string;
  booking_id: string | null;
  notification_type: string;
  channel: string;
  status: string;
  client_phone: string | null;
  body_preview: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  created_at: string;
};

const TYPE_LABEL: Record<string, string> = {
  booking_confirmation: "Confirmation",
  reminder_24h: "24h Reminder",
  reminder_3h: "3h Reminder",
  review_request: "Review Request",
  inbound_confirm: "Confirmed by reply",
  inbound_cancel: "Cancelled by reply",
};

function StatusDot({ status }: { status: string }) {
  const color =
    status === "delivered"
      ? "bg-green-500"
      : status === "failed" || status === "undelivered"
        ? "bg-red-500"
        : "bg-yellow-500";
  const label =
    status === "delivered"
      ? "✓ Delivered"
      : status === "failed" || status === "undelivered"
        ? "✗ Failed"
        : "⏳ Sent";
  return (
    <span className="flex items-center gap-1.5 text-[10px] text-[#a1a1aa]">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

type Props = { slug: string; salonId: string };

export function NotificationsRealtimeWidget({ slug, salonId }: Props) {
  const [rows, setRows] = useState<NotifRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    // Initial load
    supabase
      .from("booking_notifications" as never)
      .select(
        "id, booking_id, notification_type, channel, status, client_phone, body_preview, sent_at, delivered_at, failed_at, created_at",
      )
      .eq("salon_id", salonId)
      .order("created_at", { ascending: false })
      .limit(20)
      .then(({ data }) => {
        setRows((data as NotifRow[]) ?? []);
        setLoaded(true);
      });

    // Realtime subscription for delivery status updates
    const channel = supabase
      .channel(`notifications:${salonId}`)
      .on(
        "postgres_changes" as never,
        {
          event: "*",
          schema: "public",
          table: "booking_notifications",
          filter: `salon_id=eq.${salonId}`,
        },
        (payload: { new: NotifRow; eventType: string }) => {
          const updated = payload.new;
          setRows((prev) => {
            const idx = prev.findIndex((r) => r.id === updated.id);
            if (idx === -1) return [updated, ...prev].slice(0, 20);
            const next = [...prev];
            next[idx] = updated;
            return next;
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [salonId]);

  if (!loaded) return null;

  return (
    <div className="rounded-2xl border border-white/10 bg-[#1c1c1e] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">📬 SMS Notifications</h3>
        <span className="text-[10px] text-[#a1a1aa] uppercase tracking-wide">Live</span>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-[#a1a1aa]">No notifications sent yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="rounded-xl bg-black/20 px-3 py-2.5 space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-white/80">
                  {TYPE_LABEL[row.notification_type] ?? row.notification_type}
                </span>
                <StatusDot status={row.status} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-[#a1a1aa] tabular-nums">
                  {row.client_phone ?? "—"}
                </span>
                <span className="text-[10px] text-[#a1a1aa] tabular-nums">
                  {timeAgo(row.created_at)}
                </span>
              </div>
              {row.body_preview ? (
                <p className="text-[10px] text-[#a1a1aa]/70 truncate">
                  {row.body_preview}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
