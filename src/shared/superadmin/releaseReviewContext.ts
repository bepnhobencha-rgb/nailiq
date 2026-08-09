import { deploymentIdentity } from "@/shared/operations/deploymentIdentity";
import { redactReleaseInput } from "@/shared/superadmin/releaseConcierge";

const SUMMARY_MAX_LEN = 4_000;

type ReleaseEnvironment = {
  VERCEL_GIT_COMMIT_SHA?: string;
  VERCEL_DEPLOYMENT_ID?: string;
  VERCEL_GIT_COMMIT_MESSAGE?: string;
  npm_package_version?: string;
};

export type ReleaseReviewContext = {
  deploymentId: string;
  changeSummary: string;
};

/**
 * Returns the current production release without making a network request.
 * Vercel injects these values at build time. Local/dev builds deliberately do
 * not create review noise for Superadmin.
 */
export function currentReleaseReviewContext(
  env: ReleaseEnvironment = process.env as ReleaseEnvironment,
): ReleaseReviewContext | null {
  const deploymentId = deploymentIdentity(env);
  if (deploymentId === "dev") return null;

  const rawSummary =
    env.VERCEL_GIT_COMMIT_MESSAGE?.trim() ||
    "A new NailIQ production update is ready for communication review.";
  const changeSummary = redactReleaseInput(rawSummary)
    .slice(0, SUMMARY_MAX_LEN)
    .trim();

  return {
    deploymentId,
    changeSummary:
      changeSummary ||
      "A new NailIQ production update is ready for communication review.",
  };
}
