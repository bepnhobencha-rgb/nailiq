"use client";

import { useEffect } from "react";

/**
 * P0.1 — keep `<html lang>` in sync with the booking page's currently
 * rendered locale so screen readers + browser-translate behave correctly.
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
  }, [lang]);
  return null;
}
