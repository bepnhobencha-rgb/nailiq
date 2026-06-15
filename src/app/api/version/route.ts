export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tiny build-identity endpoint. The dashboard refresh button polls this and,
 * when the id changes (a new deploy went out), nudges staff to hard-refresh
 * so a long-open PWA tab never runs stale code. `VERCEL_GIT_COMMIT_SHA` is set
 * by Vercel at build time; falls back to "dev" locally.
 */
export function GET() {
  const id =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.VERCEL_DEPLOYMENT_ID ??
    "dev";
  return new Response(JSON.stringify({ id }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
