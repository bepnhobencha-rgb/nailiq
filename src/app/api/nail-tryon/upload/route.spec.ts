import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  consumeDurableRateLimitBuckets,
  createServiceRoleClient,
  loadPublicNailTryOnSalon,
} = vi.hoisted(() => ({
  consumeDurableRateLimitBuckets: vi.fn(),
  createServiceRoleClient: vi.fn(),
  loadPublicNailTryOnSalon: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/nailTryOn/publicSalon", () => ({
  loadPublicNailTryOnSalon,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient,
}));
vi.mock("@/shared/lib/inAppRateLimit", () => ({
  clientIp: vi.fn(() => "203.0.113.10"),
}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumeDurableRateLimitBuckets,
}));

import { POST } from "./route";

function uploadRequest(bytes: Buffer, mimeType: string): Request {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const form = new FormData();
  form.set("photo", new File([copy.buffer], "hand", { type: mimeType }));
  form.set("slug", "security-test-salon");
  form.set("consent_version", "nail-tryon-v1");
  return new Request("https://www.nailiq.ca/api/nail-tryon/upload", {
    method: "POST",
    body: form,
  });
}

describe("public Nail Try-On upload validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeDurableRateLimitBuckets.mockResolvedValue("allowed");
    createServiceRoleClient.mockReturnValue({});
    loadPublicNailTryOnSalon.mockResolvedValue(null);
  });

  it("accepts a valid image signature before resolving the salon", async () => {
    const jpeg = await sharp({
      create: {
        width: 900,
        height: 700,
        channels: 3,
        background: "#d8b29a",
      },
    }).jpeg().toBuffer();

    const response = await POST(uploadRequest(jpeg, "image/jpeg"));

    expect(response.status).toBe(404);
    expect(loadPublicNailTryOnSalon)
      .toHaveBeenCalledWith("security-test-salon");
  });

  it("rejects malformed bytes before storage or AI access", async () => {
    const malformed = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
    loadPublicNailTryOnSalon.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      slug: "security-test-salon",
      name: "Security Test Salon",
      brandColor: "#c6a15b",
      themeMode: "light",
    });

    const response = await POST(uploadRequest(malformed, "image/jpeg"));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid_image" });
    expect(loadPublicNailTryOnSalon)
      .toHaveBeenCalledWith("security-test-salon");
  });

  it("rejects a real image disguised behind another MIME", async () => {
    const png = await sharp({
      create: {
        width: 900,
        height: 700,
        channels: 3,
        background: "#d8b29a",
      },
    }).png().toBuffer();

    const response = await POST(uploadRequest(png, "image/jpeg"));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid_image" });
    expect(loadPublicNailTryOnSalon).not.toHaveBeenCalled();
  });
});
