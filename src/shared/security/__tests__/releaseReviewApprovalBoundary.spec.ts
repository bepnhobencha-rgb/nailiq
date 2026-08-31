import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("release review approval boundary", () => {
  it("never mutates from an email GET link", () => {
    const emailSource = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/shared/superadmin/releaseReviewEmail.ts",
      ),
      "utf8",
    );
    const pageSource = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/app/superadmin/(shell)/operations/release-reviews/[reviewId]/page.tsx",
      ),
      "utf8",
    );
    const noticeSource = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/components/superadmin/ReleaseReviewNotice.tsx",
      ),
      "utf8",
    );
    expect(emailSource).toContain("/superadmin/operations/release-reviews/");
    expect(emailSource).not.toContain("/api/ai/approve");
    expect(pageSource).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
    expect(pageSource).toContain("<form action={action}");
    expect(pageSource).not.toContain("{review.changeSummary}");
    expect(noticeSource).toContain("isReleaseReviewDecisionPath(pathname)");
  });

  it("requires cron auth and a second authenticated audited decision", () => {
    const cronSource = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/app/api/cron/release-review/route.ts",
      ),
      "utf8",
    );
    const actionSource = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/shared/superadmin/releaseReviewActions.ts",
      ),
      "utf8",
    );
    expect(cronSource).toContain("requireCronAuthorization(request)");
    expect(cronSource).toContain('runTrackedCron("release_review"');
    expect(actionSource).toContain("requireActiveSuperAdminSession");
    expect(actionSource).toContain('const ALLOWED_ROLES = new Set(["founder", "ops_admin"])');
    expect(actionSource).toContain("writeAuditLog");
    expect(actionSource).toContain('.eq("status" as never, "pending")');
  });
});
