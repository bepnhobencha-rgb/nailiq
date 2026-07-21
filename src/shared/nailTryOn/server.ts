import "server-only";

import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { prepareTryOnImage } from "./imagePipeline";

export const TRYON_COOKIE = "nailiq_tryon";
export const QUALITY_MODEL = process.env.NAIL_TRYON_QUALITY_MODEL || "gpt-5.6-luna";
export const IMAGE_MODEL = process.env.NAIL_TRYON_IMAGE_MODEL || "gpt-image-2-2026-04-21";

const qualitySchema = z.object({
  verdict: z.enum(["pass", "hand_not_found", "multiple_hands", "nails_occluded", "wrong_pose"]),
  visibleNails: z.number().int().min(0).max(10),
  reason: z.string().max(180),
});

export type ServerQualityVerdict = z.infer<typeof qualitySchema>;

function openaiClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error("openai_not_configured");
  return new OpenAI();
}

export async function inspectHandPhoto(bytes: Buffer): Promise<ServerQualityVerdict> {
  const response = await openaiClient().responses.parse({
    model: QUALITY_MODEL,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Quality-check this nail try-on photo. Pass only when it shows exactly one real human hand, dorsal side/palm down, with five fingernails clearly visible and not materially occluded. Do not diagnose health or identify the person. Return only the requested structure." },
        { type: "input_image", detail: "high", image_url: `data:image/jpeg;base64,${bytes.toString("base64")}` },
      ],
    }],
    text: { format: zodTextFormat(qualitySchema, "nail_tryon_quality") },
  });
  if (!response.output_parsed) throw new Error("quality_response_invalid");
  return response.output_parsed;
}

export async function generateNailPreview(args: {
  hand: Buffer;
  design: Buffer;
  designMime?: string;
  designName: string;
  promptHint?: string | null;
}) {
  const [hand, design] = await Promise.all([
    prepareTryOnImage(args.hand, 1280),
    prepareTryOnImage(args.design, 1024),
  ]);
  const result = await openaiClient().images.edit({
    model: IMAGE_MODEL,
    image: [
      await toFile(hand, "hand.jpg", { type: "image/jpeg" }),
      await toFile(design, "design.jpg", { type: "image/jpeg" }),
    ],
    prompt: [
      "Edit the FIRST image only. Apply the nail art shown in the SECOND reference image to the five visible fingernail plates.",
      `Design name: ${args.designName}.`,
      args.promptHint ? `Salon guidance: ${args.promptHint}.` : "",
      "Preserve the original hand anatomy, finger count, skin, pose, jewelry, lighting, camera angle, and background exactly. Do not change nail length or shape. Do not add fingers, hands, text, logos, rings, or other objects. Keep the result photorealistic. Change nail surfaces only.",
    ].filter(Boolean).join(" "),
    quality: "low",
    output_format: "jpeg",
    size: "auto",
  });
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("image_response_missing");
  return Buffer.from(encoded, "base64");
}
