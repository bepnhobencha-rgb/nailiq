import type { Metadata } from "next";
import { headers } from "next/headers";
import { loadGroupReplacementPreview } from "@/shared/booking/groupSlotRecoveryActions";
import GroupReplacementAccept from "./_components/GroupReplacementAccept";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Group appointment replacement · NailIQ",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function GroupReplacementPage({ searchParams }: { searchParams: Promise<{ token?: string; lang?: string }> }) {
  const [params, headerList] = await Promise.all([searchParams, headers()]);
  const language = params.lang === "vi" || (!params.lang && headerList.get("accept-language")?.toLowerCase().startsWith("vi")) ? "vi" : "en";
  const token = typeof params.token === "string" ? params.token : "";
  const preview = await loadGroupReplacementPreview(token);
  return (
    <main lang={language} className="min-h-screen bg-nq-bg px-4 py-8 text-nq-text">
      <div className="mx-auto max-w-lg">
        <nav aria-label="Language" className="mb-4 flex justify-end gap-4 text-sm">
          <a href={`?token=${encodeURIComponent(token)}&lang=en`} aria-current={language === "en" ? "page" : undefined} className="inline-flex min-h-12 items-center px-3 underline">English</a>
          <a href={`?token=${encodeURIComponent(token)}&lang=vi`} aria-current={language === "vi" ? "page" : undefined} className="inline-flex min-h-12 items-center px-3 underline">Tiếng Việt</a>
        </nav>
        <GroupReplacementAccept token={token} language={language} preview={preview} />
      </div>
    </main>
  );
}
