import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("MQA-0178 review reply draft boundary", () => {
  it("uses an atomic PII-free claim and service-role-only functions", () => {
    const migration = read(
      "supabase/migrations/20260822223532_add_atomic_review_reply_drafts.sql",
    );
    expect(migration).toContain("review_reply_draft_claims_source_key_unique");
    expect(migration).toContain("ON CONFLICT (salon_id, source, review_key) DO NOTHING");
    expect(migration).toContain("attempt_count BETWEEN 1 AND 3");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    const claimTable = migration.slice(
      migration.indexOf("CREATE TABLE public.review_reply_draft_claims"),
      migration.indexOf("CREATE OR REPLACE FUNCTION"),
    );
    expect(claimTable).not.toContain("review_text text");
    expect(claimTable).not.toContain("reviewer_name text");
  });

  it("creates dashboard-only manual-copy drafts with dispatch hard off", () => {
    const migration = read(
      "supabase/migrations/20260822223532_add_atomic_review_reply_drafts.sql",
    );
    expect(migration).toContain("'notification_mode', 'dashboard_only_no_email'");
    expect(migration).toContain("'execution_mode', 'manual_copy_only'");
    expect(migration).toContain("'dispatch_enabled', false");
    expect(migration).toContain("'draft_only_human_copy_required'");
  });

  it("has no owner alert or public reply mutation path", () => {
    const agent = read("src/shared/ai/agentReviewResponder.ts");
    expect(agent).toContain('"claim_review_reply_draft"');
    expect(agent).toContain('"complete_review_reply_draft"');
    expect(agent).not.toContain("sendOwnerAlert");
    expect(agent).not.toMatch(/replies\.(?:create|update)|accounts\.updateReply/);
    expect(agent).not.toContain("resend.emails.send");
  });

  it("excludes dashboard-only drafts from every generic approval email path", () => {
    const approvals = read("src/shared/ai/approvalRequests.ts");
    const digest = read("src/shared/ai/agentDigest.ts");
    expect(approvals).toContain("approvalAllowsEmail(req)");
    expect(approvals).toContain('notification_mode !== "dashboard_only_no_email"');
    expect(digest).toContain("emailablePendingApprovals");
    expect(digest).toContain("approvalAllowsEmail");
  });

  it("requires an explicit owner save or clipboard action in the dashboard", () => {
    const editor = read("src/components/dashboard/ReviewReplyDraftEditor.tsx");
    expect(editor).toContain('action: "save_review_reply_draft"');
    expect(editor).toContain("navigator.clipboard.writeText(draft)");
    expect(editor).toContain("maxLength={800}");
    expect(editor).toContain("NailIQ không tự đăng và không tự gửi email");
  });
});
