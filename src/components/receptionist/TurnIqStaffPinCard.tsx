"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { Coffee, KeyRound, LogIn, LogOut, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { TurnIqStaffShiftState } from "@/shared/turniq/readModels";
import type { TurnIqRolloutStage } from "@/shared/turniq/rolloutStage";
import type {
  TurnIqCommandActionResult,
  TurnIqConfigureStaffPinActionResult,
  TurnIqConfigureStaffPinInput,
  TurnIqPinShiftActionInput,
} from "@/shared/turniq/serverContracts";

type StaffRow = {
  staffId: string;
  staffName: string;
  state: TurnIqStaffShiftState;
};

type Props = {
  slug: string;
  language: "en" | "vi";
  rolloutStage: TurnIqRolloutStage;
  offline: boolean;
  activePolicyVersionId: string | null;
  staff: readonly StaffRow[];
  canConfigurePin: boolean;
  onConfigurePin: (
    input: TurnIqConfigureStaffPinInput,
  ) => Promise<TurnIqConfigureStaffPinActionResult>;
  onApplyPinShift: (
    input: TurnIqPinShiftActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onRefresh: () => Promise<void>;
};

type PinShiftType = TurnIqPinShiftActionInput["command"]["type"];

type RetryCommand = {
  key: string;
  input: Omit<TurnIqPinShiftActionInput, "pin">;
};

const INPUT_CLASS =
  "min-h-11 w-full rounded-xl border border-nq-border bg-nq-surface px-3 text-sm text-nq-text outline-none transition focus:border-nq-gold focus:ring-2 focus:ring-nq-gold/20 disabled:cursor-not-allowed disabled:opacity-60";

function actionFor(state: TurnIqStaffShiftState): PinShiftType | null {
  if (state === "not_checked_in" || state === "checked_out") return "check_in";
  if (state === "approved_break") return "return";
  if (state === "active") return "break";
  return null;
}

function errorCopy(code: string, vi: boolean): string {
  if (code === "invalid_pin") {
    return vi ? "Mã PIN không đúng. Chưa có thay đổi." : "Incorrect PIN. Nothing changed.";
  }
  if (code === "pin_locked") {
    return vi
      ? "PIN tạm khóa 10 phút sau nhiều lần sai. Owner/Admin có thể đặt PIN mới."
      : "PIN is locked for 10 minutes after repeated failures. Owner/Admin can rotate it.";
  }
  if (code === "rollout_stage_blocked") {
    return vi
      ? "Chế độ hiện tại chỉ quan sát; check-in bằng PIN chưa được phép."
      : "The current stage is observation-only; PIN check-in is unavailable.";
  }
  if (code === "forbidden") {
    return vi ? "Tài khoản này không có quyền." : "This account is not allowed.";
  }
  return vi
    ? "Chưa thể hoàn tất. Không có thay đổi mới nào được lưu."
    : "The action did not finish. No new change was saved.";
}

function actionCopy(type: PinShiftType, vi: boolean): string {
  if (type === "check_in") return vi ? "Vào ca" : "Check in";
  if (type === "check_out") return vi ? "Rời ca" : "Check out";
  if (type === "return") return vi ? "Quay lại" : "Return";
  return vi ? "Bắt đầu nghỉ" : "Start break";
}

function ActionIcon({ type }: { type: PinShiftType }) {
  if (type === "check_in") return <LogIn aria-hidden="true" className="size-4" />;
  if (type === "check_out") return <LogOut aria-hidden="true" className="size-4" />;
  if (type === "return") return <RotateCcw aria-hidden="true" className="size-4" />;
  return <Coffee aria-hidden="true" className="size-4" />;
}

export function TurnIqStaffPinCard({
  slug,
  language,
  rolloutStage,
  offline,
  activePolicyVersionId,
  staff,
  canConfigurePin,
  onConfigurePin,
  onApplyPinShift,
  onRefresh,
}: Props) {
  const vi = language === "vi";
  const [selectedStaffId, setSelectedStaffId] = useState(staff[0]?.staffId ?? "");
  const [pin, setPin] = useState("");
  const [breakReason, setBreakReason] = useState(vi ? "Nghỉ được duyệt" : "Approved break");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const deviceIdRef = useRef<string | null>(null);
  const localSequenceRef = useRef(0);
  const retryRef = useRef<RetryCommand | null>(null);

  const selected = useMemo(
    () => staff.find((entry) => entry.staffId === selectedStaffId) ?? staff[0] ?? null,
    [selectedStaffId, staff],
  );
  const defaultAction = selected ? actionFor(selected.state) : null;
  const actionAllowed =
    !offline &&
    (rolloutStage === "supervised" || rolloutStage === "live") &&
    activePolicyVersionId !== null &&
    defaultAction !== null;

  function nextPinShiftInput(type: PinShiftType): TurnIqPinShiftActionInput | null {
    if (!selected || !activePolicyVersionId) return null;
    const reason = type === "break" ? breakReason.trim() : "";
    const key = [selected.staffId, type, reason].join(":");
    if (retryRef.current?.key === key) {
      return { ...retryRef.current.input, pin };
    }
    deviceIdRef.current ??= crypto.randomUUID();
    localSequenceRef.current += 1;
    const input: Omit<TurnIqPinShiftActionInput, "pin"> = {
      slug,
      policyVersionId: activePolicyVersionId,
      staffId: selected.staffId,
      commandId: crypto.randomUUID(),
      deviceId: deviceIdRef.current,
      localSequence: localSequenceRef.current,
      command: type === "break" ? { type, reason } : { type },
    };
    retryRef.current = { key, input };
    return { ...input, pin };
  }

  function submitShift(type: PinShiftType) {
    const input = nextPinShiftInput(type);
    if (!input) return;
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const result = await onApplyPinShift(input);
          if (!result.ok) {
            setMessage(errorCopy(result.code, vi));
            return;
          }
          retryRef.current = null;
          setPin("");
          setMessage(
            vi
              ? `${selected?.staffName ?? "Nhân viên"}: ${actionCopy(type, true)} đã được ghi nhận an toàn.`
              : `${selected?.staffName ?? "Staff"}: ${actionCopy(type, false)} was recorded safely.`,
          );
          try {
            await onRefresh();
          } catch {
            // The committed command remains successful if refreshing the board fails.
          }
        } catch {
          setMessage(errorCopy("server_error", vi));
        }
      })();
    });
  }

  function configurePin() {
    if (!selected) return;
    const input: TurnIqConfigureStaffPinInput = {
      slug,
      staffId: selected.staffId,
      pin,
      commandId: crypto.randomUUID(),
    };
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const result = await onConfigurePin(input);
          if (!result.ok) {
            setMessage(errorCopy(result.code, vi));
            return;
          }
          setPin("");
          setMessage(
            vi
              ? `Đã đặt PIN cho ${selected.staffName}. NailIQ chỉ lưu mã băm bảo mật.`
              : `PIN set for ${selected.staffName}. NailIQ stores only a secure hash.`,
          );
        } catch {
          setMessage(errorCopy("server_error", vi));
        }
      })();
    });
  }

  if (staff.length === 0) return null;

  return (
    <Card variant="bordered" padding="md">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <KeyRound aria-hidden="true" className="size-5 text-nq-gold" />
            <h3 className="font-semibold text-nq-text">
              {vi ? "Check-in bằng PIN thợ" : "Staff PIN check-in"}
            </h3>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-nq-muted">
            {vi
              ? "Tài khoản đang đăng nhập chịu trách nhiệm cho thiết bị; PIN xác nhận đúng thợ đang thao tác. PIN không xuất hiện trong receipt."
              : "The signed-in account remains accountable for the device; the PIN identifies the acting technician. The PIN never appears on a receipt."}
          </p>
        </div>
        <Badge
          size="sm"
          variant={actionAllowed ? "success" : "neutral"}
          state="subtle"
        >
          {offline
            ? vi ? "Offline: chỉ xem" : "Offline: read-only"
            : rolloutStage === "shadow"
              ? vi ? "Shadow: chỉ quan sát" : "Shadow: observe only"
              : rolloutStage.toUpperCase()}
        </Badge>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-nq-text">
          {vi ? "Chọn thợ" : "Choose staff"}
          <select
            className={`${INPUT_CLASS} mt-1`}
            value={selected?.staffId ?? ""}
            onChange={(event) => {
              setSelectedStaffId(event.target.value);
              setPin("");
              setMessage(null);
              retryRef.current = null;
            }}
            disabled={isPending}
          >
            {staff.map((entry) => (
              <option key={entry.staffId} value={entry.staffId}>
                {entry.staffName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-nq-text">
          {vi ? "PIN 4–8 số" : "4–8 digit PIN"}
          <input
            className={`${INPUT_CLASS} mt-1 font-mono tracking-[0.35em]`}
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            minLength={4}
            maxLength={8}
            autoComplete="off"
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
            disabled={isPending}
            aria-label={vi ? "Mã PIN thợ" : "Staff PIN"}
          />
        </label>
      </div>

      {defaultAction === "break" ? (
        <label className="mt-3 block text-sm font-medium text-nq-text">
          {vi ? "Lý do nghỉ" : "Break reason"}
          <input
            className={`${INPUT_CLASS} mt-1`}
            value={breakReason}
            maxLength={500}
            onChange={(event) => setBreakReason(event.target.value)}
            disabled={isPending}
          />
        </label>
      ) : null}

      {selected?.state === "temporary_hold" ? (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">
          {vi
            ? "Thợ đang bị tạm giữ an toàn. Tiếp tân/Owner phải xem lý do trước khi mở lại."
            : "This staff member is on a safety hold. Reception/Owner must review it before release."}
        </p>
      ) : null}
      {!offline && rolloutStage === "shadow" ? (
        <p className="mt-3 text-sm text-nq-muted">
          {vi
            ? "Shadow chỉ quan sát nên không thay đổi ca. Khi salon được duyệt Supervised, nút PIN sẽ tự mở."
            : "Shadow observes only. PIN actions unlock after the salon is approved for Supervised."}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {defaultAction ? (
          <Button
            size="sm"
            variant="primary"
            loading={isPending}
            disabled={!actionAllowed || pin.length < 4 || (defaultAction === "break" && breakReason.trim().length === 0)}
            leftIcon={<ActionIcon type={defaultAction} />}
            onClick={() => submitShift(defaultAction)}
          >
            {actionCopy(defaultAction, vi)}
          </Button>
        ) : null}
        {selected?.state === "active" ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={!actionAllowed || pin.length < 4 || isPending}
            leftIcon={<ActionIcon type="check_out" />}
            onClick={() => submitShift("check_out")}
          >
            {actionCopy("check_out", vi)}
          </Button>
        ) : null}
        {canConfigurePin ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={offline || rolloutStage === "off" || pin.length < 4 || isPending}
            leftIcon={<KeyRound aria-hidden="true" className="size-4" />}
            onClick={configurePin}
          >
            {vi ? "Đặt / đổi PIN" : "Set / rotate PIN"}
          </Button>
        ) : null}
      </div>
      {message ? (
        <p role="status" className="mt-3 text-sm text-nq-muted">
          {message}
        </p>
      ) : null}
    </Card>
  );
}
