/**
 * Map a service name to a NailIQ `service_categories.slug` so Wix-imported services land in
 * the right Catalog group instead of all falling into "other".
 *
 * Pure + name-based (the forward sync only has the booking's service title). Validated against
 * the full Tech Nails catalog (51 services). First match wins — order matters.
 *
 * Returned slugs are the seeded global categories:
 *   manicure · pedicure · acrylic · gel · dip_powder · nail_art · removal · spa · waxing · kids · other
 */
export function categorizeService(name: string): string {
  const n = (name || "").toLowerCase();
  const has = (...words: string[]) => words.some((w) => n.includes(w));

  // Combos & base nail-care first (a "mani-pedi" reads as pedicure since it includes "pedi").
  if (has("pedi")) return "pedicure";
  if (has("manicure", "mani ", "mani-")) return "manicure";

  // Dip / SNS powder, and removals.
  if (has("powder", "dip")) return "dip_powder";
  if (has("remov", "soak off", "soak-off", "take off")) return "removal";

  // Body waxing (no nail service contains these tokens).
  if (has("wax", "eyebrow", "brow", "brazilian", "bikini", " lip", "upper lip",
          "leg", "arm", "tummy", "chest", "back", "full face", "full body"))
    return "waxing";

  // Gel / shellac. Note: a generic "...w/shellac" full set is acrylic, so only "gel" or a
  // standalone "shellac change" maps to gel here (full-set/refill is caught below as acrylic).
  if (has("gel", "shellac change")) return "gel";

  // Acrylic enhancements: full set / fill / refill / solar.
  if (has("acrylic", "solar", "full set", "fill", "refill")) return "acrylic";

  return "other";
}
