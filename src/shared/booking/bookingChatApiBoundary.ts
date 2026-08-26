import "server-only";

import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { canRunAutonomousAiForTenant } from "@/shared/ai/tenantExecutionBoundary";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { loadPlatformDisabledFeaturesState } from "@/shared/features/platformFeatureFlags";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const BOOKING_CHAT_MAX_BODY_BYTES = 8_192;

const bookingChatMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(500),
  })
  .strict();

export const bookingChatRequestSchema = z
  .object({
    salonId: z.string().uuid(),
    messages: z.array(bookingChatMessageSchema).min(1).max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    const totalCharacters = value.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    );
    if (totalCharacters > 4_000) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "conversation too large",
      });
    }
  });

export function isAllowedBookingChatOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return false;
  }

  const allowed = new Set<string>([request.nextUrl.origin]);
  for (const candidate of [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
    process.env.VERCEL_BRANCH_URL
      ? `https://${process.env.VERCEL_BRANCH_URL}`
      : null,
  ]) {
    if (!candidate) continue;
    try {
      allowed.add(new URL(candidate).origin);
    } catch {
      // A malformed deployment URL never expands the authorization boundary.
    }
  }
  return allowed.has(origin);
}

export function bookingChatRateKey(
  kind: "ip" | "ip_hourly" | "salon" | "salon_daily",
  value: string,
): string {
  return `public-booking-chat:${kind}:${createHash("sha256")
    .update(value)
    .digest("hex")}`;
}

/** Read a request body without buffering beyond the paid route's hard cap. */
export async function readBoundedBookingChatBody(
  request: NextRequest,
): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > BOOKING_CHAT_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    if (total === 0) return null;
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

/** `null` means the limiter dependency failed and the paid path must close. */
export async function bookingChatRateLimitAllowed(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean | null> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "rate_limit_hit",
      {
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      },
    );
    if (error || typeof data !== "boolean") return null;
    return data;
  } catch {
    return null;
  }
}

export type BookingChatSalonContext = {
  id: string;
  name: string;
  description: string | null;
  address: string | null;
  timezone: string | null;
  salonPhone: string | null;
  openingHours: unknown;
  vertical: string | null;
  services: Array<{
    name: string;
    durationMinutes: number | null;
    bufferMinutes: number | null;
  }>;
};

export type BookingChatSalonContextResult =
  | { ok: true; context: BookingChatSalonContext }
  | { ok: false; code: "disabled" | "unavailable" };

export async function loadAuthorizedBookingChatContext(
  salonId: string,
): Promise<BookingChatSalonContextResult> {
  try {
    const admin = createServiceRoleClient();
    const { data: rawSalon, error: salonError } = await admin
      .from("salons" as never)
      .select(
        "id, name, description, address, timezone, salon_phone, opening_hours, vertical, profile_complete, feature_flags, archived_at, superadmin_locked_at, subscription_status" as never,
      )
      .eq("id" as never, salonId)
      .limit(1)
      .maybeSingle();

    if (salonError) return { ok: false, code: "unavailable" };
    if (!rawSalon) return { ok: false, code: "disabled" };
    const salon = rawSalon as unknown as {
      id?: unknown;
      name?: unknown;
      description?: unknown;
      address?: unknown;
      timezone?: unknown;
      salon_phone?: unknown;
      opening_hours?: unknown;
      vertical?: unknown;
      profile_complete?: unknown;
      feature_flags?: unknown;
      archived_at?: unknown;
      superadmin_locked_at?: unknown;
      subscription_status?: unknown;
    };
    if (
      salon.profile_complete !== true ||
      salon.id !== salonId ||
      !canRunAutonomousAiForTenant({
        archived_at:
          typeof salon.archived_at === "string" || salon.archived_at === null
            ? salon.archived_at
            : undefined,
        superadmin_locked_at:
          typeof salon.superadmin_locked_at === "string" ||
          salon.superadmin_locked_at === null
            ? salon.superadmin_locked_at
            : undefined,
        subscription_status:
          typeof salon.subscription_status === "string"
            ? salon.subscription_status
            : undefined,
      })
    ) {
      return { ok: false, code: "disabled" };
    }

    if (
      !isReleaseFeatureEnabled(
        { feature_flags: salon.feature_flags },
        "ai_text_receptionist",
      )
    ) {
      return { ok: false, code: "disabled" };
    }
    const platform = await loadPlatformDisabledFeaturesState();
    if (!platform.available) return { ok: false, code: "unavailable" };
    if (platform.disabled.has("ai_text_receptionist")) {
      return { ok: false, code: "disabled" };
    }

    const { data: rawServices, error: servicesError } = await admin
      .from("public_service_catalog" as never)
      .select("name, duration_minutes, buffer_minutes" as never)
      .eq("salon_id" as never, salonId)
      .order("name" as never, { ascending: true })
      .limit(30);
    if (servicesError || !Array.isArray(rawServices)) {
      return { ok: false, code: "unavailable" };
    }

    const services: BookingChatSalonContext["services"] = [];
    for (const raw of rawServices as unknown[]) {
      if (!raw || typeof raw !== "object") {
        return { ok: false, code: "unavailable" };
      }
      const service = raw as Record<string, unknown>;
      const serviceName = boundedPromptText(service.name, 120);
      if (!serviceName) {
        return { ok: false, code: "unavailable" };
      }
      const durationMinutes = nullableNonNegativeNumber(service.duration_minutes);
      const bufferMinutes = nullableNonNegativeNumber(service.buffer_minutes);
      if (
        durationMinutes === undefined ||
        bufferMinutes === undefined
      ) {
        return { ok: false, code: "unavailable" };
      }
      services.push({
        name: serviceName,
        durationMinutes,
        bufferMinutes,
      });
    }

    return {
      ok: true,
      context: {
        id: salonId,
        name: boundedPromptText(salon.name, 120) ?? "this salon",
        description: boundedPromptText(salon.description, 500),
        address: boundedPromptText(salon.address, 200),
        timezone: boundedPromptText(salon.timezone, 80),
        salonPhone: boundedPromptText(salon.salon_phone, 40),
        openingHours: salon.opening_hours ?? null,
        vertical: boundedPromptText(salon.vertical, 64),
        services,
      },
    };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

function nullableNonNegativeNumber(value: unknown): number | null | undefined {
  if (value == null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function boundedPromptText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}
