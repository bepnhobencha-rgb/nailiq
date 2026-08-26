export const ERROR_REMEDIATION_STATES = [
  "detected",
  "triaged",
  "fix_proposed",
  "qa_passed",
  "approved",
] as const;

export type ErrorRemediationState = (typeof ERROR_REMEDIATION_STATES)[number];

export const ERROR_REMEDIATION_LABEL: Record<ErrorRemediationState, string> = {
  detected: "Detected",
  triaged: "Triaged",
  fix_proposed: "Human review",
  qa_passed: "QA passed",
  approved: "Approved to resolve",
};

export function canRecordErrorQa(state: ErrorRemediationState): boolean {
  return state === "detected" || state === "triaged" || state === "fix_proposed";
}

export function canApproveErrorResolution(state: ErrorRemediationState): boolean {
  return state === "qa_passed";
}

export function canResolveError(state: ErrorRemediationState): boolean {
  return state === "approved";
}

export function validateErrorQaEvidence(input: {
  candidateSha: string;
  evidence: string;
}):
  | { ok: true; candidateSha: string; evidence: string }
  | { ok: false; error: "invalid_candidate_sha" | "invalid_qa_evidence" } {
  const candidateSha = input.candidateSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
    return { ok: false, error: "invalid_candidate_sha" };
  }

  const evidence = input.evidence.trim();
  if (evidence.length < 12 || evidence.length > 2000) {
    return { ok: false, error: "invalid_qa_evidence" };
  }

  return { ok: true, candidateSha, evidence };
}
