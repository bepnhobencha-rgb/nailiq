export const NAIL_TRYON_CAPTURE_MODES = ["single", "four_plus_one"] as const;

export type NailTryOnCaptureMode = typeof NAIL_TRYON_CAPTURE_MODES[number];

export function parseNailTryOnCaptureMode(value: unknown): NailTryOnCaptureMode {
  return value === "four_plus_one" ? "four_plus_one" : "single";
}

export function nailTryOnQualityPrompt(mode: NailTryOnCaptureMode) {
  if (mode === "four_plus_one") {
    return [
      "Quality-check this two-panel nail try-on capture board.",
      "It should show four fingernails in the large panel and the same hand's thumbnail in the smaller panel.",
      "Treat these two views of the same hand as one valid hand, not multiple hands.",
      "Pass only when five nail plates are visible across both panels and are not materially occluded.",
      "Do not diagnose health or identify the person. Return only the requested structure.",
    ].join(" ");
  }

  return "Quality-check this nail try-on photo. Pass only when it shows exactly one real human hand, dorsal side/palm down, with five fingernails clearly visible and not materially occluded. Do not diagnose health or identify the person. Return only the requested structure.";
}

export const NAIL_TRYON_CAPTURE_LAYOUT_INSTRUCTION =
  "The first image may be either one natural hand photo or a two-panel 4+1 capture board. If it is a capture board, preserve its two-panel layout and edit the four nails in the large panel plus the thumbnail in the smaller panel.";
