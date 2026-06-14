import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadOwnerPulse } from "@/shared/dashboard/loadOwnerPulse";
import { resolveUserLanguage } from "@/shared/i18n/user/resolveUserLanguage";
import { OwnerPulse } from "@/components/dashboard/OwnerPulse";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Pulse · ${slug}`, robots: "noindex" };
}

export default async function PulsePage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  // Remote command view is owner/admin only — the away-from-salon decision-maker.
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  const language = await resolveUserLanguage();
  const res = await loadOwnerPulse(slug, language);

  return (
    <main className="mx-auto w-full max-w-[var(--max-nq-mobile)] px-4 pb-24 pt-5">
      {res.ok ? (
        <OwnerPulse slug={slug} language={language} data={res.data} />
      ) : (
        <p className="mt-10 rounded-2xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {language === "vi"
            ? "Không tải được nhịp tiệm. Thử lại sau."
            : "Could not load the pulse. Try again shortly."}
        </p>
      )}
    </main>
  );
}
