import {
  DEFAULT_DASHBOARD_MODULES,
  finalizeDashboardModules,
  type DashboardModulesConfig,
} from "@/shared/dashboard/dashboardModules";

export const PRESET_KEYS = [
  "minimal",
  "reception",
  "rush_hour",
  "owner",
  "training",
  "tv",
] as const;

export type PresetKey = (typeof PRESET_KEYS)[number];

export const DEFAULT_PRESET: PresetKey = "reception";

/**
 * Per-preset module overrides, merged on top of `DEFAULT_DASHBOARD_MODULES`.
 * Keys not listed for a preset fall back to `false` (every preset spells out
 * its full module mask explicitly so the runtime is independent of any
 * future change to `DEFAULT_DASHBOARD_MODULES`).
 *
 * `queue_panel` is always `true`; `finalizeDashboardModules` re-asserts this
 * after the merge so a preset cannot accidentally disable the desk core.
 */
export const PRESET_MODULE_OVERRIDES: Record<
  PresetKey,
  Partial<DashboardModulesConfig>
> = {
  minimal: {
    queue_panel: true,
    quick_add: false,
    kpi_bar: false,
    ai_suggestions: false,
    revenue_today: false,
    wait_time: false,
    alerts: false,
    vip_indicators: false,
    staff_performance: false,
    timeline_heatmap: false,
  },
  reception: {
    queue_panel: true,
    quick_add: true,
    kpi_bar: false,
    ai_suggestions: false,
    revenue_today: false,
    wait_time: true,
    alerts: true,
    vip_indicators: false,
    staff_performance: false,
    timeline_heatmap: false,
  },
  rush_hour: {
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
  },
  owner: {
    queue_panel: true,
    quick_add: true,
    kpi_bar: true,
    ai_suggestions: true,
    revenue_today: true,
    wait_time: true,
    alerts: true,
    vip_indicators: true,
    staff_performance: true,
    timeline_heatmap: true,
  },
  training: {
    queue_panel: true,
    quick_add: true,
    kpi_bar: false,
    ai_suggestions: false,
    revenue_today: false,
    wait_time: false,
    alerts: false,
    vip_indicators: false,
    staff_performance: false,
    timeline_heatmap: false,
  },
  tv: {
    queue_panel: true,
    quick_add: false,
    kpi_bar: false,
    ai_suggestions: false,
    revenue_today: false,
    wait_time: false,
    alerts: false,
    vip_indicators: false,
    staff_performance: false,
    timeline_heatmap: false,
  },
};

export function isPresetKey(value: unknown): value is PresetKey {
  return (
    typeof value === "string" &&
    (PRESET_KEYS as readonly string[]).includes(value)
  );
}

export function parsePresetKey(value: unknown): PresetKey {
  return isPresetKey(value) ? value : DEFAULT_PRESET;
}

/**
 * Merges `PRESET_MODULE_OVERRIDES[preset]` on top of `base` defaults and
 * re-asserts the desk-core invariant via `finalizeDashboardModules`.
 */
export function applyPreset(
  preset: PresetKey,
  base: DashboardModulesConfig = DEFAULT_DASHBOARD_MODULES,
): DashboardModulesConfig {
  return finalizeDashboardModules({
    ...base,
    ...PRESET_MODULE_OVERRIDES[preset],
  });
}
