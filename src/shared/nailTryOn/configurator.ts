import { z } from "zod";

export const nailLengthSchema = z.enum(["natural", "x_short", "short", "medium", "long", "extra_long", "xx_long"]);
export const nailShapeSchema = z.enum(["natural", "square", "squoval", "round", "oval", "almond", "coffin", "ballerina", "stiletto"]);
export const nailFinishSchema = z.enum(["glossy", "matte", "chrome", "cat_eye", "jelly", "glazed", "glitter", "velvet"]);
export const nailColorSchema = z.enum(["design", "classic_red", "soft_pink", "nude", "milky_white", "burgundy", "brown", "orange", "yellow", "green", "blue", "purple", "black", "white", "silver", "gold"]);
export const nailArtStyleSchema = z.enum(["design", "solid", "french", "micro_french", "ombre", "aura"]);

export const nailConfigurationSchema = z.object({
  length: nailLengthSchema,
  shape: nailShapeSchema,
  finish: nailFinishSchema,
  color: nailColorSchema,
  artStyle: nailArtStyleSchema.default("design"),
});

export type NailConfiguration = z.infer<typeof nailConfigurationSchema>;

export const DEFAULT_NAIL_CONFIGURATION: NailConfiguration = {
  length: "natural",
  shape: "natural",
  finish: "glossy",
  color: "design",
  artStyle: "design",
};

const colorNames: Record<NailConfiguration["color"], string> = {
  design: "the colors from the salon reference design",
  classic_red: "classic red",
  soft_pink: "soft pink",
  nude: "neutral nude",
  milky_white: "translucent milky white",
  burgundy: "deep burgundy",
  brown: "rich chocolate brown",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  blue: "blue",
  purple: "purple",
  black: "black",
  white: "white",
  silver: "silver",
  gold: "gold",
};

const extensionInstructions: Record<Exclude<NailConfiguration["length"], "natural">, string> = {
  x_short: "Create an X-short salon extension with only a tiny 10–20% nail-bed-length free edge beyond the fingertip.",
  short: "Create a short salon extension with a clearly visible 25–40% nail-bed-length free edge beyond the fingertip.",
  medium: "Create a medium salon extension whose free edge is about 50–70% of the visible nail-bed length.",
  long: "Create a long salon extension whose free edge is about the same length as the visible nail bed.",
  extra_long: "Create a dramatic Extra-Long salon extension: the free edge beyond the fingertip must be about 1.5 times the visible nail-bed length. Do not shorten it to ordinary long.",
  xx_long: "Create a dramatic XX-Long / Double-XL salon extension: the free edge beyond the fingertip must be about 2 times the visible nail-bed length while remaining structurally plausible. It must be unmistakably longer than Extra-Long.",
};

const finishInstructions: Record<NailConfiguration["finish"], string> = {
  glossy: "a high-gloss salon finish",
  matte: "a smooth matte finish with no shine",
  chrome: "a reflective mirror-chrome finish",
  cat_eye: "a magnetic cat-eye light band",
  jelly: "a translucent, glass-like jelly finish",
  glazed: "a sheer pearlescent glazed finish",
  glitter: "a sparkling glitter finish",
  velvet: "a soft multidirectional magnetic velvet finish",
};

const artStyleInstructions: Record<NailConfiguration["artStyle"], string> = {
  design: "Follow the composition and decoration placement from the salon reference design.",
  solid: "Use a clean full-coverage solid-color layout without French tips or gradients.",
  french: "Use a classic French-tip layout with a clearly defined tip.",
  micro_french: "Use an ultra-thin micro-French line along each free edge.",
  ombre: "Use a smooth cuticle-to-tip ombre gradient.",
  aura: "Use a soft centered aura gradient that diffuses toward the edges.",
};

export function configurationPrompt(configuration: NailConfiguration) {
  const length = configuration.length === "natural"
    ? "Keep the customer's natural nail length."
    : extensionInstructions[configuration.length];
  const shape = configuration.shape === "natural"
    ? "Keep the customer's natural nail shape."
    : `Shape every nail as ${configuration.shape}.`;
  return `${length} ${shape} Use ${colorNames[configuration.color]} with ${finishInstructions[configuration.finish]}. ${artStyleInstructions[configuration.artStyle]} Apply the requested length, shape, color, finish, and art layout consistently to all five nails. Preserve realistic sidewalls, apex, cuticle alignment, and perspective; never change finger length or hand anatomy to accommodate long extensions.`;
}
