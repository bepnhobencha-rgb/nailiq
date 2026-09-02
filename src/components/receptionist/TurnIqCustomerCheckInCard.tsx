"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  createTurnIqCustomerCheckInReceipt,
  type TurnIqCustomerCheckInInput,
  type TurnIqCustomerCheckInReceipt,
} from "@/shared/turniq/customerCheckIn";

export type TurnIqCustomerCheckInCardProps = {
  channel: "qr" | "kiosk";
  visitKind: "booked" | "walkin";
  services: ReadonlyArray<{ id: string; name: string }>;
  technicians: ReadonlyArray<{ id: string; name: string }>;
  actorSessionFingerprint: string;
  defaultPartySize?: number;
  defaultRequestedStaffId?: string | null;
  offline?: boolean;
  /** Present only on the real QR/kiosk page. The local browser harness omits
   * it and continues to exercise the pure, side-effect-free receipt builder. */
  capabilityToken?: string | null;
  initialCommandId?: string;
  initialSubmittedAt?: string;
  onSubmissionPrepared?: (envelope: { commandId: string; submittedAt: string }) => void;
};

const NEXT_ROUTE_COPY: Record<TurnIqCustomerCheckInReceipt["nextRoute"], { en: string; vi: string }> = {
  single_engine_candidate: {
    en: "NailIQ can safely check the next eligible technician.",
    vi: "NailIQ có thể kiểm tra thợ phù hợp tiếp theo một cách an toàn.",
  },
  group_optimizer_required: {
    en: "NailIQ will check the whole party together before suggesting a plan.",
    vi: "NailIQ sẽ kiểm tra cả nhóm trước khi đề xuất phương án.",
  },
  requested_tech_validation: {
    en: "Your technician request was recorded and will be checked against availability.",
    vi: "Yêu cầu chọn thợ đã được ghi nhận và sẽ được kiểm tra với lịch trống.",
  },
  identity_match_required: {
    en: "The front desk must safely match this walk-in before any booking is created.",
    vi: "Tiếp tân cần xác nhận khách walk-in trước khi tạo bất kỳ lịch hẹn nào.",
  },
};

function checkInErrorCopy(status: number, code?: string): string {
  if (code === "capability_unavailable" || status === 401) {
    return "This QR expired or was already used. Ask the front desk for a new QR. / QR đã hết hạn hoặc đã dùng. Vui lòng xin QR mới tại quầy.";
  }
  if (status === 429) {
    return "Please wait a moment before trying again. Your appointment was not changed. / Vui lòng chờ một chút rồi thử lại. Lịch hẹn chưa thay đổi.";
  }
  if (status >= 500) {
    return "NailIQ is temporarily unavailable. Show this screen to the front desk; nothing was changed. / NailIQ đang tạm gián đoạn. Hãy đưa màn hình này cho tiếp tân; chưa có gì thay đổi.";
  }
  return "Check-in was not received. No appointment changed; please ask the front desk. / Chưa nhận được check-in. Lịch hẹn không thay đổi; vui lòng hỏi tiếp tân.";
}

