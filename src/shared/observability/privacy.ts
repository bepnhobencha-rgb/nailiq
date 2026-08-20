const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?<![A-Za-z0-9])\+?\d[\d().\s-]{6,}\d(?![A-Za-z0-9])/g;
const SECRET_PAIR_RE = /\b(token|code|secret|authorization|password|otp)=([^&#\s]+)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

/** Remove customer identifiers and bearer-style values before observability data is stored or sent. */
export function redactSensitiveText(input: unknown): string {
  return String(input ?? "")
    .replace(BEARER_RE, "Bearer <redacted>")
    .replace(SECRET_PAIR_RE, "$1=<redacted>")
    .replace(UUID_RE, "<id>")
    .replace(EMAIL_RE, "<email>")
    .replace(PHONE_RE, "<phone>");
}

const SENSITIVE_KEY_RE =
  /(?:token|secret|password|authorization|cookie|phone|email|client_name|customer_name|otp|code)/i;

export function redactObservabilityValue(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 5) return "<truncated>";
  if (typeof value === "string") return redactSensitiveText(value).slice(0, 2000);
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => redactObservabilityValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 50)) {
      output[key] = SENSITIVE_KEY_RE.test(key)
        ? "<redacted>"
        : redactObservabilityValue(nested, depth + 1);
    }
    return output;
  }
  return redactSensitiveText(value);
}

export function redactObservabilityContext(
  context: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return (redactObservabilityValue(context ?? {}) ?? {}) as Record<string, unknown>;
}
