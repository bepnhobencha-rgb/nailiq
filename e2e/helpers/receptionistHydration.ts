import type { Page } from "@playwright/test";

/**
 * Wait for Receptionist Center's first client commit without mutating the
 * streamed React tree. The component publishes this window-scoped signal from
 * an effect after hydration.
 */
export async function waitForReceptionistHydration(
  page: Page,
  slug: string,
  timeout = 30_000,
): Promise<void> {
  await page.waitForFunction(
    (expectedSlug) =>
      (
        window as typeof window & {
          __NAILIQ_RECEPTIONIST_HYDRATED__?: string;
        }
      ).__NAILIQ_RECEPTIONIST_HYDRATED__ === expectedSlug,
    slug,
    { timeout },
  );
}
