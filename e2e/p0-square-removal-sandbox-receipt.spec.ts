import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect, request } from "@playwright/test";
const origin = "https://nailiq-p0-signup-qa-20260911.vercel.app";
if (process.env.NEXT_PUBLIC_SUPABASE_URL !== "https://osdqutwunokiielbairj.supabase.co" || process.env.NAILIQ_CARD_SAVE_DISPATCH_DISABLED !== "true") throw new Error("Paused disposable QA required");
const source = process.env.NAILIQ_SANDBOX_COMPLETED_FILE;
if (!source?.startsWith("/Users/huytran/nailiq-p0-signup-evidence-20260911/p0-03-square-removal-sandbox-run")
  && source !== "/Users/huytran/nailiq-p0-signup-evidence-20260911/p0-03-removal-concurrency-sandbox/completed.private.json") throw new Error("Exact sandbox receipt evidence required");
const completed = JSON.parse(readFileSync(source, "utf8")) as { mode: string; token: string; requestId: string; fingerprint: string }[];
for (const row of completed) {
  test(`${row.mode}: actual Square receipt replays through hosted customer UI`, async ({ browser }) => {
    const http = await request.newContext({ baseURL: origin });
    await http.get(readFileSync(process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE!, "utf8").trim());
    const c = await browser.newContext({ baseURL: origin, storageState: await http.storageState(), viewport: { width: 390, height: 844 } });
    try {
      const page = await c.newPage(); await page.goto("/booking/card");
      const key = "nailiq:booking-management-pending:" + createHash("sha256").update(JSON.stringify({ v: 1, action: "card_manage", token: row.token })).digest("hex");
      await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), { key, value: { requestId: row.requestId, material: row.fingerprint, createdAt: Date.now() } });
      const response = page.waitForResponse(r => r.url().includes("/api/booking/remove-card") && r.request().method() === "POST");
      await page.goto(`/booking/card?token=${row.token}`);
      const r = await response; expect(r.status()).toBe(200); expect(await r.json()).toMatchObject({ ok: true, code: "removed", idempotent: true });
      await expect(page.getByText("Card removed ✓", { exact: true })).toBeVisible();
      expect(await page.evaluate(k => sessionStorage.getItem(k), key)).toBeNull();
      await page.screenshot({ path: `${process.env.NAILIQ_QA_ARTIFACT_DIR}/${row.mode}-actual-receipt-mobile.png`, fullPage: true });
      const replay = await c.request.post("/api/booking/remove-card", { headers: { Origin: origin }, data: { token: row.token, requestId: row.requestId, expectedCardFingerprint: row.fingerprint } });
      expect(replay.status()).toBe(200); expect(await replay.json()).toMatchObject({ ok: true, code: "removed", idempotent: true });
    } finally { await c.close(); await http.dispose(); }
  });
}