export function TurnIqCustomerCheckInCard({
  channel,
  visitKind,
  services,
  technicians,
  actorSessionFingerprint,
  defaultPartySize = 1,
  defaultRequestedStaffId = null,
  offline = false,
  capabilityToken = null,
  initialCommandId,
  initialSubmittedAt,
  onSubmissionPrepared,
}: TurnIqCustomerCheckInCardProps) {
  const commandIdRef = useRef<string | null>(initialCommandId ?? null);
  const submittedAtRef = useRef<string | null>(initialSubmittedAt ?? null);
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [partySize, setPartySize] = useState(defaultPartySize);
  const [requestedStaffId, setRequestedStaffId] = useState(
    defaultRequestedStaffId ?? "",
  );
  const [receipt, setReceipt] = useState<TurnIqCustomerCheckInReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [browserOffline, setBrowserOffline] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const receiptRef = useRef<HTMLElement>(null);
  const effectiveOffline = offline || browserOffline;

  useEffect(() => {
    const update = () => setBrowserOffline(typeof navigator !== "undefined" && !navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (receipt) receiptRef.current?.focus();
  }, [receipt]);

  async function submit() {
    if (effectiveOffline || !serviceId || busy) return;
    setBusy(true);
    setError("");
    try {
      commandIdRef.current ??= globalThis.crypto.randomUUID();
      submittedAtRef.current ??= new Date().toISOString();
      onSubmissionPrepared?.({
        commandId: commandIdRef.current,
        submittedAt: submittedAtRef.current,
      });
      const input: TurnIqCustomerCheckInInput = {
        commandId: commandIdRef.current,
        channel,
        visitKind,
        serviceId,
        partySize,
        submittedAt: submittedAtRef.current,
        actorSessionFingerprint,
        requestedTechnician: requestedStaffId
          ? { staffId: requestedStaffId, explicitlyConfirmed: true }
          : null,
      };
      if (capabilityToken) {
        const response = await fetch("/api/turniq/customer-checkin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capabilityToken, ...input }),
        });
        const result = await response.json().catch(() => null) as null | {
          ok?: boolean;
          error?: string;
          nextRoute?: TurnIqCustomerCheckInReceipt["nextRoute"];
          intakeFingerprint?: string;
          message?: { en?: string; vi?: string };
        };
        if (
          !response.ok
          || result?.ok !== true
          || !result.nextRoute
          || typeof result.intakeFingerprint !== "string"
        ) {
          setError(checkInErrorCopy(response.status, result?.error));
          return;
        }
        setReceipt({
          ...(await createTurnIqCustomerCheckInReceipt(input)),
          intakeFingerprint: result.intakeFingerprint,
          nextRoute: result.nextRoute,
          message: {
            en: result.message?.en ?? "Check-in received for a safe availability review.",
            vi: result.message?.vi ?? "Đã nhận check-in để kiểm tra chỗ an toàn.",
          },
        });
      } else {
        setReceipt(await createTurnIqCustomerCheckInReceipt(input));
      }
    } catch {
      setError("Connection lost. Check-in was not received; show this screen to the front desk. / Mất kết nối. Chưa nhận được check-in; hãy đưa màn hình này cho tiếp tân.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="article" padding="lg" className="text-nq-foreground">
      <p className="text-xs font-semibold uppercase tracking-wider text-nq-gold">
        TurnIQ customer check-in
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-nq-foreground">
        {visitKind === "booked" ? "I’m here for my appointment" : "Join as a walk-in"}
      </h1>
      <p className="mt-2 text-sm text-nq-muted">
        Tell us what your party needs. NailIQ checks availability without showing staff earnings or turn details.
      </p>
      <p className="mt-1 text-sm text-nq-muted">
        Cho biết dịch vụ nhóm bạn cần. NailIQ kiểm tra chỗ trống mà không hiển thị thu nhập hoặc thứ tự nội bộ của thợ.
      </p>

      <label className="mt-5 block text-sm font-medium text-nq-foreground">
        Service / Dịch vụ
        <select
          value={serviceId}
          onChange={(event) => {
            setServiceId(event.target.value);
            setReceipt(null);
            commandIdRef.current = null;
            submittedAtRef.current = null;
          }}
          className="mt-2 min-h-12 w-full rounded-xl border border-nq-border/50 bg-nq-bg px-3 text-nq-foreground"
        >
          {services.map((service) => (
            <option key={service.id} value={service.id}>{service.name}</option>
          ))}
        </select>
      </label>

      <div className="mt-4">
        <p className="text-sm font-medium text-nq-foreground">Party size / Số khách</p>
        <div className="mt-2 flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            aria-label="Decrease party size"
            disabled={partySize <= 1}
            onClick={() => {
              setPartySize((value) => Math.max(1, value - 1));
              setReceipt(null);
              commandIdRef.current = null;
              submittedAtRef.current = null;
            }}
            className="size-11 px-0 text-xl"
          >−</Button>
          <output aria-label="Party size" className="min-w-12 text-center text-2xl font-semibold text-nq-foreground">
            {partySize}
          </output>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            aria-label="Increase party size"
            disabled={partySize >= 12}
            onClick={() => {
              setPartySize((value) => Math.min(12, value + 1));
              setReceipt(null);
              commandIdRef.current = null;
              submittedAtRef.current = null;
            }}
            className="size-11 px-0 text-xl"
          >+</Button>
        </div>
      </div>

      <label className="mt-4 block text-sm font-medium text-nq-foreground">
        Requested technician / Chọn thợ <span className="font-normal text-nq-muted">(optional / không bắt buộc)</span>
        <select
          value={requestedStaffId}
          onChange={(event) => {
            setRequestedStaffId(event.target.value);
            setReceipt(null);
            commandIdRef.current = null;
            submittedAtRef.current = null;
          }}
          className="mt-2 min-h-12 w-full rounded-xl border border-nq-border/50 bg-nq-bg px-3 text-nq-foreground"
        >
          <option value="">No preference</option>
          {technicians.map((technician) => (
            <option key={technician.id} value={technician.id}>{technician.name}</option>
          ))}
        </select>
      </label>

      {effectiveOffline && (
        <p className="mt-4 rounded-xl border border-nq-warning/40 bg-nq-warning/10 p-3 text-sm text-nq-warning" role="status">
          Check-in is unavailable offline. Nothing was submitted. / Không thể check-in khi mất mạng. Chưa gửi yêu cầu nào.
        </p>
      )}
      {error && <p ref={errorRef} tabIndex={-1} className="mt-4 rounded-xl border border-nq-error/40 bg-nq-error/10 p-3 text-sm text-nq-error" role="alert">{error}</p>}

      <Button
        type="button"
        size="lg"
        fullWidth
        loading={busy}
        disabled={effectiveOffline || busy || !serviceId}
        onClick={() => void submit()}
        className="mt-5"
      >
        {receipt ? "Check again safely / Kiểm tra lại" : "Check in safely / Check-in an toàn"}
      </Button>

      {receipt && (
        <section
          ref={receiptRef}
          tabIndex={-1}
          className="mt-5 rounded-xl border border-nq-success/35 bg-nq-success/10 p-4 outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
          role="status"
          data-intake-fingerprint={receipt.intakeFingerprint}
        >
          <p className="font-semibold text-nq-success">Check-in received / Đã nhận check-in</p>
          <p className="mt-1 text-sm text-nq-foreground">{receipt.message.en}</p>
          <p className="mt-1 text-sm text-nq-muted">{receipt.message.vi}</p>
          <p className="mt-2 text-sm text-nq-foreground">{NEXT_ROUTE_COPY[receipt.nextRoute].en}</p>
          <p className="mt-1 text-sm text-nq-muted">{NEXT_ROUTE_COPY[receipt.nextRoute].vi}</p>
          <p className="mt-3 text-xs text-nq-muted">Shadow mode · no booking or assignment changed / không tạo hoặc đổi lịch hẹn</p>
        </section>
      )}
    </Card>
  );
}
