"use client";

import { useEffect } from "react";

/**
 * Public booking is English-only; keep `html` `lang` in sync (e.g. after owner UI was `vi`).
 */
export function BookingDocumentEn() {
  useEffect(() => {
    document.documentElement.lang = "en";
  }, []);
  return null;
}
