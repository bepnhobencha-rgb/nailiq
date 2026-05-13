import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Phone-OTP verify entry retired 2026-05-13. Anyone landing here directly
 * (bookmark, stale tab, in-flight SMS link) gets sent back to the unified
 * `/register` surface. OAuth and magic-link callbacks come in through
 * `/auth/callback`, not this route.
 *
 * The route file is kept so old links don't 404 — the redirect makes the
 * transition seamless for users mid-flow on the old phone path.
 */
export default function RegisterVerifyPage() {
  redirect("/register");
}
