"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { startImpersonation } from "@/shared/superadmin/impersonationActions";

/**
 * Founder-only CTA on `/superadmin/salons/[salonId]` — opens an
 * inline dialog with a required reason field, then calls
 * `startImpersonation`. On success the action returns a redirect
 * target; we navigate via `router.replace` so the browser drops
 * the superadmin URL from history (the next "back" should land
 * the founder somewhere sensible, not a stale detail page).
 *
 * The reason input is mandatory per PERMISSION_MATRIX §8.4 audit
 * obligation. Server enforces this too — UI is just early signal.
 *
 * Visible to all superadmin roles (the server rejects non-founder
 * roles with `not_founder`). We choose to render the button + show
 * the error inline rather than hide it, so non-founder operators
 * see the surface area and learn the role boundary.
 */
export function ImpersonateButton({
  salonId,
  salonName,
}: {
  salonId: string;
  salonName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setError("Reason is required for the audit log.");
      return;
    }
    startTransition(async () => {
      const result = await startImpersonation(salonId, trimmed);
      if (!result.ok) {
        setError(errorCopy(result.error));
        return;
      }
      router.replace(result.redirectTo);
    });
  };

  return (
    <section
      data-testid="superadmin-impersonate"
      className="rounded-2xl border border-nq-error/30 bg-nq-error/5 p-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-nq-foreground">
            Login as owner
          </h2>
          <p className="mt-1 text-xs text-nq-muted">
            Founder-only. Server-side cookie swap → real owner session for{" "}
            <strong className="text-nq-foreground">{salonName}</strong>. Audit
            row written on enter + exit. 30-min hard expiry.
          </p>
        </div>
        {!open ? (
          <Button
            type="button"
            variant="danger"
            size="sm"
            data-testid="superadmin-impersonate-open"
            onClick={() => {
              setOpen(true);
              setError(null);
            }}
          >
            Start
          </Button>
        ) : null}
      </header>

      {open ? (
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-nq-muted">
              Reason (required — written to audit log)
            </span>
            <textarea
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error) setError(null);
              }}
              rows={2}
              maxLength={500}
              autoFocus
              required
              data-testid="superadmin-impersonate-reason"
              placeholder="e.g. Debugging walk-in queue 500 reported by owner via DM."
              className="block w-full rounded-lg border border-nq-border/50 bg-nq-bg/85 px-3 py-2 text-sm text-nq-foreground outline-none placeholder:text-nq-muted/70 focus-visible:border-nq-error/70"
            />
          </label>

          {error ? (
            <p role="alert" className="text-xs text-nq-error">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setReason("");
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              size="sm"
              disabled={pending}
              data-testid="superadmin-impersonate-submit"
            >
              {pending ? "Starting…" : "Login as owner"}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function errorCopy(code: string): string {
  switch (code) {
    case "not_founder":
      return "Only founder role can impersonate. Your role does not have that reach.";
    case "salon_not_found":
      return "Salon not found.";
    case "owner_not_found":
      return "No active owner on this salon. Cannot impersonate.";
    case "self_impersonation":
      return "You are already this salon's owner. No swap needed.";
    case "reason_required":
      return "Reason is required for the audit log.";
    case "session_issue_failed":
      return "Failed to issue an owner session. Check Supabase service-role key.";
    case "audit_failed":
      return "Audit log write failed. Action aborted (no swap performed).";
    case "unauthorized":
      return "You are not signed in.";
    default:
      return `Something went wrong (${code}). Try again.`;
  }
}
