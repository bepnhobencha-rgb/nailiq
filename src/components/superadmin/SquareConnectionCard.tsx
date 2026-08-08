"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { cn } from "@/shared/lib/cn";
import { connectSquareSalon } from "@/shared/superadmin/squareConnectionActions";
import {
  INITIAL_SQUARE_CONNECT_STATE,
  type SquareConnectError,
  type SquareConnectionStatus,
} from "@/shared/superadmin/squareConnectionTypes";

const ERROR_COPY: Record<SquareConnectError, string> = {
  unauthorized: "Your Superadmin session expired. Sign in again.",
  founder_required: "Only the Founder can save Square credentials.",
  mfa_required: "Complete the Superadmin MFA challenge, then try again.",
  invalid_input:
    "Check the Production Application ID, token, and ownership confirmation.",
  rate_limited: "Too many attempts. Wait 15 minutes before trying again.",
  invalid_credentials:
    "Square rejected this production token. Copy a fresh Production Access token.",
  square_unavailable:
    "Square could not be verified right now. Nothing was saved; try again later.",
  location_ambiguous:
    "This Square account does not have exactly one active location. No location was guessed or saved.",
  account_conflict:
    "This Square merchant or location is already connected to another NailIQ salon.",
  payment_provider_conflict:
    "This salon is locked to another payment provider. Review saved-card obligations before switching.",
  saved_card_conflict:
    "Future bookings still reference cards from another Square account. Resolve them before switching.",
  audit_failed: "The security audit trail could not be written, so nothing changed.",
  server_error: "Connection failed safely. Nothing was partially enabled.",
};

function SubmitButton({ connected }: { connected: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-11 items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-5 py-2.5 text-sm font-semibold text-nq-bg transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-55"
    >
      {pending
        ? "Validating with Square…"
        : connected
          ? "Validate & rotate credentials"
          : "Validate & connect Square"}
    </button>
  );
}

function Identifier({ children }: { children: string | null }) {
  return (
    <span className="break-all font-mono text-[11px] text-nq-foreground">
      {children ?? "—"}
    </span>
  );
}

export function SquareConnectionCard({
  salonId,
  salonName,
  status,
}: {
  salonId: string;
  salonName: string;
  status: SquareConnectionStatus;
}) {
  const router = useRouter();
  const [result, formAction] = useActionState(
    connectSquareSalon,
    INITIAL_SQUARE_CONNECT_STATE,
  );

  useEffect(() => {
    if (result.ok) router.refresh();
  }, [result.ok, router]);

  const dotClass = status.connected ? "bg-emerald-400" : "bg-amber-400";

  return (
    <section
      data-testid="superadmin-square-connect"
      className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span aria-hidden className={cn("h-2.5 w-2.5 rounded-full", dotClass)} />
            <h2 className="text-base font-semibold tracking-tight text-nq-foreground">
              Square Connect
            </h2>
          </div>
          <p className="mt-1 text-xs text-nq-muted">
            Server-only credential validation for {salonName}.
          </p>
        </div>
        <span
          className={cn(
            "rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide",
            status.connected
              ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
              : "border-amber-500/35 bg-amber-500/10 text-amber-300",
          )}
        >
          {status.connected ? "Connected" : "Not connected"}
        </span>
      </header>

      <dl className="mt-4 grid gap-2 rounded-xl border border-nq-border/30 bg-nq-bg/40 p-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-nq-muted">Merchant</dt>
          <dd>
            <Identifier>{status.merchantId}</Identifier>
          </dd>
        </div>
        <div>
          <dt className="text-nq-muted">Location</dt>
          <dd>
            <Identifier>{status.locationId}</Identifier>
          </dd>
        </div>
        <div>
          <dt className="text-nq-muted">Application</dt>
          <dd>
            <Identifier>{status.applicationId}</Identifier>
          </dd>
        </div>
        <div>
          <dt className="text-nq-muted">Safety mode</dt>
          <dd className="text-nq-foreground">
            {status.pushWritesEnabled ? "Square writes enabled" : "No Square writes"}
          </dd>
        </div>
      </dl>

      {status.lastError ? (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {status.lastError}
        </p>
      ) : null}

      {!status.canManage ? (
        <p className="mt-4 text-xs text-nq-muted">
          Connection status is read-only for your role. Only Founder can enter or
          rotate credentials.
        </p>
      ) : (
        <form action={formAction} className="mt-5 grid gap-4">
          <input type="hidden" name="salonId" value={salonId} />

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-nq-muted">
              Production Application ID
            </span>
            <input
              name="applicationId"
              required
              autoComplete="off"
              spellCheck={false}
              defaultValue={status.applicationId ?? ""}
              placeholder="sq0idp-…"
              className="min-h-11 w-full rounded-lg border border-nq-border/50 bg-nq-bg/85 px-3 py-2 font-mono text-sm text-nq-foreground outline-none placeholder:text-nq-muted/50 focus-visible:border-nq-primary/80"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-nq-muted">
              Production Access token
            </span>
            <input
              name="accessToken"
              type="password"
              required
              minLength={20}
              maxLength={512}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={
                status.credentialsStored
                  ? "Paste a replacement token"
                  : "Paste once — it will not be shown again"
              }
              className="min-h-11 w-full rounded-lg border border-nq-border/50 bg-nq-bg/85 px-3 py-2 font-mono text-sm text-nq-foreground outline-none placeholder:text-nq-muted/50 focus-visible:border-nq-primary/80"
            />
            <span className="text-[11px] leading-relaxed text-nq-muted">
              The token goes directly to the server, is never returned to this
              page, and is excluded from audit logs.
            </span>
          </label>

          <label className="flex items-start gap-2.5 rounded-xl border border-nq-border/35 bg-nq-bg/35 p-3 text-xs leading-relaxed text-nq-foreground">
            <input
              type="checkbox"
              name="confirmOwnership"
              value="yes"
              required
              className="mt-0.5 h-4 w-4 shrink-0 accent-nq-primary"
            />
            <span>
              I confirm this Square account belongs only to {salonName}. NailIQ
              must reject it if the merchant or location is already connected to
              another salon.
            </span>
          </label>

          <div className="rounded-xl border border-sky-500/25 bg-sky-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-sky-100">
            Validation is read-only: no payment, booking, card, customer, or
            webhook is created. New connections start with deposits and all
            Square write-sync switches OFF.
          </div>

          {result.ok === false ? (
            <p role="alert" className="text-sm text-nq-error">
              {ERROR_COPY[result.error]}
            </p>
          ) : result.ok ? (
            <div
              role="status"
              className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 text-sm text-emerald-200"
            >
              <p className="font-semibold">Square connected safely.</p>
              <p className="mt-1 text-xs">
                {result.connected.businessName ?? "Square merchant"} ·{" "}
                {result.connected.locationName} ·{" "}
                {result.connected.currency ?? "currency pending"}
              </p>
              {!result.connected.bookingSyncReady ? (
                <p className="mt-1 text-xs">
                  Square Bookings is not enabled for this location, so booking
                  sync remains OFF. Card and payment configuration is connected.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton connected={status.connected} />
            <span className="text-[11px] text-nq-muted">
              Audited · Founder only · rate-limited
            </span>
          </div>
        </form>
      )}
    </section>
  );
}
