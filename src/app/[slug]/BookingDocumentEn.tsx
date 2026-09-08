"use client";

import { useEffect } from "react";

/**
 * Keeps `<html lang>` in sync with the booking page's resolved
 * locale so screen readers + browser-translate behave correctly.
 *
 * Background — QA re-sweep 2026-05-12: on first load with cookie
 * `nq-booking-lang=en` the document ended up tagged `lang="vi"`
 * because the root-level `UserLanguageProvider` *also* mutates
 * `document.documentElement.lang` from a separate localStorage
 * key (`nailiq-user-lang`, default "vi") and its useEffect runs
 * AFTER ours (parent-after-child effect order). The booking
 * surface was losing the race on every initial mount; the prior
 * `setTimeout(0)` patch only fixed scenarios where the parent's
 * effect happened to complete inside the same macrotask, so it
 * was flaky.
 *
 * The request proxy now carries an explicit booking-language hint into the
 * root layout, so a hard navigation starts with the correct server-rendered
 * `<html lang>`. This component covers client navigation and then watches for
 * any competing dashboard-language mutation.
 *
 * Defense in depth:
 *
 *   1. `useEffect` — re-asserts on mount and on lang change.
 *   2. `MutationObserver` — watches `<html lang>` for any other
 *      mutation (root `UserLanguageProvider`, browser extension,
 *      third-party script) and immediately reverts to the
 *      booking-resolved value. Order-of-effects no longer
 *      matters: whoever writes last, we always have the last
 *      word.
 *
 * Component name kept (`BookingDocumentEn`) to avoid touching
 * every import site; the prop drives behavior.
 */
export function BookingDocumentEn({
  lang = "vi",
}: {
  lang?: "vi" | "en";
}) {
  useEffect(() => {
    document.documentElement.lang = lang;

    // The `if` guard prevents an infinite loop: our own revert
    // re-fires the observer, but `lang === lang` short-circuits
    // before we mutate again. Scoping the observer to the `lang`
    // attribute on `<html>` keeps it cheap — it only fires when
    // something actually touches that attribute.
    const observer = new MutationObserver(() => {
      if (document.documentElement.lang !== lang) {
        document.documentElement.lang = lang;
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["lang"],
    });

    return () => observer.disconnect();
  }, [lang]);

  return null;
}
