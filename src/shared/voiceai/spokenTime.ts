/**
 * Spoken-time guardrail for the AI receptionist.
 *
 * A real call booked 5:30 PM after the caller clearly said "six" (transcribed
 * "six点") for a 6:00 PM slot — a model mistake that turned into a wrong
 * appointment because nothing server-side checked the time the caller actually
 * said against the time the model put in `time_slot`.
 *
 * This module parses a time out of the caller's last utterance and compares it
 * to the slot label. It is deliberately conservative: it only reports a
 * `mismatch` when it can extract a clear time that disagrees. When it cannot
 * read a time, it returns `unknown` and never guesses — the guard blocks only
 * on a positive mismatch, and the prompt handles the ask-again case.
 *
 * Pure and side-effect free so it can be unit-tested exhaustively.
 */

export type SpokenTime = {
  /** 1–12, the hour on a 12-hour clock. */
  hour12: number;
  /** Minutes 0–59, or null when the caller said only an hour ("six"). */
  minute: number | null;
  /** Explicit AM/PM if the caller said it, else null. */
  period: "am" | "pm" | null;
};

export type TimeMatch = "match" | "mismatch" | "unknown";

// Hour words → number. English one–twelve, Vietnamese một–mười hai (+ common
// diacritic-stripped spellings, since phone transcripts often drop tone marks).
const HOUR_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  // Vietnamese
  "một": 1, mot: 1, "hai": 2, "ba": 3, "bốn": 4, bon: 4, "năm": 5, nam: 5,
  "sáu": 6, sau: 6, "bảy": 7, bay: 7, "tám": 8, tam: 8, "chín": 9, chin: 9,
  "mười": 10, muoi: 10, "mười một": 11, "muoi mot": 11, "mười hai": 12, "muoi hai": 12,
};

/**
 * Extract a time from a spoken utterance, or null if none is clearly present.
 *
 * Handles: "6", "6:00", "6:30", "6 PM", "6:00 PM", "six", "six o'clock",
 * "six点", "6点", "6 giờ", "sáu giờ", and the 24-hour forms "18" / "18:00".
 * A bare number is only read as a time when a time signal is present (a colon,
 * am/pm, or a clock marker like 点 / giờ / o'clock) or the utterance is
 * essentially just that number — so a stray number in a sentence is ignored.
 */
export function parseSpokenTime(raw: string): SpokenTime | null {
  if (!raw) return null;
  const text = raw.toLowerCase();

  const period: "am" | "pm" | null =
    /\b(a\.?m\.?)\b/.test(text) ? "am" :
    /\b(p\.?m\.?)\b/.test(text) ? "pm" : null;

  // A "clock marker" that turns an adjacent number into a time.
  const hasClockMarker = /(点|o'?clock|\bgi[ờo]\b|\bgio\b)/.test(text);

  // 1) Digit form: capture "H", "H:MM", optionally followed by am/pm.
  const digit = /(?<!\d)(\d{1,2})(?::(\d{2}))?/.exec(text);
  // 2) Word form: any hour word (longest match first for "mười hai" etc.).
  const wordKey = Object.keys(HOUR_WORDS)
    .sort((a, b) => b.length - a.length)
    .find((w) => new RegExp(`(?:^|\\s)${escapeRegExp(w)}(?:\\s|$|点|o'?clock)`).test(text));

  let hour24: number | null = null;
  let minute: number | null = null;

  if (digit) {
    const h = parseInt(digit[1]!, 10);
    const hasMinutes = digit[2] != null;
    const isTime = hasMinutes || period != null || hasClockMarker || isBareNumber(text, digit[1]!);
    if (isTime && h >= 0 && h <= 23) {
      hour24 = h;
      minute = hasMinutes ? parseInt(digit[2]!, 10) : null;
    }
  }

  if (hour24 == null && wordKey) {
    hour24 = HOUR_WORDS[wordKey]!;
    minute = null; // word hours never carry minutes here
  }

  if (hour24 == null) return null;
  if (minute != null && (minute < 0 || minute > 59)) return null;

  // Normalise to a 12-hour clock; a 13–23 digit hour is implicitly PM.
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  const resolvedPeriod = period ?? (hour24 >= 13 ? "pm" : null);

  return { hour12, minute, period: resolvedPeriod };
}

/**
 * Parse a slot label like "6:00 PM" into { hour12, minute, period }. Mirrors the
 * en-US format the booking flow uses. Returns null on an unexpected shape.
 */
export function parseSlotLabel(
  label: string,
): { hour12: number; minute: number; period: "am" | "pm" } | null {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(label.trim());
  if (!m) return null;
  const hour12 = parseInt(m[1]!, 10);
  const minute = parseInt(m[2]!, 10);
  const period = m[3]!.toLowerCase() as "am" | "pm";
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;
  return { hour12, minute, period };
}

/**
 * Compare the time in the caller's utterance to the slot the model chose.
 *
 *   match    — the utterance clearly names this slot's time.
 *   mismatch — the utterance clearly names a DIFFERENT time. Block the booking.
 *   unknown  — no clear time in the utterance (or the slot is unparseable).
 *              Do not block; the prompt's read-back rule covers this.
 *
 * When the caller gives no AM/PM, comparison is on the 12-hour clock (as the
 * spec requires: "six" matches "6:00 PM" but not "5:30 PM"). When the caller
 * gives only an hour, only the hour is compared — the wrong-hour case is the
 * catastrophic one; minute ambiguity within the right hour is left to the
 * read-back rather than risking false rejections.
 */
export function compareSpokenTimeToSlot(utterance: string, slotLabel: string): TimeMatch {
  const said = parseSpokenTime(utterance);
  const slot = parseSlotLabel(slotLabel);
  if (!said || !slot) return "unknown";

  // Explicit AM/PM on both sides → compare the full 24-hour time.
  if (said.period) {
    const saidMin = to24(said.hour12, said.period) * 60 + (said.minute ?? 0);
    const slotMin = to24(slot.hour12, slot.period) * 60 + slot.minute;
    // If the caller gave only an hour, ignore the minute (compare on the hour).
    if (said.minute == null) {
      return Math.floor(saidMin / 60) === Math.floor(slotMin / 60) ? "match" : "mismatch";
    }
    return saidMin === slotMin ? "match" : "mismatch";
  }

  // No AM/PM → compare on the 12-hour clock.
  if (said.hour12 !== slot.hour12) return "mismatch";
  if (said.minute != null && said.minute !== slot.minute) return "mismatch";
  return "match";
}

function to24(hour12: number, period: "am" | "pm"): number {
  if (period === "pm") return hour12 === 12 ? 12 : hour12 + 12;
  return hour12 === 12 ? 0 : hour12;
}

/** True when, after stripping clock markers/filler, the utterance is basically
 *  just this number — so "6" alone counts as a time but "call me at ext 6" less so. */
function isBareNumber(text: string, digits: string): boolean {
  const stripped = text
    .replace(/(点|o'?clock|gi[ờo]|gio|\bam\b|\bpm\b|[.,!?])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped === digits;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
