"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { loadGroupSlotRecovery, startGroupReplacement, revokeGroupReplacement } from "@/shared/booking/groupSlotRecoveryActions";
import { groupRecoveryRequestId, groupRecoveryTime } from "@/shared/booking/groupRecoveryPresentation";
import { groupRecoveryError, groupRecoveryMessages, type GroupRecoveryLanguage } from "@/shared/i18n/booking/groupRecovery";

type Recovery = Awaited<ReturnType<typeof loadGroupSlotRecovery>>;
type RecoveryState = "available" | "pending" | "accepted" | "unavailable";

type Props = {
  token: string;
  language?: GroupRecoveryLanguage;
  onStatusChange?: (state: RecoveryState) => void;
};

/** The member capability authorizes this flow; a shared party token does not. */
export function GroupReplacementOptions(props: Props) {
  return <GroupReplacementOptionsForToken key={`${props.token}:${props.language ?? "en"}`} {...props} />;
}

function GroupReplacementOptionsForToken({ token, language = "en", onStatusChange }: Props) {
  const t = groupRecoveryMessages(language);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [busy, setBusy] = useState(true);
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "fallback">("idle");
  const inFlight = useRef(false);
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await loadGroupSlotRecovery(token);
      setRecovery(result);
      if (result.ok) {
        onStatusChangeRef.current?.(result.state);
        if (result.state !== "pending") setUrl(null);
        setExpiresAt(result.expiresAt);
      } else setError(groupRecoveryError(result.code, language));
    } catch {
      setError(groupRecoveryMessages(language).senderError);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [language, token]);

  useEffect(() => {
    let alive = true;
    loadGroupSlotRecovery(token).then(result => {
      if (!alive) return;
      setRecovery(result);
      if (result.ok) {
        onStatusChangeRef.current?.(result.state);
        setExpiresAt(result.expiresAt);
      } else setError(groupRecoveryError(result.code, language));
      setBusy(false);
    }).catch(() => {
      if (!alive) return;
      setError(groupRecoveryMessages(language).senderError);
      setBusy(false);
    });
    return () => { alive = false; };
  }, [language, token]);

  async function create() {
    if (inFlight.current || !recovery?.ok || !recovery.eligible) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const requestId = await groupRecoveryRequestId(token, "start");
      const result = await startGroupReplacement({ cancelToken: token, requestId });
      if (!result.ok) {
        setError(groupRecoveryError(result.code, language));
        if (result.code === "request_expired") {
          await groupRecoveryRequestId(token, "start", true);
          setUrl(null);
          setExpiresAt(null);
          setRecovery({ ...recovery, state: "available" });
        }
        return;
      }
      setRevoked(false);
      if (!/^[a-f0-9]{64}$/.test(result.token)) { setError(t.senderError); return; }
      const link = new URL("/booking/replace", window.location.origin);
      link.searchParams.set("token", result.token);
      link.searchParams.set("lang", language);
      setUrl(link.toString());
      setExpiresAt(result.expiresAt);
      setCopyState("idle");
      setRecovery({ ...recovery, state: "pending", expiresAt: result.expiresAt });
      onStatusChangeRef.current?.("pending");
    } catch { setError(t.senderError); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function revoke() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const requestId = await groupRecoveryRequestId(token, "revoke");
      const result = await revokeGroupReplacement({ cancelToken: token, requestId });
      if (!result.ok) { setError(groupRecoveryError(result.code, language)); return; }
      setUrl(null);
      setExpiresAt(null);
      await groupRecoveryRequestId(token, "start", true);
      await groupRecoveryRequestId(token, "revoke", true);
      setRevoked(true);
      if (recovery?.ok) setRecovery({ ...recovery, state: "available", eligible: true });
      onStatusChangeRef.current?.("available");
    } catch { setError(t.senderError); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function copy() {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopyState("copied"); }
    catch { setCopyState("fallback"); }
  }

  if (recovery?.ok && recovery.state === "unavailable" && ["feature_disabled", "not_group_member", "not_member", "not_group", "disabled"].includes(recovery.reason ?? "")) return null;
  if (recovery && !recovery.ok && ["feature_disabled", "invalid_input", "unavailable"].includes(recovery.code)) return null;
  if (!recovery && busy) return <p role="status" className="text-sm text-nq-muted">{t.loading}</p>;
  const completed = recovery?.ok && recovery.state === "accepted";
  const pending = recovery?.ok && recovery.state === "pending";
  const eligible = recovery?.ok && recovery.eligible;
  return (
    <Card padding="md" className="text-left" data-testid="group-replacement-options">
      <h2 className="text-lg font-semibold">{completed ? t.complete : pending ? t.pending : t.senderTitle}</h2>
      <p className="mt-2 text-sm text-nq-muted">{revoked ? t.revoked : completed ? t.completeBody : t.senderIntro}</p>
      {!completed && <p className="mt-3 text-sm text-nq-muted">{t.senderRule}</p>}
      {recovery?.ok && !eligible && !completed && <p className="mt-3 text-sm text-nq-muted">{recovery.reason?.includes("card") ? t.cardRequired : t.noReplacement}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-nq-error">{error}</p>}
      {url && pending && (
        <div className="mt-4 space-y-3">
          <label className="block space-y-2 text-sm"><span>{t.linkLabel}</span><Input readOnly value={url} onFocus={event => event.target.select()} /></label>
          <Button size="lg" variant="secondary" fullWidth onClick={() => void copy()}>{copyState === "copied" ? t.copied : t.copy}</Button>
          {copyState === "fallback" && <p role="status" className="text-sm text-nq-muted">{t.copyFallback}</p>}
          <p className="text-sm text-nq-muted">{t.shareHint}</p>
        </div>
      )}
      {expiresAt && recovery?.ok && !completed && <p className="mt-3 text-xs text-nq-muted">{t.expires}: {groupRecoveryTime(expiresAt, recovery.timezone, language)} ({recovery.timezone})</p>}
      {!completed && <div className="mt-4 flex flex-col gap-3">
        {eligible && !url && <Button size="lg" fullWidth loading={busy} onClick={() => void create()}>{pending ? t.recoverLink : t.create}</Button>}
        {pending && <Button size="lg" variant="secondary" fullWidth disabled={busy} onClick={() => void revoke()}>{t.revoke}</Button>}
        <Button size="lg" variant="ghost" fullWidth disabled={busy} onClick={() => void refresh()}>{t.refresh}</Button>
      </div>}
    </Card>
  );
}
