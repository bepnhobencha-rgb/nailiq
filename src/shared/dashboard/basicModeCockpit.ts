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
export type CockpitActionTarget =
  | "open_queue"
  | "add_walkin"
  | "open_party"
  | "open_overdue";

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
  /** First overdue booking's client name + start-time label (no phone). */
  firstOverdueName: string | null;
  firstOverdueTimeLabel: string | null;
  /** Count of today's bookings whose confirmation SMS failed. */
  smsFailedCount: number;
  /**
   * Unconfirmed (unclaimed) guests in TODAY's soonest party with pending
   * guests — guests who haven't confirmed name/phone via the party link.
   */
  pendingPartyCount: number;
  /** That party's start-time label (e.g. "5:00 PM"); null when none. */
  pendingPartyGroupTime: string | null;
  /** The single unconfirmed guest's name when exactly one is pending. */
  pendingPartyGuestName: string | null;
  isSetupIncomplete: boolean;
  /** When false, the walk-in queue feature is off for this salon — the cockpit
   *  must not suggest walk-ins or surface queue actions. Defaults to enabled
   *  when omitted (backward compatible). */
  queueEnabled?: boolean;
};

/** Localized copy — caller passes the i18n bundle so this stays pure. */
export type CockpitLabels = {
  // Next Action texts
  longWaitGuest: (n: number) => string;
  finishOverdue: (n: number) => string;
  assignWaiting: (n: number) => string;
  assignWaitingNamed: (name: string) => string;
  prepareNext: (n: number) => string;
  /** "Today {time} group: {name} has not confirmed" (single pending). */
  partyPendingNamed: (time: string, name: string) => string;
  /** "Today {time} group: {n} guests pending" (multiple pending). */
  partyPendingCount: (time: string, n: number) => string;
  suggestWalkin: (name: string) => string;
  // Action button labels
  actionOpenQueue: string;
  actionAddWalkin: string;
  actionOpenParty: string;
  actionOpenBooking: string;
  // Critical alert texts
  alertOverdue: (n: number) => string;
  /** Clearer single-overdue copy with customer + time (no phone). */
  alertOverdueNamed: (name: string, time: string) => string;
  alertLongWait: (n: number) => string;
  alertNoStaffForWaiting: string;
  alertSmsFailed: (n: number) => string;
  alertSetupIncomplete: string;
};

/**
 * Maps a Next Action kind to the Critical Alert key it would DUPLICATE.
 * When that alert is already shown, the Next Action for the same issue is
 * skipped (Critical Alert wins for urgent risk — see computeNextAction).
 * null = no overlap (this action never duplicates an alert).
 */
const NEXT_ACTION_DUPLICATE_OF: Record<NextActionKind, CriticalAlertKey | null> = {
  long_wait: "long_wait",
  finish_overdue: "overdue",
  // "X waiting, assign to staff" and the "waiting but no staff" alert are the
  // same waiting situation with the same Open-queue button — dedupe it.
  assign_waiting: "no_staff_for_waiting",
  prepare_next: null,
  party_pending: "party_change",
  suggest_walkin: null,
};

/**
 * Deterministic Next Action — single highest-priority NON-DUPLICATED action.
 *
 * Priority (per approved 12/10 spec):
 *   1. long-wait guest         2. late/overdue booking
 *   3. waiting + available     4. upcoming within window
 *   5. pending party guests    6. available staff + no queue → suggest walk-in
 *
 * Dedupe rule: Critical Alerts own urgent risk. If a candidate action would
 * duplicate an already-shown Critical Alert (same issue + same button), it is
 * skipped and the next useful action is considered. Returns null when no
 * useful, non-duplicated action remains (the card hides — no "all clear").
 *
 * @param shownAlertKeys Keys of the Critical Alerts currently rendered.
 */
