import { AnnouncementsAdmin } from "@/components/superadmin/AnnouncementsAdmin";
import { loadAnnouncements } from "@/shared/superadmin/announcementsActions";
import { currentReleaseReviewContext } from "@/shared/superadmin/releaseReviewContext";
import { loadReleaseReviewByDeployment } from "@/shared/superadmin/releaseReviewStore";

export const dynamic = "force-dynamic";

/**
 * Phase 1F — platform announcements admin.
 *
 * Per `PERMISSION_MATRIX §8.6` reachable by `founder` and
 * `ops_admin`. Server actions enforce the same gate.
 *
 * The consumer side (dashboard banner that reads published
 * announcements and renders them filtered by target/severity) is
 * NOT in this PR — the admin lands first so founder can stage
 * messages before the read path arrives.
 */
export default async function AnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<{ release?: string | string[] }>;
}) {
  const result = await loadAnnouncements();
  const params = await searchParams;
  const requestedRelease =
    typeof params.release === "string" ? params.release : null;
  const currentRelease = currentReleaseReviewContext();
  let releaseReview =
    currentRelease?.deploymentId === requestedRelease ? currentRelease : null;
  if (requestedRelease) {
    try {
      const stored = await loadReleaseReviewByDeployment(requestedRelease);
      if (stored) {
        releaseReview = {
          deploymentId: stored.deploymentId,
          changeSummary: stored.changeSummary,
          reviewId: stored.id,
        };
      }
    } catch (error) {
      console.error("[release-review] announcement prefill fallback", error);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 md:px-8">
      <header className="mb-6">
        <p className="text-xs font-semibold tracking-[0.18em] text-nq-muted uppercase">
          SuperAdmin · Operations
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-nq-foreground">
          Announcements
        </h1>
      </header>

      {result.ok ? (
        <AnnouncementsAdmin
          initial={result.announcements}
          releaseReview={releaseReview}
        />
      ) : (
        <p
          role="alert"
          className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
        >
          Failed to load announcements ({result.error}). Apply the
          Foundation 1A migration before the page renders.
        </p>
      )}
    </main>
  );
}
