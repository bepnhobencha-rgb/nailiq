/**
 * Basic Mode — Front Desk Cockpit logic (pure, deterministic, framework-free).
 *
 * Basic Mode is a per-device receptionist view (localStorage) layered on top
 * of the existing board — it reorganizes what's shown for fast scanning. It
 * does NOT change booking logic, status, scheduling, or any salon-level config.
 *
 * These helpers compute the deterministic Next Action and the Critical Alerts
 * from the already-loaded snapshot + booking data. No randomness, no time-of-
 * day heuristics beyond the counts the server already derived — same inputs
 * always yield the same output (Part: "Next Action card, deterministic only").
 */

export type NextActionKind =
  | "finish_overdue"
  | "assign_walkin"
  | "prepare_next";

export type NextAction = {
  kind: NextActionKind;
  /** Localized, ready-to-render text. */
  text: string;
  /** Status accent for the card. */
  tone: "danger" | "warning" | "info";
};

export type CriticalAlert = {
  key:
    | "overdue"
    | "sms_failed"
    | "party_change"
    | "long_wait"
    | "setup_incomplete";
  text: string;
  tone: "danger" | "warning";
};

/** Inputs the cockpit needs — all already computed elsewhere (no new queries). */
export type CockpitInputs = {
  waitingCount: number;
  inProgressCount: number;
  comingUpCount: number;
  overdueCount: number;
  avgWaitMinutes: number | null;
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
  finishOverdue: (n: number) => string;
  assignWalkin: (name: string) => string;
  assignWalkinGeneric: string;
  prepareNext: (n: number) => string;
  alertOverdue: (n: number) => string;
  alertSmsFailed: (n: number) => string;
  alertPartyChange: (n: number) => string;
  alertLongWait: (n: number) => string;
  alertSetupIncomplete: string;
};

const LONG_WAIT_MINUTES = 20;
const MAX_ALERTS = 2;

/**
 * Deterministic Next Action — single highest-priority operational nudge.
 * Priority (risk-first): overdue → waiting walk-in → arriving soon.
 * Returns `null` when there is no useful action (the card is hidden — an
 * "all clear" message is informational, not an action, so we don't show it).
 */
export function computeNextAction(
  i: CockpitInputs,
  labels: CockpitLabels,
): NextAction | null {
  if (i.overdueCount > 0) {
    return {
      kind: "finish_overdue",
      text: labels.finishOverdue(i.overdueCount),
      tone: "danger",
    };
  }
  if (i.waitingCount > 0) {
    return {
      kind: "assign_walkin",
      text: i.firstWaitingName
        ? labels.assignWalkin(i.firstWaitingName)
        : labels.assignWalkinGeneric,
      tone: "warning",
    };
  }
  if (i.comingUpCount > 0) {
    return {
      kind: "prepare_next",
      text: labels.prepareNext(i.comingUpCount),
      tone: "info",
    };
  }
  return null;
}

/**
 * Critical Alerts — at most 2, risk-first ordering. Never hides operational
 * risk: overdue + SMS-failed always rank above softer signals. If more than
 * two conditions hold, only the top two by severity are shown (the cap keeps
 * the basic board calm; lower-severity items remain visible in the full view).
 */
export function computeCriticalAlerts(
  i: CockpitInputs,
  labels: CockpitLabels,
): CriticalAlert[] {
  const all: CriticalAlert[] = [];

  if (i.overdueCount > 0) {
    all.push({
      key: "overdue",
      text: labels.alertOverdue(i.overdueCount),
      tone: "danger",
    });
  }
  if (i.smsFailedCount > 0) {
    all.push({
      key: "sms_failed",
      text: labels.alertSmsFailed(i.smsFailedCount),
      tone: "warning",
    });
  }
  if (i.pendingPartyChangeCount > 0) {
    all.push({
      key: "party_change",
      text: labels.alertPartyChange(i.pendingPartyChangeCount),
      tone: "warning",
    });
  }
  if (i.avgWaitMinutes !== null && i.avgWaitMinutes > LONG_WAIT_MINUTES) {
    all.push({
      key: "long_wait",
      text: labels.alertLongWait(i.avgWaitMinutes),
      tone: "warning",
    });
  }
  if (i.isSetupIncomplete) {
    all.push({
      key: "setup_incomplete",
      text: labels.alertSetupIncomplete,
      tone: "warning",
    });
  }

  return all.slice(0, MAX_ALERTS);
}
