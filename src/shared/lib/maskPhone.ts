/** Last 4 digits visible: ***-***-7890 */
export function maskPhoneDigits(digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (d.length < 4) return "***-***-****";
  return `***-***-${d.slice(-4)}`;
}
