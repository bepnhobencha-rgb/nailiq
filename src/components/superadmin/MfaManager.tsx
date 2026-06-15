"use client";

import { useEffect, useState, useTransition } from "react";
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
  const [pending, start] = useTransition();

  const refresh = () =>
    start(async () => {
      const s = await getMfaStatus();
      if (s.ok) {
        setEnrolled(s.enrolled);
        setFactorId(s.factorId);
      }
    });

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginEnroll = () =>
    start(async () => {
      setErr(null);
      setMsg(null);
      const r = await startMfaEnroll();
      if (r.ok) setEnroll({ factorId: r.factorId, qrSvg: r.qrSvg, secret: r.secret });
      else setErr("Could not start enrollment.");
    });

  const confirmEnroll = () =>
    start(async () => {
      if (!enroll) return;
      setErr(null);
      const r = await verifyMfaEnroll(enroll.factorId, code);
      if (r.ok) {
        setEnroll(null);
        setCode("");
        setMsg("Two-factor is now ON.");
        refresh();
      } else {
        setErr("Invalid code. Try again.");
        setCode("");
      }
    });

  const disable = () =>
    start(async () => {
      if (!factorId) return;
      setErr(null);
      const r = await unenrollMfa(factorId);
      if (r.ok) {
        setMsg("Two-factor disabled.");
        refresh();
      } else setErr("Could not disable.");
    });

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
            enrolled
              ? "bg-nq-success/15 text-nq-success"
              : "bg-nq-warning/15 text-nq-warning",
          )}
        >
          {enrolled === null ? "…" : enrolled ? "ON" : "OFF"}
        </span>
      </div>

      {msg ? <p className="mt-3 text-sm text-nq-success">{msg}</p> : null}
      {err ? (
        <p role="alert" className="mt-3 text-sm text-nq-error">
          {err}
        </p>
      ) : null}

      {/* Enrolled → offer disable */}
      {enrolled && !enroll ? (
        <button
          type="button"
          onClick={disable}
          disabled={pending}
          className="mt-4 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-2 text-sm font-semibold text-nq-error disabled:opacity-50"
        >
          Disable 2FA
        </button>
      ) : null}

      {/* Not enrolled, not mid-enroll → start */}
      {!enrolled && !enroll ? (
        <button
          type="button"
          onClick={beginEnroll}
          disabled={pending}
          className="mt-4 rounded-xl bg-nq-primary px-4 py-2 text-sm font-semibold text-nq-bg disabled:opacity-50"
        >
          Enable 2FA
        </button>
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
          <p className="text-sm text-nq-foreground">2. Enter the 6-digit code:</p>
          <input
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) =>
              setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
            placeholder="000000"
            className="h-11 w-40 rounded-xl border border-nq-border bg-nq-bg text-center text-xl tracking-[0.3em] tabular-nums text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/40"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={confirmEnroll}
              disabled={pending || code.length !== 6}
              className="rounded-xl bg-nq-primary px-4 py-2 text-sm font-semibold text-nq-bg disabled:opacity-50"
            >
              {pending ? "Verifying…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEnroll(null);
                setCode("");
              }}
              className="rounded-xl border border-nq-border px-4 py-2 text-sm text-nq-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
