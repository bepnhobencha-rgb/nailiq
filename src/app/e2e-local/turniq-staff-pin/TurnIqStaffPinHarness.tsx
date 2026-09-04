"use client";

import { useState } from "react";

import { TurnIqStaffPinCard } from "@/components/receptionist/TurnIqStaffPinCard";
import type { TurnIqStaffShiftState } from "@/shared/turniq/readModels";
import type {
  TurnIqConfigureStaffPinActionResult,
  TurnIqConfigureStaffPinInput,
  TurnIqPinShiftActionInput,
  TurnIqCommandActionResult,
} from "@/shared/turniq/serverContracts";

const POLICY_ID = "4e59f213-69b4-42bb-9e6c-caf561d40b29";

const INITIAL_STAFF = Array.from({ length: 12 }, (_, index) => ({
  staffId: `72000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  staffName: `QA Tech ${String(index + 1).padStart(2, "0")}`,
  state: "not_checked_in" as TurnIqStaffShiftState,
  queuePosition: null as number | null,
}));

export function TurnIqStaffPinHarness() {
  const [staff, setStaff] = useState(INITIAL_STAFF);
  const [attemptIds, setAttemptIds] = useState<string[]>([]);
  const [failedOnce, setFailedOnce] = useState(false);

  async function configure(
    input: TurnIqConfigureStaffPinInput,
  ): Promise<TurnIqConfigureStaffPinActionResult> {
    return {
      ok: true,
      result: {
        commandId: input.commandId,
        replayed: false,
        staffId: input.staffId,
        pinVersion: 1,
        configuredAt: new Date().toISOString(),
      },
    };
  }

  async function applyShift(
    input: TurnIqPinShiftActionInput,
  ): Promise<TurnIqCommandActionResult> {
    setAttemptIds((current) => [...current, input.commandId]);
    if (input.pin !== "2468") return { ok: false, code: "invalid_pin" };
    if (!failedOnce) {
      setFailedOnce(true);
      throw new Error("synthetic response loss");
    }
    const nextState: TurnIqStaffShiftState =
      input.command.type === "check_in"
        ? "active"
        : input.command.type === "break"
          ? "approved_break"
          : input.command.type === "return"
            ? "active"
            : "checked_out";
    setStaff((current) => {
      const nextQueuePosition =
        current.reduce(
          (max, entry) => Math.max(max, entry.queuePosition ?? 0),
          0,
        ) + 1;
      return current.map((entry) =>
        entry.staffId === input.staffId
          ? {
              ...entry,
              state: nextState,
              queuePosition:
                input.command.type === "check_in"
                  ? nextQueuePosition
                  : entry.queuePosition,
            }
          : entry,
      );
    });
    return {
      ok: true,
      result: {
        commandId: input.commandId,
        replayed: attemptIds.includes(input.commandId),
        aggregateId: "72000000-0000-4000-8000-000000000307",
        status: nextState,
        stateVersion: attemptIds.length + 1,
        fairnessReceiptId: null,
      },
    };
  }

  const lastTwoMatch =
    attemptIds.length >= 2 && attemptIds.at(-1) === attemptIds.at(-2);

  return (
    <main className="min-h-screen bg-nq-bg p-4 sm:p-8">
      <TurnIqStaffPinCard
        slug="turniq-tech-nails-qa-copy"
        language="vi"
        rolloutStage="supervised"
        offline={false}
        activePolicyVersionId={POLICY_ID}
        staff={staff}
        canConfigurePin
        onConfigurePin={configure}
        onApplyPinShift={applyShift}
        onRefresh={async () => undefined}
      />
      <output data-testid="turniq-pin-attempt-count">
        {attemptIds.length}
      </output>
      <output data-testid="turniq-pin-retry-idempotent">
        {lastTwoMatch ? "same-command-id" : "pending"}
      </output>
      <ol
        aria-label="Thứ tự vào ca TurnIQ"
        data-testid="turniq-pin-queue-order"
      >
        {staff
          .filter((entry) => entry.queuePosition !== null)
          .toSorted((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
          .map((entry) => (
            <li
              key={entry.staffId}
              data-testid={`turniq-pin-staff-${entry.staffName.slice(-2)}`}
              data-state={entry.state}
              data-queue-position={entry.queuePosition ?? undefined}
            >
              {entry.queuePosition}. {entry.staffName} — {entry.state}
            </li>
          ))}
      </ol>
    </main>
  );
}
