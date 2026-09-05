import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";

const WALKIN_EMAIL_MAX = 254;

export type WalkinContactInput = {
  clientPhone?: string | null;
  clientEmail?: string | null;
};

export type NormalizedWalkinContact =
  | {
      ok: true;
      phone: string | null;
      email: string | null;
      hasContact: boolean;
    }
  | { ok: false; error: "invalid_phone" | "invalid_email" };

/**
 * Walk-ins may be added while the customer remains at the counter, so contact
 * details are optional. When staff do collect them, normalize them once at the
 * trusted server boundary. This deliberately does not create/link a global
 * client profile and does not manufacture SMS consent from staff-entered data.
 */
export function normalizeWalkinContact(
  input: WalkinContactInput,
): NormalizedWalkinContact {
  const phoneRaw = String(input.clientPhone ?? "").trim();
  let phone: string | null = null;
  if (phoneRaw) {
    const phoneResult = validateGuestPhone(phoneRaw);
    if (!phoneResult.ok) return { ok: false, error: "invalid_phone" };
    phone = phoneResult.digits;
  }

  const emailRaw = String(input.clientEmail ?? "").trim().toLowerCase();
  if (
    emailRaw &&
    (emailRaw.length > WALKIN_EMAIL_MAX || !isValidEmailFormat(emailRaw))
  ) {
    return { ok: false, error: "invalid_email" };
  }
  const email = emailRaw || null;

  return { ok: true, phone, email, hasContact: Boolean(phone || email) };
}
