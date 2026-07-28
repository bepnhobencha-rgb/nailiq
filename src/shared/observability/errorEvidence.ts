export type ErrorEvidenceAssessment =
  | {
      status: "consistent";
      storedRoute: string;
      contextRoute: string;
    }
  | {
      status: "conflict";
      storedRoute: string;
      contextRoute: string;
    }
  | {
      status: "insufficient";
      storedRoute: string | null;
      contextRoute: string | null;
    };

function normalizeRoute(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate, "https://nailiq.invalid");
    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return null;
    }
    return url.pathname;
  } catch {
    return null;
  }
}

/**
 * Checks whether an error row's immutable first route agrees with the latest
 * captured href in its context. Legacy fingerprints grouped identical messages
 * across routes, so those two fields can contradict one another. Such a row is
 * evidence of multiple events, not a safe input for autonomous remediation.
 */
export function assessErrorEvidence(
  route: string | null,
  context: Record<string, unknown> | null,
): ErrorEvidenceAssessment {
  const storedRoute = normalizeRoute(route);
  const contextRoute = normalizeRoute(context?.href);
  if (!storedRoute || !contextRoute) {
    return { status: "insufficient", storedRoute, contextRoute };
  }
  return {
    status: storedRoute === contextRoute ? "consistent" : "conflict",
    storedRoute,
    contextRoute,
  };
}

export function evidenceConflictSummary(
  assessment: Extract<ErrorEvidenceAssessment, { status: "conflict" }>,
): string {
  return (
    `Evidence conflict: stored route ${assessment.storedRoute} does not match ` +
    `latest context route ${assessment.contextRoute}. Automated remediation is blocked.`
  );
}
