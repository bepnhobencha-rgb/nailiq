import { createServer, type Server } from "node:http";
import { request } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";

import { removeLocalAuthMail, withLocalAuthCleanup } from "./localAuthCleanup";

const servers: Server[] = [];

async function mailpit(options: { listStatus?: number; deleteStatus?: number; empty?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method!, path: req.url!, body });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      res.statusCode = options.listStatus ?? 200;
      res.end(JSON.stringify({ messages: options.empty ? [] : [
        { ID: "mine-1", To: [{ Address: "e2e-cleanup@example.com" }] },
        { ID: "unrelated", To: [{ Address: "another-test@example.com" }] },
        { ID: "mine-2", To: [{ Address: "e2e-cleanup@example.com" }] },
      ] }));
    } else {
      res.statusCode = options.deleteStatus ?? 200;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return { origin: `http://127.0.0.1:${address.port}`, calls };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("local Auth cleanup failure reporting", () => {
  it("runs the body and every cleanup in order", async () => {
    const steps: number[] = [];
    await withLocalAuthCleanup(
      async () => steps.push(1),
      async () => steps.push(2),
      async () => steps.push(3),
    );
    expect(steps).toEqual([1, 2, 3]);
  });

  it("retains the exact original assertion when cleanup succeeds", async () => {
    const assertion = new Error("main must be visible");
    await expect(withLocalAuthCleanup(
      async () => { throw assertion; },
      async () => {},
    )).rejects.toBe(assertion);
  });

  it("fails a successful scenario when cleanup fails", async () => {
    const cleanup = new Error("Mailpit delete failed");
    await expect(withLocalAuthCleanup(
      async () => {},
      async () => { throw cleanup; },
    )).rejects.toBe(cleanup);
  });

  it("preserves the assertion and both cleanup failures while attempting later cleanup", async () => {
    const assertion = new Error("main must be visible");
    const mail = new Error("Mailpit unavailable");
    const user = new Error("user cleanup failed");
    let finalCleanupRan = false;
    const failure = await withLocalAuthCleanup(
      async () => { throw assertion; },
      async () => { throw mail; },
      async () => { throw user; },
      async () => { finalCleanupRan = true; },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([assertion, mail, user]);
    expect((failure as Error).message).toContain(assertion.message);
    expect((failure as Error).message).toContain(mail.message);
    expect((failure as Error).message).toContain(user.message);
    expect(finalCleanupRan).toBe(true);
  });
});

describe("local Mailpit cleanup transport", () => {
  it("deletes only this test's messages after the scenario request context is closed", async () => {
    const fake = await mailpit();
    const scenarioRequest = await request.newContext();
    await scenarioRequest.dispose();
    await expect(scenarioRequest.get(fake.origin)).rejects.toThrow(/disposed|closed/i);
    await removeLocalAuthMail("e2e-cleanup@example.com", fake.origin);
    expect(fake.calls).toEqual([
      { method: "GET", path: "/api/v1/messages", body: "" },
      { method: "DELETE", path: "/api/v1/messages", body: JSON.stringify({ IDs: ["mine-1", "mine-2"] }) },
    ]);
  });

  it("does not delete when this test has no messages", async () => {
    const fake = await mailpit({ empty: true });
    await removeLocalAuthMail("e2e-cleanup@example.com", fake.origin);
    expect(fake.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("surfaces failed mailbox reads without attempting delete", async () => {
    const fake = await mailpit({ listStatus: 503 });
    await expect(removeLocalAuthMail("e2e-cleanup@example.com", fake.origin))
      .rejects.toThrow("Mailpit list failed: HTTP 503");
    expect(fake.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("surfaces failed deletes", async () => {
    const fake = await mailpit({ deleteStatus: 500 });
    await expect(removeLocalAuthMail("e2e-cleanup@example.com", fake.origin))
      .rejects.toThrow("Mailpit delete failed: HTTP 500");
  });

  it("rejects hosted mailboxes before opening a request context", async () => {
    await expect(removeLocalAuthMail("e2e-cleanup@example.com", "https://example.com"))
      .rejects.toThrow("disposable loopback Mailpit");
  });
});
