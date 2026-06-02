/**
 * Map a service to a NailIQ `service_categories.slug` so Wix-imported services land in the
 * right Catalog group instead of all falling into "other".
 *
 * Pure. Name-based, with the Wix category as a hint — crucial because eyelash-extension
 * services borrow nail wording ("Full Set", "Fill", "Classic", "Volume"), so the service
 * NAME alone can't tell a lash set from an acrylic set; only the Wix category can.
 * The forward sync only has the booking title (no category) → lash sets may read as acrylic
 * until corrected; the backfill passes the category and gets it right.
 *
 * First match wins — order matters. Validated against the full Tech Nails catalog.
 * Returned slugs are seeded global categories:
 *   manicure · pedicure · acrylic · gel · dip_powder · nail_art · removal · spa · waxing · eyelashes · kids · other
 */
export function categorizeService(name: string, wixCategory?: string | null): string {
  const n = (name || "").toLowerCase();
  const wc = (wixCategory || "").toLowerCase();
  const inName = (...words: string[]) => words.some((w) => n.includes(w));
  const inCat = (...words: string[]) => words.some((w) => wc.includes(w));

  // Eyelash first — name can't distinguish it, so trust the Wix category (or an explicit "lash").
  if (inCat("lash") || inName("lash")) return "eyelashes";
  // Wix's own Waxing category is reliable.
  if (inCat("wax")) return "waxing";

  // Name-based: decisive and more precise than the category for nail services.
  if (inName("pedi")) return "pedicure"; // "mani-pedi" reads as pedicure
  if (inName("manicure", "mani ", "mani-")) return "manicure";
  if (inName("powder", "dip")) return "dip_powder";
  if (inName("remov", "soak off", "soak-off", "take off")) return "removal";
  if (inName("wax", "eyebrow", "brow", "brazilian", "bikini", " lip", "upper lip",
             "leg", "arm", "tummy", "chest", "back", "full face", "full body"))
    return "waxing";
  if (inName("gel", "shellac change")) return "gel"; // a generic full-set "w/shellac" is acrylic (below)
  if (inName("acrylic", "solar", "full set", "fill", "refill")) return "acrylic";

  // Category fallbacks when the name was inconclusive.
  if (inCat("gel", "shellac")) return "gel";
  if (inCat("solar", "acrylic")) return "acrylic";
  return "other";
}
