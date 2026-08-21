export const GUIDED_SETUP_QA_ENABLE_CONFIRMATION =
  "ENABLE_GUIDED_ADMIN_SETUP_QA" as const;
export const GUIDED_SETUP_QA_DISABLE_CONFIRMATION =
  "DISABLE_GUIDED_ADMIN_SETUP_QA" as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GuidedSetupQaControlInput = {
  salonId: string;
  confirmedSalonId: string;
  enable: boolean;
  confirmation:
    | typeof GUIDED_SETUP_QA_ENABLE_CONFIRMATION
    | typeof GUIDED_SETUP_QA_DISABLE_CONFIRMATION;
};

export function parseGuidedSetupQaControlInput(
  value: unknown,
): GuidedSetupQaControlInput | null {
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
    ? GUIDED_SETUP_QA_ENABLE_CONFIRMATION
    : GUIDED_SETUP_QA_DISABLE_CONFIRMATION;
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

export type GuidedSetupQaControlResult =
  | { ok: true; salonId: string; enabled: boolean }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "invalid_payload"
        | "not_found"
        | "platform_disabled"
        | "allowlist_conflict"
        | "salon_not_disposable_qa"
        | "server_error";
    };
