/**
 * One deployment identity for every operational endpoint.
 *
 * Vercel injects the Git SHA at build time. The deployment id is a useful
 * fallback for non-Git deployments, while the package version keeps local or
 * self-hosted builds identifiable. Avoid returning the package default
 * ("0.0.0") when a precise production commit is available.
 */
type DeploymentEnvironment = {
  VERCEL_GIT_COMMIT_SHA?: string;
  VERCEL_DEPLOYMENT_ID?: string;
  npm_package_version?: string;
};

export function deploymentIdentity(
  env: DeploymentEnvironment = process.env as DeploymentEnvironment,
): string {
  return (
    env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    env.VERCEL_DEPLOYMENT_ID?.trim() ||
    env.npm_package_version?.trim() ||
    "dev"
  );
}
