"use client";

import { useEffect, useState } from "react";

import { Card } from "@/components/ui/Card";
import { TurnIqCustomerCheckInCard } from "@/components/receptionist/TurnIqCustomerCheckInCard";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type SessionTruth = {
  token: string;
  storageKey: string;
  actorSessionFingerprint: string;
  commandId?: string;
  submittedAt?: string;
};

export function TurnIqPublicCheckInClient(props: {
  salonName: string;
  channel: "qr" | "kiosk";
  visitKind: "booked" | "walkin";
  services: ReadonlyArray<{ id: string; name: string }>;
  technicians: ReadonlyArray<{ id: string; name: string }>;
  partySize: number;
}) {
  const [session, setSession] = useState<SessionTruth | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const token = (fragment.get("cap") ?? "").trim().toLowerCase();
      if (!UUID_RE.test(token)) {
        if (active) setInvalid(true);
        return;
      }
      const tokenKey = await sha256(`turniq-checkin-session-v1:${token}`);
      const storageKey = `nq-turniq-checkin:${tokenKey}`;
      let persisted: Pick<SessionTruth, "actorSessionFingerprint" | "commandId" | "submittedAt"> | null = null;
      try {
        const raw = sessionStorage.getItem(storageKey);
        const parsed = raw ? JSON.parse(raw) as Partial<SessionTruth> : null;
        if (
          parsed
          && typeof parsed.actorSessionFingerprint === "string"
          && /^[0-9a-f]{64}$/.test(parsed.actorSessionFingerprint)
        ) {
          persisted = {
            actorSessionFingerprint: parsed.actorSessionFingerprint,
            ...(typeof parsed.commandId === "string"
              && UUID_RE.test(parsed.commandId)
              && typeof parsed.submittedAt === "string"
              && Number.isFinite(Date.parse(parsed.submittedAt))
              ? { commandId: parsed.commandId, submittedAt: parsed.submittedAt }
              : {}),
          };
        }
      } catch {
        // Private browsing/storage denial falls back to an in-memory session.
      }
      if (!persisted) {
        persisted = {
          actorSessionFingerprint: await sha256(`turniq-checkin-actor-seed-v1:${crypto.randomUUID()}`),
        };
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(persisted));
        } catch {
          // The raw capability is intentionally never persisted.
        }
      }
      if (active) setSession({ token, storageKey, ...persisted });
    })().catch(() => {
      if (active) setInvalid(true);
    });
    return () => { active = false; };
  }, []);

  if (invalid) {
    return (
      <Card padding="lg" role="alert">
        <h1 className="text-xl font-semibold text-nq-foreground">Ask the front desk for a new QR / Vui lòng xin QR mới</h1>
        <p className="mt-2 text-sm text-nq-muted">This link is incomplete. No appointment or queue state changed. / Link chưa đầy đủ. Lịch hẹn và hàng chờ không thay đổi.</p>
      </Card>
    );
  }
  if (!session) {
    return <p className="text-sm text-nq-muted" role="status">Preparing secure check-in… / Đang chuẩn bị check-in an toàn…</p>;
  }
  return (
    <div className="w-full max-w-xl">
      <p className="mb-3 text-center text-sm font-medium text-nq-muted">{props.salonName}</p>
      <TurnIqCustomerCheckInCard
        channel={props.channel}
        visitKind={props.visitKind}
        services={props.services}
        technicians={props.technicians}
        actorSessionFingerprint={session.actorSessionFingerprint}
        defaultPartySize={props.partySize}
        capabilityToken={session.token}
        initialCommandId={session.commandId}
        initialSubmittedAt={session.submittedAt}
        onSubmissionPrepared={(envelope) => {
          const next = { ...session, ...envelope };
          setSession(next);
          try {
            sessionStorage.setItem(session.storageKey, JSON.stringify({
              actorSessionFingerprint: session.actorSessionFingerprint,
              ...envelope,
            }));
          } catch {
            // In-memory retry still works when browser storage is unavailable.
          }
        }}
      />
    </div>
  );
}