export function computeNextAction(
  i: CockpitInputs,
  labels: CockpitLabels,
  shownAlertKeys: CriticalAlertKey[] = [],
  config: ReceptionistBasicModeConfig = RECEPTIONIST_BASIC_MODE_CONFIG,
): NextAction | null {
  const openQueue = { target: "open_queue" as const, label: labels.actionOpenQueue };
  const addWalkin = { target: "add_walkin" as const, label: labels.actionAddWalkin };
  const openParty = { target: "open_party" as const, label: labels.actionOpenParty };
  const openBooking = { target: "open_overdue" as const, label: labels.actionOpenBooking };
  const shown = new Set(shownAlertKeys);

  // Ordered candidates (highest priority first); null entries don't apply.
  const candidates: Array<NextAction | null> = [
    i.queueEnabled !== false &&
    i.longestWaitMinutes !== null &&
    i.longestWaitMinutes > config.longWaitThresholdMinutes
      ? {
          kind: "long_wait",
          text: labels.longWaitGuest(i.longestWaitMinutes),
          tone: "danger",
          action: openQueue,
        }
      : null,
    i.overdueCount > 0
      ? {
          kind: "finish_overdue",
          text:
            i.overdueCount === 1 && i.firstOverdueName && i.firstOverdueTimeLabel
              ? labels.alertOverdueNamed(i.firstOverdueName, i.firstOverdueTimeLabel)
              : labels.finishOverdue(i.overdueCount),
          tone: "danger",
          action: openBooking,
        }
      : null,
    i.queueEnabled !== false && i.waitingCount > 0
      ? {
          kind: "assign_waiting",
          text: i.firstWaitingName
            ? labels.assignWaitingNamed(i.firstWaitingName)
            : labels.assignWaiting(i.waitingCount),
          tone: "warning",
          action: openQueue,
        }
      : null,
    i.comingUpCount > 0
      ? {
          kind: "prepare_next",
          text: labels.prepareNext(i.comingUpCount),
          tone: "info",
          action: null,
        }
      : null,
    i.pendingPartyCount > 0 && i.pendingPartyGroupTime
      ? {
          kind: "party_pending",
          text:
            i.pendingPartyCount === 1 && i.pendingPartyGuestName
              ? labels.partyPendingNamed(i.pendingPartyGroupTime, i.pendingPartyGuestName)
              : labels.partyPendingCount(i.pendingPartyGroupTime, i.pendingPartyCount),
          tone: "warning",
          action: openParty,
        }
      : null,
    i.queueEnabled !== false && i.availableStaffName && i.waitingCount === 0
      ? {
          kind: "suggest_walkin",
          text: labels.suggestWalkin(i.availableStaffName),
          tone: "info",
          action: addWalkin,
        }
      : null,
  ];

  for (const c of candidates) {
    if (!c) continue;
    const dup = NEXT_ACTION_DUPLICATE_OF[c.kind];
    if (dup && shown.has(dup)) continue; // already a Critical Alert — skip
    return c;
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
  const openBooking = { target: "open_overdue" as const, label: labels.actionOpenBooking };

  const all: CriticalAlert[] = [];

  if (i.overdueCount > 0) {
    all.push({
      key: "overdue",
      // Overdue is an in-progress desk booking (not a queue item) → its action
      // opens the booking, not the queue. Single overdue → name + time copy.
      text:
        i.overdueCount === 1 && i.firstOverdueName && i.firstOverdueTimeLabel
          ? labels.alertOverdueNamed(i.firstOverdueName, i.firstOverdueTimeLabel)
          : labels.alertOverdue(i.overdueCount),
      tone: "danger",
      action: openBooking,
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
  if (i.pendingPartyCount > 0 && i.pendingPartyGroupTime) {
    all.push({
      key: "party_change",
      text:
        i.pendingPartyCount === 1 && i.pendingPartyGuestName
          ? labels.partyPendingNamed(i.pendingPartyGroupTime, i.pendingPartyGuestName)
          : labels.partyPendingCount(i.pendingPartyGroupTime, i.pendingPartyCount),
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
