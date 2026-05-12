"use client";

import { useEffect } from "react";

/**
 * Keeps `<html lang>` in sync with the booking page's resolved
 * locale so screen readers + browser-translate behave correctly.
 *
 * QA re-sweep 2026-05-12: on first load with cookie
 * `nq-booking-lang=en` the document ended up tagged as `lang="vi"`
 * because the root-level `UserLanguageProvider` *also* mutates
 * `document.documentElement.lang` from a separate localStorage
 * key (`nailiq-user-lang`, default "vi") and its useEffect runs
 * AFTER ours (parent-after-child effect order). The booking
 * surface was effectively losing the race every initial mount.
 *
 * Fix layers (defense in depth):
 *
 *   1. Inline `<script>` rendered server-side — runs at HTML parse
 *      time, before React loads, so the page is tagged correctly
 *      from the first paint.
 *   2. `useEffect` re-assert — handles client-side lang changes
 *      (toggle click → router.refresh).
 *   3. `setTimeout(0)` re-assert inside the same effect — fires
 *      after every other current-tick `useEffect`, so we
 *      definitively beat `UserLanguageProvider`'s parent effect.
 *
 * Component name kept (`BookingDocumentEn`) to avoid touching every
 * import site; the prop drives behavior.
 */
export function BookingDocumentEn({
  lang = "vi",
}: {
  lang?: "vi" | "en";
}) {
  useEffect(() => {
    document.documentElement.lang = lang;
    // Defer one tick past parent useEffects (UserLanguageProvider
    // at the root sets lang from its own state, which may still be
    // the "vi" SSR default at this point).
    const t = setTimeout(() => {
      document.documentElement.lang = lang;
    }, 0);
    return () => clearTimeout(t);
  }, [lang]);

  return (
    <script
      // Synchronous DOM update during HTML parse — closes the
      // window between root-layout `<html lang="en">` (which our
      // server-resolved booking lang might disagree with) and the
      // first React effect. Safe `JSON.stringify` ensures the lang
      // literal can't break out of the script context.
      dangerouslySetInnerHTML={{
        __html: `try{document.documentElement.lang=${JSON.stringify(lang)};}catch(e){}`,
      }}
    />
  );
}
