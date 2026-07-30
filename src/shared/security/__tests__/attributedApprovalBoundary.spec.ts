import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260730053500_attribute_dashboard_approval_decisions.sql",
  ),
  "utf8",
);
const action = readFileSync(
  resolve(process.cwd(), "src/shared/ai/decideApprovalAction.ts"),
  "utf8",
);
const approvalsDashboard = readFileSync(
  resolve(process.cwd(), "src/components/dashboard/ApprovalsDashboard.tsx"),
  "utf8",
);
const controlCenter = readFileSync(
  resolve(process.cwd(), "src/components/dashboard/AiControlCenter.tsx"),
  "utf8",
);
const approvalRequests = readFileSync(
  resolve(process.cwd(), "src/shared/ai/approvalRequests.ts"),
  "utf8",
);

describe("attributed AI approval boundary", () => {
  it("keeps dashboard decisions behind authenticated owner/admin authorization", () => {
    expect(action).toContain("getDashboardWriteClient(input.slug)");
    expect(action).toContain("isOwnerOrAdmin(ctx.role)");
    expect(action).toContain("p_actor_user_id: ctx.userId");
  });

  it("validates the actor membership again inside the atomic RPC", () => {
    expect(migration).toContain("for update");
    expect(migration).toContain("sm.user_id = p_actor_user_id");
    expect(migration).toContain("sm.role in ('owner', 'admin')");
    expect(migration).toContain("decided_by = p_actor_user_id");
    expect(migration).toContain("decision_channel = 'dashboard'");
  });

  it("keeps the actor RPC service-role-only", () => {
    expect(migration).toMatch(
      /revoke all on function public\.decide_ai_approval_request_as_actor\(uuid, text, uuid\)\s+from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.decide_ai_approval_request_as_actor\(uuid, text, uuid\)\s+to service_role/i,
    );
  });

  it("does not serialize approval bearer tokens into dashboard clients", () => {
    expect(approvalsDashboard).not.toContain("approve_token");
    expect(approvalsDashboard).not.toContain("decline_token");
    expect(controlCenter).not.toContain("approve_token");
    expect(controlCenter).not.toContain("decline_token");
    expect(approvalsDashboard).toContain("ApprovalDecisionButtons");
    expect(controlCenter).toContain("ApprovalDecisionButtons");
    expect(approvalRequests).toContain(
      '"approve_token" | "decline_token" | "decided_by"',
    );
  });

  it("only displays a dashboard actor after revalidating salon membership", () => {
    expect(approvalRequests).toContain('.from("salon_members")');
    expect(approvalRequests).toContain('.in("role", ["owner", "admin"])');
    expect(approvalRequests).toContain("roleByMembership.has");
    expect(controlCenter).toContain("approvalDecisionProvenance");
    expect(approvalsDashboard).toContain("approvalDecisionProvenance");
  });

  it("preserves two-step email capability decisions without claiming an actor", () => {
    expect(migration).toContain("new.decision_channel := 'email_capability'");
    expect(migration).toContain("old.status = 'pending'");
    expect(migration).toContain("new.status in ('approved', 'declined')");
  });

  it("appends actor attribution instead of rewriting the existing audit row", () => {
    expect(migration).toContain("'approval_actor_attributed'");
    expect(migration).not.toMatch(/update public\.ai_actions_log/i);
  });
});
