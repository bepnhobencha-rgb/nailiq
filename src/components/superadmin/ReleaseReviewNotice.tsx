"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type { ReleaseReviewContext } from "@/shared/superadmin/releaseReviewContext";
import { ownerFriendlyReleaseSummary } from "@/shared/superadmin/releaseReviewPresentation";

const REVIEWED_KEY_PREFIX = "nailiq:release-review:handled:";
const REVIEW_HANDLED_EVENT = "nailiq-release-review-handled";

function reviewStorageKey(deploymentId: string): string {
  return `${REVIEWED_KEY_PREFIX}${deploymentId}`;
}

export function markReleaseReviewHandled(deploymentId: string): void {
  try {
    window.localStorage.setItem(reviewStorageKey(deploymentId), "1");
  } catch {
    // Storage may be unavailable in private mode. The notice remains safe.
  }
  window.dispatchEvent(
    new CustomEvent(REVIEW_HANDLED_EVENT, { detail: deploymentId }),
  );
}

export function ReleaseReviewNotice({
  review,
}: {
  review: ReleaseReviewContext | null;
}) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!review) return;

    const deploymentId = review.deploymentId;
    const syncVisibility = () => {
      try {
        setVisible(
          window.localStorage.getItem(reviewStorageKey(deploymentId)) !== "1",
        );
      } catch {
        setVisible(true);
      }
    };
    const initialSync = window.setTimeout(syncVisibility, 0);

    const onHandled = (event: Event) => {
      const handled = event as CustomEvent<string>;
      if (handled.detail === deploymentId) setVisible(false);
    };
    window.addEventListener(REVIEW_HANDLED_EVENT, onHandled);
    return () => {
      window.clearTimeout(initialSync);
      window.removeEventListener(REVIEW_HANDLED_EVENT, onHandled);
    };
  }, [review]);

  if (!review || !visible) return null;
  const activeReview = review;
  const friendlySummary = ownerFriendlyReleaseSummary(
    activeReview.changeSummary,
    language,
  );

  function openReview() {
    if (activeReview.reviewId) {
      router.push(
        `/superadmin/operations/release-reviews/${encodeURIComponent(activeReview.reviewId)}?intent=approved`,
      );
      return;
    }
    router.push(
      `/superadmin/operations/announcements?release=${encodeURIComponent(activeReview.deploymentId)}`,
    );
  }

  function dismissReview() {
    if (activeReview.reviewId) {
      router.push(
        `/superadmin/operations/release-reviews/${encodeURIComponent(activeReview.reviewId)}?intent=declined`,
      );
      return;
    }
    markReleaseReviewHandled(activeReview.deploymentId);
    setVisible(false);
  }

  return (
    <section
      aria-label="Release communication review"
      role="status"
      data-testid="release-review-notice"
      className="mx-5 mt-5 flex flex-col gap-3 rounded-2xl border border-nq-primary/45 bg-nq-primary/10 p-4 md:mx-8 md:flex-row md:items-center md:justify-between"
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold text-nq-foreground">
          {vi
            ? "Có cập nhật mới — soạn thông báo cho chủ salon?"
            : "New update — prepare a salon-owner announcement?"}
        </p>
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-nq-muted">
          {friendlySummary}
        </p>
        <p className="mt-1 text-xs text-nq-muted">
          {vi
            ? "Bản cập nhật đã hoạt động. NailIQ chưa gửi hay đăng thông báo nào."
            : "The update is already active. Nothing is sent or published until you review and confirm."}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="md" onClick={dismissReview}>
          {vi ? "Không thông báo cho salon" : "Do not notify salons"}
        </Button>
        <Button type="button" variant="primary" size="md" onClick={openReview}>
          {vi ? "Soạn bản nháp để tôi duyệt" : "Prepare drafts for review"}
        </Button>
      </div>
    </section>
  );
}
