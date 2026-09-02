export const TURNIQ_ROLLOUT_STAGES = [
  "off",
  "shadow",
  "supervised",
  "live",
] as const;

export type TurnIqRolloutStage = (typeof TURNIQ_ROLLOUT_STAGES)[number];

const rank: Record<TurnIqRolloutStage, number> = {
  off: 0,
  shadow: 1,
  supervised: 2,
  live: 3,
};

export function parseTurnIqRolloutStage(value: unknown): TurnIqRolloutStage {
  return typeof value === "string" &&
      (TURNIQ_ROLLOUT_STAGES as readonly string[]).includes(value)
    ? (value as TurnIqRolloutStage)
    : "off";
}

export function turnIqStageAllowsRead(stage: TurnIqRolloutStage): boolean {
  return rank[stage] >= rank.shadow;
}

export function turnIqStageAllowsOnlineMutation(
  stage: TurnIqRolloutStage,
): boolean {
  return rank[stage] >= rank.supervised;
}

export function turnIqStageAllowsOfflineMutation(
  stage: TurnIqRolloutStage,
): boolean {
  return stage === "live";
}
