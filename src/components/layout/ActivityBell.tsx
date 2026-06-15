"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/client";
import { getActivityUnreadCount } from "@/shared/dashboard/loadActivityFeedAction";

/**
 * Activity bell in the dashboard top-right chrome. Shows how many new items
 * (SMS / email / calls / booking changes / settings changes) landed since the
 * owner last opened the Activity log. "Nổi ngay": a booking_notifications
 * realtime ping re-checks instantly; a 60s poll + window-focus check covers the
 * rest (audit/event rows aren't browser-readable under RLS, so the count comes
 * from an owner-gated server action). Owner-only — hidden for other roles.
 */
export function ActivityBell() {
  const pathname = usePathname();
  const router = useRouter();
  const slug = pathname?.match(/^\/dashboard\/([^/]+)/)?.[1] ?? null;

  const [count, setCount] = useState(0);
  const [visible, setVisible] = useState(false);
  const seenKey = slug ? `activity-seen:${slug}` : null;
  // Stable session baseline used only when no marker is persisted yet — keeps the
  // first-load badge from blasting the whole history WITHOUT writing the marker.
  const baselineRef = useRef<string>(new Date().toISOString());

  const getSeen = useCallback((): string => {
    if (!seenKey || typeof window === "undefined") return baselineRef.current;
    // The Activity PAGE is the sole owner of the seen-marker. The bell only reads
    // it — writing here would make the first /activity visit treat everything as
    // already seen (dimmed).
    return window.localStorage.getItem(seenKey) || baselineRef.current;
  }, [seenKey]);

  const refresh = useCallback(async () => {
    if (!slug) return;
    const res = await getActivityUnreadCount(slug, getSeen());
    if (res.ok) {
      setVisible(true);
      setCount(res.count);
    } else {
      setVisible(false);
    }
  }, [slug, getSeen]);

  useEffect(() => {
    if (!slug) return;
    // Initial + interval/focus/realtime refresh sets count async after a fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 60_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);

    // Instant ping on any new SMS/email row (the realtime-enabled table).
    const supabase = createClient();
    const channel = supabase
      .channel(`activity-bell:${slug}`)
      .on(
        "postgres_changes" as never,
        { event: "INSERT", schema: "public", table: "booking_notifications" },
        () => void refresh(),
      )
      .subscribe();

    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
      void supabase.removeChannel(channel);
    };
  }, [slug, refresh]);

  const open = useCallback(() => {
    if (!slug) return;
    // Don't advance the seen-marker here — the Activity page itself reads the
    // OLD marker to bold the unread rows, then marks them seen. Just clear the
    // badge optimistically; the next poll confirms it once the page marks seen.
    setCount(0);
    router.push(`/dashboard/${slug}/activity`);
  }, [slug, router]);

  if (!visible || !slug) return null;

  return (
    <button
      type="button"
      onClick={open}
      aria-label={count > 0 ? `Nhật ký — ${count} mục mới` : "Nhật ký hoạt động"}
      title={count > 0 ? `${count} hoạt động mới` : "Nhật ký hoạt động"}
      data-testid="activity-bell"
      className="relative flex h-9 w-9 items-center justify-center rounded-full text-nq-foreground/75 transition-colors hover:text-nq-primary"
    >
      <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
      </svg>
      {count > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-nq-error px-1 text-[9px] font-bold text-white">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
}
