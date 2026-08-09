import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCredential } from "@/shared/nailTryOn/sessionCredential";

const {
  cookieGet,
  createServiceRoleClient,
  queueUpsert,
  queueUpdateIn,
  remove,
  sessionMaybeSingle,
  sessionUpdate,
  sessionUpdateEq,
} = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  createServiceRoleClient: vi.fn(),
  queueUpsert: vi.fn(),
  queueUpdateIn: vi.fn(),
  remove: vi.fn(),
  sessionMaybeSingle: vi.fn(),
  sessionUpdate: vi.fn(),
  sessionUpdateEq: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient,
}));

import { DELETE } from "./route";

const sessionId = "11111111-1111-4111-8111-111111111111";
const salonId = "22222222-2222-4222-8222-222222222222";
const credential = createSessionCredential(sessionId);
const sourcePath = `salon/${salonId}/session/${sessionId}/original.jpg`;
const previewPath = `salon/${salonId}/session/${sessionId}/preview.jpg`;

function request() {
  return new Request("https://www.nailiq.ca/api/nail-tryon/session", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

describe("Nail Try-On customer deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieGet.mockReturnValue({ value: credential.cookieValue });
    sessionMaybeSingle.mockResolvedValue({
      data: {
        id: sessionId,
        salon_id: salonId,
        anonymous_token_hash: credential.tokenHash,
        source_image_path: sourcePath,
        result_image_path: previewPath,
      },
    });
    sessionUpdateEq.mockResolvedValue({ error: null });
    queueUpsert.mockResolvedValue({ error: null });
    queueUpdateIn.mockResolvedValue({ error: null });
    remove.mockResolvedValue({ error: null });

    sessionUpdate.mockReturnValue({ eq: sessionUpdateEq });
    const sessions = {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: sessionMaybeSingle })),
      })),
      update: sessionUpdate,
    };
    const queue = {
      upsert: queueUpsert,
      update: vi.fn(() => ({
        eq: vi.fn(() => ({ in: queueUpdateIn })),
      })),
    };
    createServiceRoleClient.mockReturnValue({
      from: vi.fn((table: string) => table === "nail_tryon_sessions" ? sessions : queue),
      storage: { from: vi.fn(() => ({ remove })) },
    });
  });

  it("locks the session, queues every path, removes the files, and clears the bearer cookie", async () => {
    const response = await DELETE(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deletion: "complete" });
    expect(sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: "deleted",
      result_image_path: null,
    }));
    expect(sessionUpdateEq).toHaveBeenCalledWith("id", sessionId);
    expect(queueUpsert).toHaveBeenCalledWith(
      [
        { tryon_session_id: sessionId, object_path: sourcePath },
        { tryon_session_id: sessionId, object_path: previewPath },
      ],
      expect.objectContaining({ ignoreDuplicates: true }),
    );
    expect(remove).toHaveBeenCalledWith([sourcePath, previewPath]);
    expect(response.headers.get("set-cookie")).toContain("nailiq_tryon=");
    expect(response.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");
  });

  it("fails closed when the bearer cookie does not match the session", async () => {
    cookieGet.mockReturnValue({ value: `${sessionId}.wrong-token` });

    const response = await DELETE(request());

    expect(response.status).toBe(404);
    expect(sessionUpdateEq).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns accepted when immediate Storage removal fails but durable cleanup is queued", async () => {
    remove.mockResolvedValue({ error: { message: "temporary" } });

    const response = await DELETE(request());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, deletion: "queued" });
  });

  it("keeps the credential available for retry when both deletion paths fail", async () => {
    queueUpsert.mockResolvedValue({ error: { message: "queue unavailable" } });
    remove.mockResolvedValue({ error: { message: "storage unavailable" } });

    const response = await DELETE(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
