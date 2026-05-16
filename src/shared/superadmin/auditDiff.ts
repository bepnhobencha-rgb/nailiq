/**
 * Audit-log diff formatter.
 *
 * Splits a (before, after) pair of jsonb blobs into three buckets the
 * UI can render with distinct colour accents:
 *
 *   - onlyBefore: keys removed in the after state
 *   - changed:    keys present in both with different values
 *   - onlyAfter:  keys added in the after state
 *
 * Comparison is shallow — both blobs are flat-ish records produced by
 * the audit writers in `audit.ts`. Nested object values are
 * stringified via JSON.stringify for the change check; if a row ever
 * carries deeply-nested state, this still works (just compares at the
 * top level).
 */

export type AuditDiff = {
  onlyBefore: Array<{ key: string; value: unknown }>;
  changed: Array<{ key: string; before: unknown; after: unknown }>;
  onlyAfter: Array<{ key: string; value: unknown }>;
};

function stableStringify(v: unknown): string {
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function formatJsonbDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): AuditDiff {
  const b = before ?? {};
  const a = after ?? {};
  const bKeys = new Set(Object.keys(b));
  const aKeys = new Set(Object.keys(a));

  const onlyBefore: AuditDiff["onlyBefore"] = [];
  const changed: AuditDiff["changed"] = [];
  const onlyAfter: AuditDiff["onlyAfter"] = [];

  for (const key of bKeys) {
    if (!aKeys.has(key)) {
      onlyBefore.push({ key, value: b[key] });
    } else if (stableStringify(b[key]) !== stableStringify(a[key])) {
      changed.push({ key, before: b[key], after: a[key] });
    }
  }
  for (const key of aKeys) {
    if (!bKeys.has(key)) {
      onlyAfter.push({ key, value: a[key] });
    }
  }

  // Stable ordering — alphabetical, so the same diff renders the same
  // way regardless of input key order.
  onlyBefore.sort((x, y) => x.key.localeCompare(y.key));
  changed.sort((x, y) => x.key.localeCompare(y.key));
  onlyAfter.sort((x, y) => x.key.localeCompare(y.key));

  return { onlyBefore, changed, onlyAfter };
}

export function renderValueForDiff(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
