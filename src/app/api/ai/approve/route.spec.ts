import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { createServiceRoleClient, processDecision } = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  processDecision: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient,
}));
vi.mock("@/shared/ai/approvalRequests", () => ({
  processDecision,
}));

import { GET, POST } from "./route";

const approveToken = "approve-token-long-enough";
const declineToken = "decline-token-long-enough";

function installDatabase(status = "pending") {
  createServiceRoleClient.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === "approval_requests") {
        const query = {
          select: vi.fn(() => query),
          or: vi.fn(() => query),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: "approval-1",
              approve_token: approveToken,
              decline_token: declineToken,
              status,
              salon_id: "salon-1",
              summary: `<script>alert("unsafe")</script>`,
            },
          }),
        };
        return query;
      }
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { slug: "tech-nails" },
        }),
      };
      return query;
    }),
  });
}

describe("AI approval confirmation boundary", () => {
  beforeEach(() => {
    createServiceRoleClient.mockReset();
    processDecision.mockReset();
    installDatabase();
  });

  it("keeps GET read-only and renders an escaped confirmation", async () => {
    const response = await GET(
      new NextRequest(
        `https://nailiq.ca/api/ai/approve?token=${approveToken}`,
      ),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Xác nhận đồng ý");
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain(`<script>alert("unsafe")</script>`);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(processDecision).not.toHaveBeenCalled();
  });

  it("rejects POST requests that do not come from the same origin", async () => {
    const response = await POST(
      new NextRequest("https://nailiq.ca/api/ai/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://attacker.example",
        },
        body: new URLSearchParams({ token: approveToken }),
      }),
    );

    expect(response.status).toBe(403);
    expect(processDecision).not.toHaveBeenCalled();
  });

  it("records approval only after a same-origin POST", async () => {
    processDecision.mockResolvedValue({
      ok: true,
      execution: { ok: true, status: "queued" },
    });
    const response = await POST(
      new NextRequest("https://nailiq.ca/api/ai/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://nailiq.ca",
        },
        body: new URLSearchParams({ token: approveToken }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("xếp hàng an toàn");
    expect(processDecision).toHaveBeenCalledOnce();
    expect(processDecision).toHaveBeenCalledWith(approveToken, "approved");
  });

  it("maps a decline token to the declined decision on POST", async () => {
    processDecision.mockResolvedValue({ ok: true });
    await POST(
      new NextRequest("https://nailiq.ca/api/ai/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://nailiq.ca",
        },
        body: new URLSearchParams({ token: declineToken }),
      }),
    );

    expect(processDecision).toHaveBeenCalledWith(declineToken, "declined");
  });
});
