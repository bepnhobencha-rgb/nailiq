import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const drawer = read("src/components/dashboard/ArchivedBookingDrawer.tsx");
const feed = read("src/components/dashboard/ActivityFeed.tsx");
const loader = read(
  "src/shared/dashboard/loadArchivedBookingDetailAction.ts",
);
const action = read(
  "src/shared/dashboard/refundCancelledBookingDepositAction.ts",
);
const access = read(
  "src/shared/dashboard/archivedBookingFeatureAccess.ts",
);
const activityPage = read("src/app/dashboard/[slug]/activity/page.tsx");
const permissions = read("docs/PERMISSION_MATRIX.md");

describe("cancelled booking remaining-deposit refund UI boundary", () => {
  it("keeps the financial action on the Owner/Admin archived surface and rollout gate", () => {
    expect(activityPage).toMatch(/isOwnerOrAdmin\(ctx\.role\)/);
    expect(activityPage).toMatch(/isArchivedBookingFeatureAvailable\(ctx\.salon\)/);
    expect(loader).toMatch(/isOwnerOrAdmin\(ctx\.role\)/);
    expect(loader).toMatch(/isArchivedBookingFeatureAvailable\(ctx\.salon\)/);
    expect(action).toMatch(/ctx\.kind\s*!==\s*"member"/);
    expect(action).toMatch(/isOwnerOrAdmin\(ctx\.role\)/);
    expect(action).toMatch(/\.eq\("id", bookingId\)[\s\S]{0,120}?\.eq\("salon_id", ctx\.salon\.id\)/);
    expect(action).toMatch(/booking\.status\s*!==\s*"cancelled"/);
    expect(access).toMatch(/wix_integrations/);
    expect(access).toMatch(/return !error && !data\?\.salon_id/);
  });

  it("offers only exact remaining with an inline two-step danger confirmation", () => {
    expect(drawer).toMatch(/depositRefund\?\.availability|refund\?\.availability/);
    expect(drawer).toContain('data-testid="archived-refund-remaining-open"');
    expect(drawer).toContain('data-testid="archived-refund-remaining-confirmation"');
    expect(drawer).toContain('data-testid="archived-refund-remaining-submit"');
    expect(drawer).toMatch(/variant="danger"/);
    expect(drawer).toContain("Xác nhận hoàn đúng");
    expect(drawer).not.toContain("archived-refund-amount-input");
    expect(action).toMatch(/expectedRemainingCents/);
    expect(action).toMatch(/runCancelledBookingRemainingDepositRefund/);
  });

  it("retains one request UUID across response loss and rotates only by booking plus amount", () => {
    expect(feed).toMatch(/archivedRefundRequestRef/);
    expect(feed).toMatch(/const key = `\$\{detail\.id\}:\$\{amount\}`/);
    expect(feed).toMatch(/archivedRefundRequestRef\.current\?\.key !== key[\s\S]{0,220}?window\.crypto\.randomUUID\(\)/);
    expect(feed).toMatch(/const requestId = archivedRefundRequestRef\.current\.requestId/);
    expect(feed).toMatch(/Mất phản hồi sau khi gửi/);
    expect(feed).toMatch(/Mã yêu cầu đã được giữ nguyên/);
    expect(feed).toMatch(/if \(result\.ok\) \{[\s\S]{0,120}?if \(!isCurrentRefundView\(\)\) return/);
    expect(feed).toMatch(/archivedRefundRequestRef\.current\?\.requestId === requestId[\s\S]{0,120}?archivedRefundRequestRef\.current = null/);
  });

  it("prevents closing or replacing the drawer while money work is pending", () => {
    expect(drawer).toMatch(/const closeDrawer = \(\) => \{\s*if \(refundLoading\) return;/);
    expect(drawer).toMatch(/showCloseButton=!\{refundLoading\}|showCloseButton=\{!refundLoading\}/);
    expect(feed).toMatch(/const closeArchivedDrawer = \(\) => \{\s*if \(archivedRefundPending\) return;/);
    expect(feed).toMatch(/const openArchivedBooking = async \(item: ActivityItem\) => \{\s*if \(archivedRefundPending\) return;/);
    expect(feed).toMatch(/const isCurrentRefundView = \(\) =>[\s\S]{0,120}?archivedViewRequestId/);
    expect(feed).toMatch(/current\?\.id === detail\.id \? refreshed\.detail : current/);
  });

  it("documents the approved role policy", () => {
    expect(permissions).toContain(
      "| Refund the remaining deposit on a cancelled booking | Yes | Yes | No | No | No |",
    );
  });
});
