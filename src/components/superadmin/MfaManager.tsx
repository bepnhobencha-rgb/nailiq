"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import {
  getMfaStatus,
  startMfaEnroll,
  verifyMfaEnroll,
  unenrollMfa,
} from "@/shared/superadmin/mfaActions";
import { cn } from "@/shared/lib/cn";

type Enroll = { factorId: string; qrSvg: string; secret: string };

function qrSrc(qr: string): string {
  return qr.startsWith("data:")
    ? qr
    : `data:image/svg+xml;utf8,${encodeURIComponent(qr)}`;
}

/** Enroll / disable a TOTP authenticator for the superadmin account. */
export function MfaManager() {
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<Enroll | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [pending, start] = useTransition();

  const busy = useRef(false);

  const readStatus = useCallback(async () => {
    setEnrolled(null);
    setFactorId(null);
    setStatusError(null);
    setLoadingStatus(true);
    try {
      const s = await getMfaStatus();
      if (s.ok) {
        setEnrolled(s.enrolled);
        setFactorId(s.factorId);
        if (s.enrolled) { setEnroll(null); setCode(""); }
        return s;
      }
      setStatusError(s.error === "unauthorized"
        ? "Session expired — sign in again."
        : "Could not load two-factor status. Please try again.");
    } catch {
      setStatusError("Could not load two-factor status. Please try again.");
    } finally {
      setLoadingStatus(false);
    }
    // An unknown state must not expose a possibly completed enrollment for retry.
    setEnroll(null);
    setCode("");
    return null;
  }, []);

  const refresh = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    start(async () => {
      setErr(null); setMsg(null);
      try { await readStatus(); } finally { busy.current = false; }
    });
  }, [readStatus]);

  useEffect(() => { refresh(); }, [refresh]);

  const mutate = (operation: "begin" | "confirm" | "disable") => {
    if (busy.current || pending || loadingStatus) return;
    if (operation === "confirm" && (!enroll || !/^\d{6}$/.test(code))) return;
    if (operation === "disable" && !factorId) return;
    busy.current = true;
    start(async () => {
      setErr(null); setMsg(null);
      try {
        // A rejected transport can still have completed the provider mutation.
        // Reconcile with a read below; never automatically replay a mutation.
        const r = await (operation === "begin" ? startMfaEnroll()
          : operation === "confirm" ? verifyMfaEnroll(enroll!.factorId, code)
          : unenrollMfa(factorId!)).catch(() => null);
        if (r && !r.ok && r.error === "unauthorized") {
          setEnrolled(null); setFactorId(null); setEnroll(null); setCode("");
          setStatusError("Session expired — sign in again.");
          return;
        }
        if (operation === "begin" && r?.ok && "qrSvg" in r) {
          setEnroll({ factorId: r.factorId, qrSvg: r.qrSvg, secret: r.secret });
          return;
        }
        if (operation === "confirm" && r && !r.ok && r.error === "invalid_code") {
          setErr("Invalid code. Try again."); setCode("");
          return;
        }
        const status = await readStatus();
        if (!status) return;
        if (operation === "confirm" && status.enrolled) {
          setMsg("Two-factor is now ON.");
        } else if (operation === "disable" && !status.enrolled) {
          setMsg("Two-factor disabled.");
        } else {
          setErr(`Could not confirm ${operation === "begin" ? "enrollment" : operation === "confirm" ? "verification" : "disabling two-factor"}. Please try again.`);
        }
      } finally { busy.current = false; }
    });
  };

  return (
    <div className="rounded-2xl border border-nq-border/50 bg-nq-surface/50 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-nq-foreground">
            Two-factor authentication (TOTP)
          </h2>
          <p className="mt-0.5 text-xs text-nq-muted">
            Adds a one-time code at superadmin login. Strongly recommended.
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold",
            enrolled === null
              ? "bg-nq-surface text-nq-muted"
              : enrolled
                ? "bg-nq-success/15 text-nq-success"
                : "bg-nq-warning/15 text-nq-warning",
          )}
        >
          {enrolled === null ? (loadingStatus ? "…" : "Unavailable") : enrolled ? "ON" : "OFF"}
        </span>
      </div>

      {statusError ? <p role="alert" className="mt-3 text-sm text-nq-error">{statusError}</p> : null}
      {statusError === "Session expired — sign in again." ? (
        <Link href="/superadmin/login" prefetch={false} className="mt-2 inline-flex min-h-11 items-center text-sm text-nq-primary underline">Sign in again</Link>
      ) : null}
      {statusError || loadingStatus ? (
        <Button variant="secondary" size="lg" className="mt-4" onClick={refresh} disabled={pending || loadingStatus}>
          {loadingStatus ? "Checking…" : "Try again"}
        </Button>
      ) : null}

      {msg ? <p className="mt-3 text-sm text-nq-success">{msg}</p> : null}
      {err ? (
        <p role="alert" className="mt-3 text-sm text-nq-error">
          {err}
        </p>
      ) : null}

      {/* Enrolled → offer disable */}
      {enrolled === true && !loadingStatus && !enroll ? (
        <Button variant="danger" size="lg" className="mt-4" onClick={() => mutate("disable")} disabled={pending}>
          Disable 2FA
        </Button>
      ) : null}

      {/* Not enrolled, not mid-enroll → start */}
      {enrolled === false && !loadingStatus && !enroll ? (
        <Button size="lg" className="mt-4" onClick={() => mutate("begin")} disabled={pending}>
          Enable 2FA
        </Button>
      ) : null}

      {/* Mid-enroll → QR + secret + code */}
      {enroll ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-nq-foreground">
            1. Scan this in your authenticator app:
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrSrc(enroll.qrSvg)}
            alt="TOTP QR code"
            className="h-44 w-44 rounded-lg bg-white p-2"
          />
          <p className="text-xs text-nq-muted">
            Or enter this key manually:{" "}
            <code className="break-all font-mono text-nq-foreground">
              {enroll.secret}
            </code>
          </p>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); mutate("confirm"); }}>
            <label htmlFor="mfa-enrollment-code" className="block text-sm text-nq-foreground">2. Enter the 6-digit code:</label>
            <input
              id="mfa-enrollment-code"
              autoComplete="one-time-code"
              disabled={pending}
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="000000"
              className="h-11 w-40 rounded-xl border border-nq-border bg-nq-bg text-center text-xl tracking-[0.3em] tabular-nums text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/40"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="lg" disabled={pending || code.length !== 6}>
                {pending ? "Verifying…" : "Confirm"}
              </Button>
              <Button variant="secondary" size="lg" disabled={pending} onClick={() => {
                if (busy.current) return;
                setEnroll(null); setCode(""); setErr(null);
              }}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
