import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  recordNailTryOnEvent: vi.fn(),
  rpc: vi.fn(),
  loadQueue: vi.fn(),
  pendingQueue: vi.fn(),
  sessionMaybeSingle: vi.fn(),
  queueUpdateEq: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/nailTryOn/telemetry", () => ({
  recordNailTryOnEvent: mocks.recordNailTryOnEvent,
}));
vi.mock("@/shared/security/cronAuthorization", () => ({
  requireCronAuthorization: vi.fn(() => null),
}));
vi.mock("@/shared/security/cronRunHistory", () => ({
  runTrackedCron: vi.fn(
    (_workerName: string, handler: () => Promise<Response>) => handler(),
  ),
}));

import { GET } from "./route";

const sessionId = "11111111-1111-4111-8111-111111111111";
const salonId = "22222222-2222-4222-8222-222222222222";

function request() {
  return new Request("https://www.nailiq.ca/api/cron/nail-tryon-cleanup");
}

describe("Nail Try-On cleanup cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ data: 1, error: null });
    mocks.loadQueue.mockResolvedValue({
      data: [
        { id: 1, tryon_session_id: sessionId, object_path: "original.jpg", attempts: 0 },
        { id: 2, tryon_session_id: sessionId, object_path: "preview.jpg", attempts: 0 },
      ],
      error: null,
    });
    mocks.pendingQueue.mockResolvedValue({ count: 0, error: null });
    mocks.sessionMaybeSingle.mockResolvedValue({ data: { salon_id: salonId } });
    mocks.queueUpdateEq.mockResolvedValue({ error: null });
    mocks.remove.mockResolvedValue({ error: null });
    mocks.recordNailTryOnEvent.mockResolvedValue(undefined);

    const queueTable = {
      select: vi.fn((columns: string, options?: { count?: string; head?: boolean }) => {
        if (columns === "id" && options?.head) {
          return {
            eq: vi.fn(() => ({ is: mocks.pendingQueue })),
          };
        }
        return {
          is: vi.fn(() => ({
            lte: vi.fn(() => ({
              order: vi.fn(() => ({ limit: mocks.loadQueue })),
            })),
          })),
        };
      }),
      update: vi.fn(() => ({ eq: mocks.queueUpdateEq })),
    };
    const sessionsTable = {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: mocks.sessionMaybeSingle })),
      })),
    };
    mocks.createServiceRoleClient.mockReturnValue({
      rpc: mocks.rpc,
      from: vi.fn((table: string) => {
        if (table === "nail_tryon_cleanup_queue") return queueTable;
        if (table === "nail_tryon_sessions") return sessionsTable;
        throw new Error(`Unexpected table: ${table}`);
      }),
      storage: { from: vi.fn(() => ({ remove: mocks.remove })) },
    });
  });

  it("records deletion only after every object for the session is gone", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: 1,
      inspected: 2,
      deleted: 2,
      pendingFailures: 0,
      completedSessions: 1,
    });
    expect(mocks.recordNailTryOnEvent).toHaveBeenCalledWith({
      salonId,
      sessionId,
      event: "expired_deleted",
    });
  });

  it("keeps the cleanup pending and does not claim deletion on partial failure", async () => {
    mocks.remove
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: "storage unavailable" } });
    mocks.pendingQueue.mockResolvedValue({ count: 1, error: null });

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: 1,
      pendingFailures: 1,
      completedSessions: 0,
    });
    expect(mocks.recordNailTryOnEvent).not.toHaveBeenCalled();
  });

  it("fails honestly when expired sessions cannot be queued", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    });

    const response = await GET(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "queue_failed" });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.recordNailTryOnEvent).not.toHaveBeenCalled();
  });
});
