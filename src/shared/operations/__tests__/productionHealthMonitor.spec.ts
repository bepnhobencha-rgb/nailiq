import { describe, expect, it, vi } from "vitest";

import {
  assertAllowedTarget,
  runProductionMonitor,
} from "../../../../scripts/monitor-production-health.mjs";

const identity = "182b232b7cd2ee32b9bfefcd119f9836e53ceeb8";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function healthyFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/version") return jsonResponse({ id: identity });
    if (path === "/api/health") {
      return jsonResponse({ status: "ok", timestamp: new Date().toISOString(), version: identity });
    }
    return jsonResponse({
      status: "ready",
      timestamp: new Date().toISOString(),
      version: identity,
      checks: {
        database_schema: { status: "ok" },
        cron_authorization: { status: "ok" },
      },
    });
  });
}

describe("production health monitor", () => {
  it("requires explicit confirmation before reading production", () => {
    expect(() => assertAllowedTarget("https://www.nailiq.ca")).toThrow(
      "production_read_only_confirmation_required",
    );
    expect(assertAllowedTarget("https://www.nailiq.ca", true)).toBe("https://www.nailiq.ca");
  });

  it("passes only when version, liveness and readiness share one identity", async () => {
    const fetchImpl = healthyFetch();
    const result = await runProductionMonitor({
      baseUrl: "https://preview.example.test",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.deployment_identity).toBe(identity);
    expect(result.probes).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries a transient failure before passing", async () => {
    const healthy = healthyFetch();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "temporary" }, 503))
      .mockImplementation(healthy);
    const result = await runProductionMonitor({
      baseUrl: "https://preview.example.test",
      fetchImpl,
    });
    expect(result.probes[0].attempt).toBe(2);
  });

  it("fails closed when readiness reports a dependency error", async () => {
    const fetchImpl = healthyFetch();
    fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/ready") {
        return jsonResponse({
          status: "not_ready",
          timestamp: new Date().toISOString(),
          version: identity,
          checks: {
            database_schema: { status: "error" },
            cron_authorization: { status: "ok" },
          },
        }, 503);
      }
      if (path === "/api/version") return jsonResponse({ id: identity });
      return jsonResponse({ status: "ok", timestamp: new Date().toISOString(), version: identity });
    });
    await expect(runProductionMonitor({
      baseUrl: "https://preview.example.test",
      fetchImpl,
      attempts: 1,
    })).rejects.toThrow("/api/ready:http_503");
  });

  it("rejects a mixed deployment during rollout", async () => {
    const fetchImpl = healthyFetch();
    fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/version") return jsonResponse({ id: "different-sha" });
      if (path === "/api/health") {
        return jsonResponse({ status: "ok", timestamp: new Date().toISOString(), version: identity });
      }
      return jsonResponse({
        status: "ready",
        timestamp: new Date().toISOString(),
        version: identity,
        checks: { database_schema: { status: "ok" }, cron_authorization: { status: "ok" } },
      });
    });
    await expect(runProductionMonitor({
      baseUrl: "https://preview.example.test",
      fetchImpl,
    })).rejects.toThrow("deployment_identity_mismatch");
  });

  it("supports a controlled incident drill without touching the target", async () => {
    const fetchImpl = healthyFetch();
    await expect(runProductionMonitor({
      baseUrl: "https://preview.example.test",
      fetchImpl,
      simulateFailure: true,
    })).rejects.toThrow("simulated_monitor_failure");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
