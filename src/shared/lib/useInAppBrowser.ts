"use client";

import { useSyncExternalStore } from "react";

import { isInAppBrowser } from "@/shared/lib/inAppBrowser";

const subscribe = () => () => undefined;
const getServerSnapshot = () => false;

/**
 * Hydration-safe client signal for embedded browsers. The user agent is stable
 * for the lifetime of a page, so no subscription source is required.
 */
export function useInAppBrowser(): boolean {
  return useSyncExternalStore(subscribe, isInAppBrowser, getServerSnapshot);
}
