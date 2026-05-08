/**
 * Receptionist center module flags stored on `salons.dashboard_modules`.
 * Keys are stable for API / persistence; labels live in user i18n.
 */

export const DASHBOARD_MODULE_KEYS = [
  "queue_panel",
  "quick_add",
  "kpi_bar",
  "ai_suggestions",
  "revenue_today",
  "wait_time",
  "alerts",
  "vip_indicators",
  "staff_performance",
  "timeline_heatmap",
] as const;

export type DashboardModuleKey = (typeof DASHBOARD_MODULE_KEYS)[number];

export type DashboardModulesConfig = Record<DashboardModuleKey, boolean>;

export const DEFAULT_DASHBOARD_MODULES: DashboardModulesConfig = {
  queue_panel: true,
  quick_add: true,
  kpi_bar: true,
  ai_suggestions: false,
  revenue_today: false,
  wait_time: true,
  alerts: true,
  vip_indicators: true,
  staff_performance: false,
  timeline_heatmap: false,
};

/** Keys owners can toggle in settings (core queue is always on; see `finalizeDashboardModules`). */
export const DASHBOARD_MODULE_OWNER_TOGGLES: DashboardModuleKey[] =
  DASHBOARD_MODULE_KEYS.filter((k) => k !== "queue_panel");

export function parseDashboardModules(raw: unknown): DashboardModulesConfig {
  const out: DashboardModulesConfig = { ...DEFAULT_DASHBOARD_MODULES };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return finalizeDashboardModules(out);
  }
  const o = raw as Record<string, unknown>;
  for (const key of DASHBOARD_MODULE_KEYS) {
    const v = o[key];
    if (typeof v === "boolean") {
      out[key] = v;
    }
  }
  return finalizeDashboardModules(out);
}

/** Enforce non-disablable desk core (walk-in queue column). */
export function finalizeDashboardModules(
  m: DashboardModulesConfig,
): DashboardModulesConfig {
  return { ...m, queue_panel: true };
}

/**
 * Owner-toggle PATCH body: only `DASHBOARD_MODULE_OWNER_TOGGLES` keys allowed;
 * values must be boolean. Unknown or non-boolean keys → invalid.
 */
export function validateOwnerDashboardModulePatch(
  input: unknown,
): { ok: true; patch: Partial<DashboardModulesConfig> } | { ok: false } {
  if (input == null) return { ok: true, patch: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false };

  const o = input as Record<string, unknown>;
  const allowed = new Set<string>(DASHBOARD_MODULE_OWNER_TOGGLES);
  const patch: Partial<DashboardModulesConfig> = {};

  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) return { ok: false };
    const v = o[key];
    if (typeof v !== "boolean") return { ok: false };
    patch[key as DashboardModuleKey] = v;
  }

  return { ok: true, patch };
}
