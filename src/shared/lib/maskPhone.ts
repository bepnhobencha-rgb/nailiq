/** Last 4 digits visible: ***-***-7890 */
export function maskPhoneDigits(digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (d.length < 4) return "***-***-****";
  return `***-***-${d.slice(-4)}`;
}

/**
 * Partial mask that keeps the country + area code AND last 4 visible —
 * meant for the SuperAdmin panel where the operator (Huy) needs to
 * identify the owner more precisely than the customer-facing "last 4
 * only" mask allows.
 *
 * NANP (`+1` + 10 digits) → `+1 (XXX) ***-XXXX` (country + area + last4)
 * VN   (`+84` + 9-10 digits) → `+84 XX *** XXXX` (country + first2 + last4)
 * Other formats → fall back to `maskPhoneDigits` (last 4 only).
 *
 * Accepts either E.164 (`+16045551234`) or local digits (`6045551234`)
 * and tolerates non-digit formatting characters.
 */
export function maskPhonePartial(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";

  // Strip everything except a leading '+' and digits.
  const cleaned = raw.startsWith("+")
    ? `+${raw.slice(1).replace(/\D/g, "")}`
    : raw.replace(/\D/g, "");

  const digits = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;
  if (digits.length < 4) return "***-***-****";

  // NANP: 11 digits starting with "1", or 10 digits with no country code.
  if (digits.length === 11 && digits.startsWith("1")) {
    const area = digits.slice(1, 4);
    const last4 = digits.slice(-4);
    return `+1 (${area}) ***-${last4}`;
  }
  if (digits.length === 10) {
    const area = digits.slice(0, 3);
    const last4 = digits.slice(-4);
    return `(${area}) ***-${last4}`;
  }

  // Vietnam: +84 followed by 9 or 10 digits.
  if (digits.startsWith("84") && (digits.length === 11 || digits.length === 12)) {
    const first2 = digits.slice(2, 4);
    const last4 = digits.slice(-4);
    return `+84 ${first2} *** ${last4}`;
  }

  // Unknown format — preserve whatever country code we can see, mask
  // the middle, keep last 4. Better than collapsing to "***-***-XXXX"
  // which loses the geo hint Huy actually needs.
  if (cleaned.startsWith("+") && digits.length >= 8) {
    const cc = digits.slice(0, 2);
    const last4 = digits.slice(-4);
    return `+${cc} *** ${last4}`;
  }

  return maskPhoneDigits(digits);
}
