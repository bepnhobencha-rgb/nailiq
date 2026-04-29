import * as Sentry from "@sentry/nextjs";

/**
 * Tags/errors with salon identity for public booking (client + React Server Components).
 */
export function setPublicBookingSalonTags(args: {
  salonId: string;
  salonSlug: string;
  salonName?: string | null;
}) {
  const { salonId, salonSlug, salonName } = args;
  const scope = Sentry.getCurrentScope();
  scope.setTag("salon.id", salonId);
  scope.setTag("salon.slug", salonSlug);
  scope.setTag("surface", "public_booking");
  scope.setContext("salon", {
    id: salonId,
    slug: salonSlug,
    name: salonName ?? "",
  });
}
