import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClientProfilesPanel } from "@/components/dashboard/ClientProfilesPanel";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { userEn } from "@/shared/i18n/user";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Clients · ${slug}`,
    robots: "noindex",
  };
}

export default async function ClientsPage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }
  // Server-side gate matches loadClientProfiles: owner+senior only.
  // nail_tech viewers are bounced to the dashboard home rather than
  // shown an empty / forbidden page.
  if (ctx.role !== "owner" && ctx.role !== "senior") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  // Owner-facing page; English copy is the primary product language
  // per UX_PRINCIPLES §7. A client wrapper that reads `useUserLanguage`
  // can fold VI later if real-world traffic justifies it.
  return (
    <main className="mx-auto w-full max-w-[var(--max-nq-desktop)] px-[var(--pad-nq-section-mobile)] py-6 md:px-6">
      <h1 className="mb-4 text-xl font-semibold text-nq-foreground">
        {userEn.receptionist.clientProfiles.pageTitle}
      </h1>
      <ClientProfilesPanel
        slug={slug}
        viewerRole={ctx.role}
        messages={userEn.receptionist.clientProfiles}
      />
    </main>
  );
}
