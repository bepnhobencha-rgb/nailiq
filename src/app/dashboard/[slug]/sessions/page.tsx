import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadSalonSessions } from "@/shared/dashboard/presenceActions";
import { SalonSessionsPanel } from "@/components/dashboard/SalonSessionsPanel";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
};

export default async function SessionsPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect(`/login?next=/dashboard/${slug}/sessions`);

  if (!["owner", "admin", "manager"].includes(ctx.role)) {
    redirect(`/dashboard/${slug}`);
  }

  const result = await loadSalonSessions(slug);
  const sessions = result.ok ? (result.sessions ?? []) : [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-nq-foreground">Active Sessions</h1>
        <p className="mt-1 text-sm text-nq-muted">
          Staff currently logged into the dashboard — updated every 30 seconds.
        </p>
      </div>
      <SalonSessionsPanel slug={slug} initialSessions={sessions} />
    </div>
  );
}
