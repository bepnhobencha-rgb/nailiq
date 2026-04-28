/** Shared client-safe email validation (mirrors dashboard server action checks). */
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function isValidEmailFormat(raw: string): boolean {
  const s = raw.trim();
  return s.length > 0 && EMAIL_RE.test(s);
}
