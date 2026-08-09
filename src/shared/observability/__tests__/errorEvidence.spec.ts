import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  anthropicConstructor: vi.fn(),
  anthropicCreate: vi.fn(),
  createServiceRoleClient: vi.fn(),
  selectedColumns: "",
  row: null as Record<string, unknown> | null,
  update: vi.fn(),
  updateEq: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(function AnthropicMock() {
    mocks.anthropicConstructor();
    return { messages: { create: mocks.anthropicCreate } };
  }),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

vi.mock("@/shared/lib/resend", () => ({
  getResendClient: vi.fn(),
  getResendFrom: vi.fn(),
}));

vi.mock("@/shared/ai/usageLedger", () => ({
  trackAnthropicMessage: vi.fn(
    async (_context: unknown, execute: () => Promise<unknown>) => execute(),
  ),
}));

import {
  assessErrorEvidence,
  evidenceConflictSummary,
} from "@/shared/observability/errorEvidence";
import { draftFix } from "@/shared/observability/draftFix";
import { triageError } from "@/shared/observability/triageError";

function mockErrorDatabase() {
  const selectEq = vi.fn().mockReturnValue({
    maybeSingle: vi.fn().mockImplementation(async () => ({ data: mocks.row })),
  });
  mocks.updateEq.mockResolvedValue({ error: null });
  mocks.update.mockReturnValue({ eq: mocks.updateEq });
  mocks.createServiceRoleClient.mockReturnValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn((columns: string) => {
        mocks.selectedColumns = columns;
        return { eq: selectEq };
      }),
      update: mocks.update,
    }),
  });
}

const conflictingRow = {
  id: "00000000-0000-4000-8000-000000000001",
  level: "error",
  message: "Minified React error #418",
  surface: "client",
  route: "/choose-salon",
  stack: "Error: Minified React error #418",
  context: {
    href: "https://www.nailiq.ca/dashboard/hilite-anaheim/center?view=day#queue",
  },
  ai_summary: null,
  ai_suggested_fix: null,
};

describe("error evidence assessment", () => {
  it("detects a legacy group whose stored route contradicts the latest href", () => {
    const assessment = assessErrorEvidence(
      "/choose-salon",
      conflictingRow.context,
    );

    expect(assessment).toEqual({
      status: "conflict",
      storedRoute: "/choose-salon",
      contextRoute: "/dashboard/hilite-anaheim/center",
    });
    if (assessment.status === "conflict") {
      expect(evidenceConflictSummary(assessment)).toContain(
        "Automated remediation is blocked",
      );
    }
  });

  it("treats query and hash changes on the same pathname as consistent", () => {
    expect(
      assessErrorEvidence("/dashboard/tech-nails/center", {
        href: "https://www.nailiq.ca/dashboard/tech-nails/center?view=day#queue",
      }),
    ).toEqual({
      status: "consistent",
      storedRoute: "/dashboard/tech-nails/center",
      contextRoute: "/dashboard/tech-nails/center",
    });
  });

  it("does not invent a conflict when either route is missing or unsafe", () => {
    expect(assessErrorEvidence(null, { href: "/choose-salon" }).status).toBe(
      "insufficient",
    );
    expect(
      assessErrorEvidence("/choose-salon", { href: "javascript:alert(1)" })
        .status,
    ).toBe("insufficient");
  });
});

describe("AI remediation evidence gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.row = conflictingRow;
    process.env.ANTHROPIC_API_KEY = "must-not-be-used";
    mockErrorDatabase();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("blocks triage before constructing an AI client", async () => {
    await expect(triageError(conflictingRow.id)).resolves.toEqual({
      ok: false,
      blocked: "evidence_conflict",
    });

    expect(mocks.selectedColumns).toContain("context");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ai_summary: expect.stringContaining("Evidence conflict"),
        ai_suggested_fix: expect.stringContaining("route-scoped occurrence"),
      }),
    );
    expect(mocks.anthropicConstructor).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks draft fixes before AI, repository reads, or GitHub writes", async () => {
    await expect(draftFix(conflictingRow.id)).resolves.toEqual({
      ok: false,
      blocked: "evidence_conflict",
    });

    expect(mocks.selectedColumns).toContain("context");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        fix_proposal: expect.stringContaining("Evidence conflict"),
        fix_file: null,
        fix_pr_url: null,
      }),
    );
    expect(mocks.anthropicConstructor).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
