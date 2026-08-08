export const OUTCOME_WINDOW_DAYS: Readonly<Record<string, number>> = {
  winback: 21,
  rebook: 14,
  first_visit: 28,
  vip_care: 30,
};

export type OutcomeResolution = "converted" | "no_conversion" | "pending";

export function outcomeDeadline(agent: string, sentAt: string): Date {
  const windowDays = OUTCOME_WINDOW_DAYS[agent] ?? 21;
  return new Date(new Date(sentAt).getTime() + windowDays * 86_400_000);
}

export function sortLatestActionFirst<T extends { created_at: string }>(
  actions: T[],
): T[] {
  return [...actions].sort((left, right) =>
    right.created_at.localeCompare(left.created_at),
  );
}

export function decideOutcomeResolution(input: {
  agent: string;
  sentAt: string;
  candidateBookingId: string | null;
  bookingAlreadyAttributed: boolean;
  now: Date;
}): OutcomeResolution {
  if (input.candidateBookingId && !input.bookingAlreadyAttributed) {
    return "converted";
  }
  return input.now >= outcomeDeadline(input.agent, input.sentAt)
    ? "no_conversion"
    : "pending";
}
