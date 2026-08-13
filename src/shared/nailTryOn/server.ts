import "server-only";

import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { prepareTryOnImage } from "./imagePipeline";
import { configurationPrompt, type NailConfiguration } from "./configurator";
import {
  NAIL_TRYON_CAPTURE_LAYOUT_INSTRUCTION,
  nailTryOnQualityPrompt,
  type NailTryOnCaptureMode,
} from "./captureMode";
import { heuristicAutoMapping, sanitizeAutoMapping, type AutoMappingResult, type AutoMappingService } from "./autoMapping";
import {
  NAIL_TRYON_GENERATION_TIMEOUT_MS,
  NAIL_TRYON_MAPPING_TIMEOUT_MS,
  NAIL_TRYON_QUALITY_TIMEOUT_MS,
} from "./timeouts";

export const TRYON_COOKIE = "nailiq_tryon";
export const QUALITY_MODEL = process.env.NAIL_TRYON_QUALITY_MODEL || "gpt-5.6-luna";
export const IMAGE_MODEL = process.env.NAIL_TRYON_IMAGE_MODEL || "gpt-image-2-2026-04-21";
export const MAPPING_MODEL = process.env.NAIL_TRYON_MAPPING_MODEL || QUALITY_MODEL;
export const QUALITY_PROMPT_VERSION = "quality-v2-2026-08-10";
export const GENERATION_PROMPT_VERSION = "generation-v1-2026-08-13";

const qualitySchema = z.object({
  verdict: z.enum(["pass", "hand_not_found", "multiple_hands", "nails_occluded", "wrong_pose"]),
  visibleNails: z.number().int().min(0).max(10),
  reason: z.string().max(180),
});

export type ServerQualityVerdict = z.infer<typeof qualitySchema>;

const autoMappingSchema = z.object({
  serviceIds: z.array(z.string()).max(50),
  addonServiceIds: z.array(z.string()).max(50),
  defaultServiceId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(240),
  attributes: z.array(z.string().max(40)).max(12),
});

function openaiClient(timeout: number) {
  if (!process.env.OPENAI_API_KEY) throw new Error("openai_not_configured");
  // A retry after an ambiguous image-generation timeout can duplicate provider
  // spend. Let the route reset its idempotent session lease and let the customer
  // retry deliberately instead of multiplying the worst-case wait/cost.
  return new OpenAI({ timeout, maxRetries: 0 });
}

export async function inspectHandPhotoWithUsage(
  bytes: Buffer,
  captureMode: NailTryOnCaptureMode = "single",
) {
  const response = await openaiClient(NAIL_TRYON_QUALITY_TIMEOUT_MS).responses.parse({
    model: QUALITY_MODEL,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: nailTryOnQualityPrompt(captureMode) },
        { type: "input_image", detail: "high", image_url: `data:image/jpeg;base64,${bytes.toString("base64")}` },
      ],
    }],
    text: { format: zodTextFormat(qualitySchema, "nail_tryon_quality") },
  });
  if (!response.output_parsed) throw new Error("quality_response_invalid");
  return { verdict: response.output_parsed, usage: response.usage };
}

export async function inspectHandPhoto(
  bytes: Buffer,
  captureMode: NailTryOnCaptureMode = "single",
): Promise<ServerQualityVerdict> {
  return (await inspectHandPhotoWithUsage(bytes, captureMode)).verdict;
}

export async function autoMapNailDesign(args: {
  image: Buffer;
  designName: string;
  description?: string | null;
  services: readonly AutoMappingService[];
}): Promise<AutoMappingResult> {
  if (!args.services.some((service) => !service.isAddon)) {
    return heuristicAutoMapping(`${args.designName} ${args.description || ""}`, args.services);
  }
  const image = await prepareTryOnImage(args.image, 1024);
  const menu = args.services.map((service) => ({
    id: service.id,
    name: service.name,
    type: service.isAddon ? "addon" : "service",
    priceCents: service.priceCents ?? null,
    durationMinutes: service.durationMinutes ?? null,
  }));
  try {
    const response = await openaiClient(NAIL_TRYON_MAPPING_TIMEOUT_MS).responses.parse({
      model: MAPPING_MODEL,
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "You are NailIQ's salon menu mapper. Analyze the reference nail design and map it only to items in the supplied salon menu.",
              "Select every MAIN service that can realistically create the look, the relevant add-ons, and one best default main service.",
              "Never invent IDs. Do not select removal-only services. Prefer an exact enhancement family (acrylic, Gel-X, dip, builder gel) when visually or textually clear.",
              "If the base enhancement cannot be known from the image, include the plausible salon main services and lower confidence. Keep the reason concise for a salon owner.",
              `Design: ${JSON.stringify({ name: args.designName, description: args.description || null })}`,
              `Salon menu: ${JSON.stringify(menu)}`,
            ].join("\n"),
          },
          { type: "input_image", detail: "low", image_url: `data:image/jpeg;base64,${image.toString("base64")}` },
        ],
      }],
      text: { format: zodTextFormat(autoMappingSchema, "nail_design_service_mapping") },
    });
    if (!response.output_parsed) throw new Error("mapping_response_invalid");
    const sanitized = sanitizeAutoMapping(response.output_parsed, args.services);
    if (sanitized.serviceIds.length) return sanitized;
  } catch {
    // A salon can still publish and map designs when the AI provider is unavailable.
  }
  return heuristicAutoMapping(`${args.designName} ${args.description || ""}`, args.services);
}

export async function generateNailPreviewWithUsage(args: {
  hand: Buffer;
  design: Buffer;
  designMime?: string;
  designName: string;
  promptHint?: string | null;
  configuration: NailConfiguration;
}) {
  const [hand, design] = await Promise.all([
    prepareTryOnImage(args.hand, 1280),
    prepareTryOnImage(args.design, 1024),
  ]);
  const result = await openaiClient(NAIL_TRYON_GENERATION_TIMEOUT_MS).images.edit({
    model: IMAGE_MODEL,
    image: [
      await toFile(hand, "hand.jpg", { type: "image/jpeg" }),
      await toFile(design, "design.jpg", { type: "image/jpeg" }),
    ],
    prompt: [
      "Edit the FIRST image only. Apply the nail art shown in the SECOND reference image to the five visible fingernail plates.",
      NAIL_TRYON_CAPTURE_LAYOUT_INSTRUCTION,
      `Design name: ${args.designName}.`,
      args.promptHint ? `Salon guidance: ${args.promptHint}.` : "",
      configurationPrompt(args.configuration),
      "Preserve the original hand anatomy, finger count, skin, pose, jewelry, lighting, camera angle, and background exactly. Do not add fingers, hands, text, logos, rings, or other objects. Keep the result photorealistic. Change only the five nails and any requested salon nail extensions.",
    ].filter(Boolean).join(" "),
    quality: "low",
    output_format: "jpeg",
    size: "auto",
  });
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("image_response_missing");
  return {
    image: Buffer.from(encoded, "base64"),
    usage: result.usage,
  };
}

export async function generateNailPreview(
  args: Parameters<typeof generateNailPreviewWithUsage>[0],
): Promise<Buffer> {
  return (await generateNailPreviewWithUsage(args)).image;
}
