import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("release concierge draft-only boundary", () => {
  it("cannot publish, mutate salon data, or send email", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/shared/superadmin/releaseConciergeAction.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/getResendClient|emails\.send|sendEmail/);
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(|published_at/);
    expect(source).not.toContain("createServiceRoleClient");
  });

  it("keeps the release notice review-only", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/components/superadmin/ReleaseReviewNotice.tsx",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/getResendClient|emails\.send|sendEmail/);
    expect(source).not.toMatch(/createAnnouncement|updateAnnouncementPublish/);
    expect(source).toContain("Nothing is sent or published");
  });
});
