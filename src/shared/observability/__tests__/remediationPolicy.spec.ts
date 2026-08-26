import { describe, expect, it } from "vitest";
import {
  canApproveErrorResolution,
  canRecordErrorQa,
  canResolveError,
  validateErrorQaEvidence,
} from "@/shared/observability/remediationPolicy";

describe("error remediation release policy", () => {
  it("keeps resolution closed until QA and approval are distinct gates", () => {
    expect(canRecordErrorQa("detected")).toBe(true);
    expect(canRecordErrorQa("triaged")).toBe(true);
    expect(canRecordErrorQa("fix_proposed")).toBe(true);
    expect(canApproveErrorResolution("fix_proposed")).toBe(false);
    expect(canApproveErrorResolution("qa_passed")).toBe(true);
    expect(canResolveError("qa_passed")).toBe(false);
    expect(canResolveError("approved")).toBe(true);
  });

  it("binds QA evidence to a full immutable commit SHA", () => {
    expect(
      validateErrorQaEvidence({
        candidateSha: "AAA156954B96CF03AD4F24D854D4C301DD73CB85",
        evidence: "Focused regression and typecheck passed.",
      }),
    ).toEqual({
      ok: true,
      candidateSha: "aaa156954b96cf03ad4f24d854d4c301dd73cb85",
      evidence: "Focused regression and typecheck passed.",
    });
    expect(
      validateErrorQaEvidence({ candidateSha: "aaa1569", evidence: "QA passed fully" }),
    ).toEqual({ ok: false, error: "invalid_candidate_sha" });
    expect(
      validateErrorQaEvidence({
        candidateSha: "aaa156954b96cf03ad4f24d854d4c301dd73cb85",
        evidence: "short",
      }),
    ).toEqual({ ok: false, error: "invalid_qa_evidence" });
  });
});
