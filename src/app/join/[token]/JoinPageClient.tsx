"use client";

import { useState, useTransition } from "react";
import { createClient } from "@/shared/lib/supabase/client";

type Props = {
  token: string;
  salonName: string;
  staffName: string;
  role: "admin" | "receptionist";
};

const ROLE_LABEL: Record<"admin" | "receptionist", string> = {
  admin: "Quản trị viên",
  receptionist: "Tiếp tân",
};

function authCallbackUrl(token: string): string {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/auth/callback?invite=${encodeURIComponent(token)}`;
}

export function JoinPageClient({ token, salonName, staffName, role }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onGoogle = () => {
    setError(null);
    startTransition(async () => {
      const supabase = createClient();
      const { error: oauthErr } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: authCallbackUrl(token) },
      });
      if (oauthErr) setError(oauthErr.message ?? "Đăng nhập thất bại. Thử lại nhé.");
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0b0c10] px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="mb-8 flex items-center justify-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#d4af37]">
            <svg width="20" height="20" viewBox="0 0 28 28" fill="none">
              <path d="M14 6C10.686 6 8 8.686 8 12C8 14.8 9.8 17.2 12.4 18.2V20C12.4 20.88 13.12 21.6 14 21.6C14.88 21.6 15.6 20.88 15.6 20V18.2C18.2 17.2 20 14.8 20 12C20 8.686 17.314 6 14 6Z" fill="#0b0c10"/>
            </svg>
          </div>
          <span className="text-xl font-bold tracking-tight text-white">NailIQ</span>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-7 backdrop-blur-sm">
          {/* Welcome header */}
          <div className="mb-6 text-center">
            <div className="mb-3 text-3xl">🎉</div>
            <h1 className="text-xl font-bold text-white">
              Chào mừng{staffName ? `, ${staffName}` : ""}!
            </h1>
            <p className="mt-1.5 text-sm text-white/60">
              Bạn được mời tham gia
            </p>
            <p className="mt-0.5 text-base font-semibold text-[#d4af37]">
              {salonName}
            </p>
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-[#d4af37]/30 bg-[#d4af37]/10 px-3 py-1 text-xs font-medium text-[#d4af37]">
              🔑 {ROLE_LABEL[role]}
            </div>
          </div>

          {/* Divider */}
          <div className="mb-5 h-px bg-white/10" />

          {/* CTA */}
          <button
            type="button"
            onClick={onGoogle}
            disabled={pending}
            className="flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-white px-4 py-3.5 text-sm font-semibold text-gray-800 transition hover:bg-gray-50 disabled:opacity-60"
          >
            {/* Google G */}
            <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            {pending ? "Đang mở Google…" : "Tiếp tục bằng Google"}
          </button>

          {error && (
            <p className="mt-3 rounded-xl bg-red-500/10 px-4 py-2.5 text-center text-sm text-red-400">
              {error}
            </p>
          )}

          <p className="mt-5 text-center text-xs text-white/40">
            Link này dùng 1 lần · hết hạn sau 48 giờ
          </p>
        </div>

        <p className="mt-6 text-center text-xs text-white/30">
          nailiq.ca · AI Booking System
        </p>
      </div>
    </div>
  );
}
