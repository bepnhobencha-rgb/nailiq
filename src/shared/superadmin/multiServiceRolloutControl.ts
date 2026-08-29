export const MULTI_SERVICE_ROLLOUT_ENABLE_CONFIRMATION =
  "ENABLE_MULTI_SERVICE_PRODUCTION" as const;
export const MULTI_SERVICE_ROLLOUT_DISABLE_CONFIRMATION =
  "DISABLE_MULTI_SERVICE_PRODUCTION" as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MultiServiceRolloutControlInput = {
  salonId: string;
  confirmedSalonId: string;
  enable: boolean;
  confirmation:
    | typeof MULTI_SERVICE_ROLLOUT_ENABLE_CONFIRMATION
    | typeof MULTI_SERVICE_ROLLOUT_DISABLE_CONFIRMATION;
};

export function parseMultiServiceRolloutControlInput(
  value: unknown,
): MultiServiceRolloutControlInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    "salonId",
    "confirmedSalonId",
    "enable",
    "confirmation",
  ]);
  if (
    Object.keys(raw).some((key) => !allowed.has(key)) ||
    typeof raw.salonId !== "string" ||
    typeof raw.confirmedSalonId !== "string" ||
    typeof raw.enable !== "boolean" ||
    typeof raw.confirmation !== "string"
  ) {
    return null;
  }

  const salonId = raw.salonId.trim().toLowerCase();
  const confirmedSalonId = raw.confirmedSalonId.trim().toLowerCase();
  const expected = raw.enable
    ? MULTI_SERVICE_ROLLOUT_ENABLE_CONFIRMATION
    : MULTI_SERVICE_ROLLOUT_DISABLE_CONFIRMATION;
  if (
    !UUID_RE.test(salonId) ||
    confirmedSalonId !== salonId ||
    raw.confirmation !== expected
  ) {
    return null;
  }
  return {
    salonId,
    confirmedSalonId,
    enable: raw.enable,
    confirmation: expected,
  };
}

export type MultiServiceRolloutControlResult =
  | { ok: true; salonId: string; enabled: boolean }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "invalid_payload"
        | "not_found"
        | "platform_disabled"
        | "salon_not_active"
        | "not_ready"
        | "server_error";
    };
