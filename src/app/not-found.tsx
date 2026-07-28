import Link from "next/link";
import type { Metadata } from "next";
import { SalonSlugSuggestions } from "@/components/booking/SalonSlugSuggestions";

export const metadata: Metadata = {
  title: { absolute: "Page not found | NailIQ" },
  robots: { index: false, follow: false },
};

/**
 * P0.6 — bilingual 404 with both home + dashboard CTAs.
 *
 * Kept fully static (no `headers()` / `cookies()` / `auth.getUser()`).
 * The global `not-found.tsx` is the runtime fallback for every route,
 * so any dynamic API here forces Next.js to mark all static pages
 * (`/`, `/contact`, `/privacy`, `/terms`, `/register/success`) as
 * dynamic. Rendering both languages + both CTAs is the trade we make
 * to keep those landing pages prerendered.
 *
 * "Create your salon" CTA removed: 404 pages aren't a salon-acquisition
 * surface — they're an "I clicked the wrong link" surface. Sending the
 * user to /register from here was almost always wrong.
 */
export default function NotFound() {
  return (
    <main className="min-h-dvh bg-nq-bg text-nq-foreground">
      <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col items-center justify-center gap-6 px-5 py-16 text-center md:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-nq-muted">
          404 · Không tìm thấy · Not found
        </p>
        <div className="space-y-2">
          <h1 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            Không tìm thấy trang
          </h1>
          <h2 className="text-balance text-2xl font-medium tracking-tight text-nq-muted md:text-3xl">
            Page not found
          </h2>
        </div>
        <div className="space-y-1 text-pretty text-base leading-relaxed text-nq-muted">
          <p>Trang bạn tìm không tồn tại hoặc đã được di chuyển.</p>
          <p>The page you&rsquo;re looking for doesn&rsquo;t exist or may have moved.</p>
        </div>
        <SalonSlugSuggestions />
        <div className="mt-2 flex flex-col items-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-6 py-3 text-sm font-semibold text-nq-bg transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
          >
            Về trang chủ · Back to home
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-nq-border/60 bg-nq-surface/40 px-6 py-3 text-sm font-medium text-nq-foreground transition hover:bg-nq-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
          >
            Về bảng điều khiển · Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
