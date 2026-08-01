"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type SuggestionResponse = {
  suggestions?: unknown;
};

const BOOKING_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function SalonSlugSuggestions() {
  const pathname = usePathname();
  const segment = pathname.split("/").filter(Boolean);
  const requestedSlug =
    segment.length === 1 &&
    segment[0].length >= 2 &&
    segment[0].length <= 63 &&
    BOOKING_SLUG.test(segment[0])
      ? segment[0]
      : null;
  const [result, setResult] = useState<{
    requestedSlug: string;
    suggestions: string[];
  } | null>(null);

  useEffect(() => {
    if (!requestedSlug) return;

    const controller = new AbortController();

    void fetch(
      `/api/public/salon-suggestions?slug=${encodeURIComponent(requestedSlug)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as SuggestionResponse;
      })
      .then((payload) => {
        if (!Array.isArray(payload?.suggestions)) return;
        setResult({
          requestedSlug,
          suggestions: payload.suggestions
            .filter(
              (value): value is string =>
                typeof value === "string" && BOOKING_SLUG.test(value),
            )
            .slice(0, 3),
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setResult({ requestedSlug, suggestions: [] });
      });

    return () => controller.abort();
  }, [requestedSlug]);

  const suggestions =
    result?.requestedSlug === requestedSlug ? result.suggestions : [];
  if (!requestedSlug || suggestions.length === 0) return null;

  return (
    <section
      aria-label="Suggested salon pages"
      className="w-full rounded-2xl border border-nq-border/60 bg-nq-surface/40 p-4"
    >
      <p className="text-sm font-medium text-nq-foreground">
        Có phải bạn muốn đến? · Did you mean?
      </p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {suggestions.map((slug) => (
          <Link
            key={slug}
            href={`/${slug}`}
            className="rounded-full border border-nq-primary/50 px-4 py-2 text-sm font-semibold text-nq-primary transition hover:bg-nq-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
          >
            /{slug}
          </Link>
        ))}
      </div>
    </section>
  );
}
