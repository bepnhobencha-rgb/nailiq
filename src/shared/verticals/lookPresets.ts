/**
 * Look presets — one-click "designed looks" for the public booking page.
 *
 * A preset bundles imagery + brand colour + light/dark theme. Applying one
 * (see `applyLookPreset`) just writes `salons.brand_color`, `salons.theme_mode`
 * and `salons.booking_images` — the booking page already reads those, so the
 * whole page (branded canvas tint, accents, hero/ambient photos, light/dark)
 * transforms at once. No new render logic.
 *
 * Presets are grouped by vertical so a head spa only ever sees spa looks.
 * Images are verified Unsplash base URLs (no params; the page appends sizing).
 * An owner can still pick "use my own photos" (custom booking_images override).
 */

const U = (id: string) => `https://images.unsplash.com/photo-${id}`;

export type LookPreset = {
  id: string;
  vertical: string;
  name: { en: string; vi: string };
  brandColor: string; // #RRGGBB
  themeMode: "light" | "dark";
  imagery: { hero: string; thumbA: string; thumbB: string };
};

const HEAD_SPA_PRESETS: LookPreset[] = [
  {
    id: "serene-light",
    vertical: "head_spa",
    name: { en: "Serene Light", vi: "Dịu sáng" },
    brandColor: "#C2A14E",
    themeMode: "light",
    imagery: {
      hero: U("1540555700478-4be289fbecef"),
      thumbA: U("1556228578-8c89e6adf883"),
      thumbB: U("1583416750470-965b2707b355"),
    },
  },
  {
    id: "spa-calm",
    vertical: "head_spa",
    name: { en: "Spa Calm", vi: "Thư thái" },
    brandColor: "#6E8B82",
    themeMode: "light",
    imagery: {
      hero: U("1600334089648-b0d9d3028eb2"),
      thumbA: U("1519823551278-64ac92734fb1"),
      thumbB: U("1596178065887-1198b6148b2b"),
    },
  },
  {
    id: "midnight-spa",
    vertical: "head_spa",
    name: { en: "Midnight Spa", vi: "Sang trọng tối" },
    brandColor: "#D4AF37",
    themeMode: "dark",
    imagery: {
      hero: U("1512290923902-8a9f81dc236c"),
      thumbA: U("1570172619644-dfd03ed5d881"),
      thumbB: U("1633681926022-84c23e8cb2d6"),
    },
  },
];

const NAIL_IMAGERY = {
  hero: U("1610992015732-2449b76344bc"),
  thumbA: U("1604654894610-df63bc536371"),
  thumbB: U("1522337360788-8b13dee7a37e"),
};

const NAIL_SALON_PRESETS: LookPreset[] = [
  {
    id: "classic-gold",
    vertical: "nail_salon",
    name: { en: "Classic Gold", vi: "Vàng cổ điển" },
    brandColor: "#D4AF37",
    themeMode: "dark",
    imagery: NAIL_IMAGERY,
  },
  {
    id: "clean-light",
    vertical: "nail_salon",
    name: { en: "Clean Light", vi: "Trắng tinh" },
    brandColor: "#1A1A1A",
    themeMode: "light",
    imagery: NAIL_IMAGERY,
  },
  {
    id: "blossom-pink",
    vertical: "nail_salon",
    name: { en: "Blossom Pink", vi: "Hồng nhẹ" },
    brandColor: "#E91E8C",
    themeMode: "light",
    imagery: NAIL_IMAGERY,
  },
];

const ALL_PRESETS: LookPreset[] = [...HEAD_SPA_PRESETS, ...NAIL_SALON_PRESETS];

/** Presets offered for a salon's vertical (falls back to nail_salon). */
export function getLookPresetsForVertical(vertical?: string | null): LookPreset[] {
  const v = typeof vertical === "string" ? vertical.trim().toLowerCase() : "";
  const list = ALL_PRESETS.filter((p) => p.vertical === v);
  return list.length > 0 ? list : NAIL_SALON_PRESETS;
}

/** Look up a preset by id, scoped to a vertical (so a head spa can't apply a
 *  nail preset). Returns null if not found / wrong vertical. */
export function getLookPreset(
  vertical: string | null | undefined,
  id: string,
): LookPreset | null {
  return (
    getLookPresetsForVertical(vertical).find((p) => p.id === id) ?? null
  );
}
