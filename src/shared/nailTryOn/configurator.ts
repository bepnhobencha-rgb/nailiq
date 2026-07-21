import { z } from "zod";

export const nailLengthSchema = z.enum(["natural", "short", "medium", "long", "extra_long"]);
export const nailShapeSchema = z.enum(["natural", "square", "round", "oval", "almond", "coffin", "stiletto"]);
export const nailFinishSchema = z.enum(["glossy", "matte", "chrome", "cat_eye"]);
export const nailColorSchema = z.enum(["design", "classic_red", "soft_pink", "nude", "burgundy", "black", "white"]);

export const nailConfigurationSchema = z.object({
  length: nailLengthSchema,
  shape: nailShapeSchema,
  finish: nailFinishSchema,
  color: nailColorSchema,
});

export type NailConfiguration = z.infer<typeof nailConfigurationSchema>;

export const DEFAULT_NAIL_CONFIGURATION: NailConfiguration = {
  length: "natural",
  shape: "natural",
  finish: "glossy",
  color: "design",
};

const colorNames: Record<NailConfiguration["color"], string> = {
  design: "the colors from the salon reference design",
  classic_red: "classic red",
  soft_pink: "soft pink",
  nude: "neutral nude",
  burgundy: "deep burgundy",
  black: "black",
  white: "white",
};

export function configurationPrompt(configuration: NailConfiguration) {
  const length = configuration.length === "natural"
    ? "Keep the customer's natural nail length."
    : `Create a realistic ${configuration.length.replace("_", " ")} salon nail extension.`;
  const shape = configuration.shape === "natural"
    ? "Keep the customer's natural nail shape."
    : `Shape every nail as ${configuration.shape}.`;
  return `${length} ${shape} Use ${colorNames[configuration.color]} with a ${configuration.finish.replace("_", "-")} finish. Apply the same requested length, shape, color, and finish consistently to all five nails.`;
}
