import type { ServerQualityVerdict } from "./server";

export type QualityDecision = {
  passed: boolean;
  warning: boolean;
  code: string | null;
};

/**
 * Keep the safety gate focused on unusable uploads. A single real hand with at
 * least three visible nails can still produce a useful preview, although the
 * result may be less accurate and the UI must show a warning.
 */
export function decideServerQuality(verdict: ServerQualityVerdict): QualityDecision {
  if (verdict.verdict === "pass" && verdict.visibleNails >= 5) {
    return { passed: true, warning: false, code: null };
  }

  const usableImperfectPhoto =
    (verdict.verdict === "nails_occluded" || verdict.verdict === "wrong_pose" || verdict.verdict === "pass")
    && verdict.visibleNails >= 3;

  if (usableImperfectPhoto) {
    return {
      passed: true,
      warning: true,
      code: verdict.verdict === "pass" ? "nails_occluded" : verdict.verdict,
    };
  }

  return { passed: false, warning: false, code: verdict.verdict };
}
