/**
 * Basic Mode — Front Desk Cockpit logic (pure, deterministic, framework-free).
 *
 * Basic Mode is a per-device receptionist view (localStorage) layered on top
 * of the existing board — it reorganizes what's shown for fast scanning. It
 * does NOT change booking logic, status, scheduling, or any salon-level config.
 *
 * These helpers compute the deterministic Next Action + Critical Alerts from
 * already-loaded snapshot/booking data. No randomness, no LLM, no new queries —
 * same inputs always yield the same output. Thresholds come from
 * receptionistBasicModeConfig (safe defaults, future Admin-overridable).
 */

import {
  RECEPTIONIST_BASIC_MODE_CONFIG,
  type ReceptionistBasicModeConfig,
} from "./receptionistBasicModeConfig";

/** Where a Next Action / alert button takes the receptionist. */
export type CockpitActionTarget = "open_queue" | "add_walkin" | "open_party";

export type NextActionKind =
  | "long_wait"
  | "finish_overdue"
  | "assign_waiting"
  | "prepare_next"
  | "party_pending"
  | "suggest_walkin";

export type NextAction = {
  kind: NextActionKind;
  /** Localized, ready-to-render text. */
  text: string;
  /** Status accent for the card. */
  tone: "danger" | "warning" | "info";
  /** Action button target + label; null = informational card (no button). */
  action: { target: CockpitActionTarget; label: string } | null;
};

export type CriticalAlertKey =
  | "overdue"
  | "long_wait"
  | "no_staff_for_waiting"
  | "sms_failed"
  | "party_change"
  | "setup_incomplete";

export type CriticalAlert = {
  key: CriticalAlertKey;
  text: string;
  tone: "danger" | "warning";
  /** Optional action button target; null = no button. */
  action: { target: CockpitActionTarget; label: string } | null;
};

/** Inputs the cockpit needs — all already computed elsewhere (no new queries). */
export type CockpitInputs = {
  waitingCount: number;
  inProgressCount: number;
  comingUpCount: number;
  overdueCount: number;
  /** Longest CURRENT wait among queued guests (minutes); null when queue empty. */
  longestWaitMinutes: number | null;
  /** Count of staff currently available (status === "available"). */
  availableStaffCount: number;
  /** Name of an available staff member (for Now Bar + walk-in nudge). */
  availableStaffName: string | null;
  /** Name of the first waiting walk-in (FIFO), for the assign action. */
  firstWaitingName: string | null;
  /** Count of today's bookings whose confirmation SMS failed. */
  smsFailedCount: number;
  /** Pending party/group change requests awaiting staff review. */
  pendingPartyChangeCount: number;
  isSetupIncomplete: boolean;
};

/** Localized copy — caller passes the i18n bundle so this stays pure. */
export type CockpitLabels = {
  // Next Action texts
  longWaitGuest: (n: number) => string;
  finishOverdue: (n: number) => string;
  assignWaiting: (n: number) => string;
  assignWaitingNamed: (name: string) => string;
  prepareNext: (n: number) => string;
  partyPending: (n: number) => string;
  suggestWalkin: (name: string) => string;
  // Action button labels
  actionOpenQueue: string;
  actionAddWalkin: string;
  actionOpenParty: string;
  // Critical alert texts
  alertOverdue: (n: number) => string;
  alertLongWait: (n: number) => string;
  alertNoStaffForWaiting: string;
  alertSmsFailed: (n: number) => string;
  alertPartyChange: (n: number) => string;
  alertSetupIncomplete: string;
};

/**
 * Deterministic Next Action — single highest-priority operational nudge.
 *
 * Priority (per approved 12/10 spec):
 *   1. long-wait guest         2. late/overdue booking
 *   3. waiting + available     4. upcoming within window
 *   5. pending party guests    6. available staff + no queue → suggest walk-in
 *
 * Returns null when there's no useful action (the card hides — an "all clear"
 * message is informational, not an action, so we never show one).
 */
