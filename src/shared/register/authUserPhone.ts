import type { User } from "@supabase/supabase-js";
import {
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

export function phoneDigitsFromAuthUser(user: User): string {
  const meta = user.user_metadata;
  const rawMeta =
    meta && typeof meta === "object" && "nailiq_phone_digits" in meta
      ? (meta as { nailiq_phone_digits?: unknown }).nailiq_phone_digits
      : undefined;
  const fromMeta =
    typeof rawMeta === "string" ? normalizeRegisterPhone(rawMeta) : "";
  if (fromMeta && isRegisterPhoneDigitsValid(fromMeta)) {
    return fromMeta;
  }
  if (user.phone) {
    const fromPhone = normalizeRegisterPhone(user.phone);
    if (isRegisterPhoneDigitsValid(fromPhone)) return fromPhone;
  }
  return "";
}
