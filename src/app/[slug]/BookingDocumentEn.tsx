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
 * Defense in depth, in order of operation:
 *
 *   1. Inline `<script>` rendered server-side — runs at HTML
 *      parse time, before React mounts, so the page is tagged
 *      correctly from the very first paint.
 *   2. `useEffect` — re-asserts on mount and on lang change.
 *   3. `MutationObserver` — watches `<html lang>` for any other
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

  return (
    <script
      // Synchronous DOM update during HTML parse — closes the
      // window between root-layout `<html lang="en">` (which may
      // disagree with the server-resolved booking lang) and the
      // first React effect. `JSON.stringify` ensures the lang
      // literal can't break out of the script context.
      dangerouslySetInnerHTML={{
        __html: `try{document.documentElement.lang=${JSON.stringify(lang)};}catch(e){}`,
      }}
    />
  );
}