export function computeNextAction(
  i: CockpitInputs,
  labels: CockpitLabels,
  config: ReceptionistBasicModeConfig = RECEPTIONIST_BASIC_MODE_CONFIG,
): NextAction | null {
  const openQueue = { target: "open_queue" as const, label: labels.actionOpenQueue };
  const addWalkin = { target: "add_walkin" as const, label: labels.actionAddWalkin };
  const openParty = { target: "open_party" as const, label: labels.actionOpenParty };

  // 1. Long-wait guest — highest operational risk.
  if (
    i.longestWaitMinutes !== null &&
    i.longestWaitMinutes > config.longWaitThresholdMinutes
  ) {
    return {
      kind: "long_wait",
      text: labels.longWaitGuest(i.longestWaitMinutes),
      tone: "danger",
      action: openQueue,
    };
  }

  // 2. Late / overdue booking.
  if (i.overdueCount > 0) {
    return {
      kind: "finish_overdue",
      text: labels.finishOverdue(i.overdueCount),
      tone: "danger",
      action: openQueue,
    };
  }

  // 3. Waiting guest + available staff → assign.
  if (i.waitingCount > 0) {
    return {
      kind: "assign_waiting",
      text: i.firstWaitingName
        ? labels.assignWaitingNamed(i.firstWaitingName)
        : labels.assignWaiting(i.waitingCount),
      tone: "warning",
      action: openQueue,
    };
  }

  // 4. Upcoming booking within the window — informational (no fake nav).
  if (i.comingUpCount > 0) {
    return {
      kind: "prepare_next",
      text: labels.prepareNext(i.comingUpCount),
      tone: "info",
      action: null,
    };
  }

  // 5. Pending party guests / change requests.
  if (i.pendingPartyChangeCount > 0) {
    return {
      kind: "party_pending",
      text: labels.partyPending(i.pendingPartyChangeCount),
      tone: "warning",
      action: openParty,
    };
  }

  // 6. Available staff + empty queue → suggest a walk-in.
  if (i.availableStaffName && i.waitingCount === 0) {
    return {
      kind: "suggest_walkin",
      text: labels.suggestWalkin(i.availableStaffName),
      tone: "info",
      action: addWalkin,
    };
  }

  return null;
}

export type CriticalAlertsResult = {
  /** Shown alerts (capped at config.maxBasicCriticalAlerts). */
  shown: CriticalAlert[];
  /** Count of additional alerts collapsed into the "+N more" indicator. */
  overflowCount: number;
};

/**
 * Critical Alerts — risk-first, capped at config.maxBasicCriticalAlerts.
 * Never hides operational risk: the highest-severity items win the cap, and
 * anything beyond it is surfaced as a "+N more issues" indicator (not dropped
 * silently). Returns an empty list when there's no issue (area hides).
 */
export function computeCriticalAlerts(
  i: CockpitInputs,
  labels: CockpitLabels,
  config: ReceptionistBasicModeConfig = RECEPTIONIST_BASIC_MODE_CONFIG,
): CriticalAlertsResult {
  const openQueue = { target: "open_queue" as const, label: labels.actionOpenQueue };
  const openParty = { target: "open_party" as const, label: labels.actionOpenParty };

  const all: CriticalAlert[] = [];

  if (i.overdueCount > 0) {
    all.push({
      key: "overdue",
      text: labels.alertOverdue(i.overdueCount),
      tone: "danger",
      action: openQueue,
    });
  }
  if (
    i.longestWaitMinutes !== null &&
    i.longestWaitMinutes > config.longWaitThresholdMinutes
  ) {
    all.push({
      key: "long_wait",
      text: labels.alertLongWait(i.longestWaitMinutes),
      tone: "danger",
      action: openQueue,
    });
  }
  // Waiting guests but zero available staff — a true bottleneck.
  if (i.waitingCount > 0 && i.availableStaffCount === 0) {
    all.push({
      key: "no_staff_for_waiting",
      text: labels.alertNoStaffForWaiting,
      tone: "warning",
      action: openQueue,
    });
  }
  if (i.pendingPartyChangeCount > 0) {
    all.push({
      key: "party_change",
      text: labels.alertPartyChange(i.pendingPartyChangeCount),
      tone: "warning",
      action: openParty,
    });
  }
  if (i.smsFailedCount > 0) {
    all.push({
      key: "sms_failed",
      text: labels.alertSmsFailed(i.smsFailedCount),
      tone: "warning",
      action: null,
    });
  }
  if (i.isSetupIncomplete) {
    all.push({
      key: "setup_incomplete",
      text: labels.alertSetupIncomplete,
      tone: "warning",
      action: null,
    });
  }

  const cap = config.maxBasicCriticalAlerts;
  return {
    shown: all.slice(0, cap),
    overflowCount: Math.max(0, all.length - cap),
  };
}
