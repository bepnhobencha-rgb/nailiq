/**
 * Render a voice-session transcript for display in the Activity feed.
 *
 * The `voice_ai_sessions.transcript` column is JSONB —
 * `[{ role: "ai" | "user", text }]` — but the feed passed it through String(),
 * turning the array into "[object Object],[object Object]". This produces a
 * readable, newline-separated script instead, tolerant of every shape a stored
 * transcript can take:
 *
 *   • JSONB array of turns  → "Lily: …\nKhách: …"
 *   • legacy plain string   → shown as-is
 *   • a JSON string         → parsed, then formatted
 *   • null / malformed / unexpected values → null (never throws)
 *   • invalid array elements are skipped, not fatal
 *
 * Lives in its own module (not the "use server" action) so it can be unit-tested
 * and imported without pulling server-only code.
 */
export function formatTranscript(raw: unknown): string | null {
  if (raw == null) return null;

  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try { value = JSON.parse(trimmed); } catch { return trimmed; }
    } else {
      return trimmed;
    }
  }

  if (!Array.isArray(value)) return null;

  const lines: string[] = [];
  for (const turn of value) {
    if (!turn || typeof turn !== "object") continue;
    const t = turn as { role?: unknown; text?: unknown };
    const text = typeof t.text === "string" ? t.text.trim() : "";
    if (!text) continue;
    const who = t.role === "user" ? "Khách" : t.role === "ai" ? "Lily" : "—";
    lines.push(`${who}: ${text}`);
  }
  return lines.length ? lines.join("\n") : null;
}
