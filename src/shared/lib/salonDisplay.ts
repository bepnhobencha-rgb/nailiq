/**
 * Resolve the user-facing salon name for headers, share text, and ICS labels.
 * Falls back to a title-cased slug ("liam-nails" → "Liam Nails") when the DB
 * `salons.name` is missing or matches the slug — those rows came from auto-
 * generated registrations where no friendly name was ever set.
 */
export function formatSalonDisplayName(args: {
  name?: string | null;
  slug: string;
}): string {
  const trimmedName = (args.name ?? "").trim();
  const slug = (args.slug ?? "").trim();
  const slugLower = slug.toLowerCase();
  if (trimmedName.length > 0 && trimmedName.toLowerCase() !== slugLower) {
    return trimmedName;
  }
  return titleCaseSlug(slugLower);
}

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
