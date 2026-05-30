/**
 * Receptionist Basic Mode — centralized config with safe defaults.
 *
 * Basic Mode is the "Front Desk Cockpit" view. Per the architecture rule, no
 * salon-specific thresholds/copy/behavior are hardcoded inside components —
 * they live here so a later Admin Advanced Settings surface can override them
 * per salon without touching the UI. For now these are conservative platform
 * defaults.
 *
 * Pure data — no DB, no salon coupling. Display/behavior tuning only.
 */

export type ReceptionistBasicModeConfig = {
  /** "Upcoming" window for the Now Bar / Next Action (minutes). */
  upcomingWindowMinutes: number;
  /** A waiting guest beyond this many minutes is a long-wait risk. */
  longWaitThresholdMinutes: number;
  /** Hard cap on Now Bar cards. */
  maxBasicKpiCards: number;
  /** Hard cap on simultaneously-shown Critical Alerts (rest collapse to +N). */
  maxBasicCriticalAlerts: number;
  /** Revenue tile is never shown in Basic Mode. */
  showRevenueInBasic: boolean;
  /** Party strip visibility policy in Basic Mode. */
  showPartyStripInBasic: "actionable_only" | "always" | "never";
  /** Hide owner/marketing/config sidebar items in Basic Mode. */
  hideAdvancedSidebarItemsInBasic: boolean;
  /** Render the deterministic Next Action card. */
  showNextActionInBasic: boolean;
  /** Render the Critical Alerts area (when issues exist). */
  showCriticalAlertsInBasic: boolean;
  /** Per-device customization of optional comfort sections. Deferred for now. */
  allowBasicViewCustomization: boolean;
  /** Booking-block comfort tier for Basic Mode. */
  basicBookingBlockComfort: "compact" | "comfortable";
};

export const RECEPTIONIST_BASIC_MODE_CONFIG: ReceptionistBasicModeConfig = {
  upcomingWindowMinutes: 30,
  longWaitThresholdMinutes: 10,
  maxBasicKpiCards: 4,
  maxBasicCriticalAlerts: 2,
  showRevenueInBasic: false,
  showPartyStripInBasic: "actionable_only",
  hideAdvancedSidebarItemsInBasic: true,
  showNextActionInBasic: true,
  showCriticalAlertsInBasic: true,
  allowBasicViewCustomization: false,
  basicBookingBlockComfort: "comfortable",
};
