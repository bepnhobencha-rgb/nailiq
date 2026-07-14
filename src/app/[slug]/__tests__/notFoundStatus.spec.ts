import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Regression guard for the "unknown salon returns HTTP 200" bug.
 *
 * The bug was never in the logic — `notFound()` was called, and called on the
 * right condition. It was in the PLACEMENT. `notFound()` and `redirect()` work
 * by throwing, and Next can only turn that throw into a real HTTP status while
 * the response headers are still unsent. The call sat inside a <Suspense>
 * boundary, so the shell had already streamed `200 OK` before the child
 * resolved; Next swapped in the not-found UI and left the status at 200, and
 * Google went on indexing 404s as live pages.
 *
 * A behavioural test for this lives in e2e/booking-not-found.spec.ts, but E2E
 * cannot run in CI until a dedicated test Supabase project exists (see
 * docs/audit/E2E-PRODUCTION-CONTAINMENT.md). So this suite guards the invariant
 * at the source level, where it runs on every push today.
 *
 * The invariant: the 404/redirect decision must happen in the page shell,
 * before anything is streamed — never inside the Suspense-wrapped body.
 */

const PAGE = join(process.cwd(), "src/app/[slug]/page.tsx");
const source = readFileSync(PAGE, "utf8");

/**
 * Extract the BODY of a top-level `async function <name>(...)` declaration.
 *
 * Both functions here destructure their props, so the first `{` after the name
 * belongs to the parameter list, not the body. Walk the parameter parens to
 * their match first, then take the `{` that follows — otherwise "the body" is
 * just `{ params, searchParams }`, and an assertion like "the body must not
 * call notFound()" passes for entirely the wrong reason.
 */
function functionBody(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(
    start,
    `expected src/app/[slug]/page.tsx to declare "async function ${name}("`,
  ).toBeGreaterThan(-1);

  // 1. Walk the parameter list to its closing paren.
  const paramOpen = source.indexOf("(", start);
  let parens = 0;
  let paramClose = -1;
  for (let i = paramOpen; i < source.length; i += 1) {
    if (source[i] === "(") parens += 1;
    else if (source[i] === ")") {
      parens -= 1;
      if (parens === 0) {
        paramClose = i;
        break;
      }
    }
  }
  expect(paramClose, `could not parse the parameters of ${name}`).toBeGreaterThan(-1);

  // 2. The body is the next brace-balanced block.
  const open = source.indexOf("{", paramClose);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

describe("public salon page — HTTP status for unknown slugs", () => {
  it("resolves the slug in the page shell, before anything streams", () => {
    const shell = functionBody("PublicBookingPage");
    expect(shell).toContain("await resolvePublicBookingPage(");
  });

  it("calls notFound() in the shell, where Next can still set the status", () => {
    const shell = functionBody("PublicBookingPage");
    expect(shell).toContain("notFound()");
    expect(shell).toContain("redirect(");
  });

  it("does NOT call notFound()/redirect() inside the Suspense-wrapped body", () => {
    // This is the exact regression. Moving either call back into the streamed
    // child silently restores the 200-instead-of-404 bug: the page still LOOKS
    // right in a browser, and only the status code — the part crawlers read —
    // is wrong.
    const body = functionBody("PublicBookingRouteBody");
    expect(
      body,
      "notFound() inside the Suspense child cannot set a 404: the 200 header " +
        "has already been flushed. Decide in PublicBookingPage instead.",
    ).not.toContain("notFound()");
    expect(
      body,
      "redirect() inside the Suspense child cannot emit a real 3xx for the " +
        "same reason. Decide in PublicBookingPage instead.",
    ).not.toContain("redirect(");
  });

  it("does not turn a failed lookup into a 404", () => {
    // The dangerous half of this change. loadBookingServicesForSalonSlug()
    // returns null both for "no such salon" and for "the query errored" — it
    // logs to Sentry and returns null either way. Collapsing those into a 404
    // was harmless while unknown slugs answered 200; once they answer a real
    // 404, a Supabase blip would hand Google a 404 for tech-nails and
    // hilite-anaheim, and a 404 is how a page leaves the index.
    //
    // So the resolver reports `status: "error"` for a failed lookup, and the
    // shell throws on it — a 5xx says "try again", which is the truth. Verified
    // against a production build pointed at an unreachable Supabase: a real
    // salon answers 500, not 404.
    const shell = functionBody("PublicBookingPage");
    expect(
      shell,
      'the page must handle status "error" — otherwise a database outage ' +
        "silently de-indexes every live salon",
    ).toContain('resolved.status === "error"');
    expect(shell).toContain("throw new Error(");
  });

  it("keeps the Suspense boundary (the fix must not cost the streaming skeleton)", () => {
    // resolvePublicBookingPage is React cache()d and generateMetadata already
    // awaits it, so hoisting the await costs no extra query — and the body
    // still streams while it awaits the language, page sections and service
    // categories. If someone "simplifies" by deleting the boundary, the
    // skeleton goes with it.
    expect(source).toContain("<Suspense");
    expect(source).toContain("SalonBookingSkeleton");
  });
});
