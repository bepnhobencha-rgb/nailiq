import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext } from "@playwright/test";
const manifest = JSON.parse(readFileSync("qa/fee-confirmation/.next/server/server-reference-manifest.json", "utf8"));
const actions = Object.values(manifest.node) as { filename: string; exportedName: string }[];
const allowed = ["dispatchApprovedNoShowFee", "dispatchApprovedCancellationFee", "decideNoShowFeeReview", "requestNoShowFeeReview", "decideLateCancellationFeeReview", "decideGroupCancellationFeeReview"];
if (actions.length !== 6 || actions.some(a => a.filename !== "actions.ts" || !allowed.includes(a.exportedName))) throw new Error("Fixture contains unexpected actions");
const ids = new Set(Object.keys(manifest.node));
const origin = "http://127.0.0.1:3128";
async function guard(context: BrowserContext) {
  const state = { calls: 0, abort: false, hold: null as Promise<void> | null, blocked: [] as string[] };
  await context.route("**/*", async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== origin) { state.blocked.push("external"); return route.abort(); }
    if (["GET", "HEAD"].includes(request.method())) return route.continue();
    if (!ids.has(request.headers()["next-action"])) { state.blocked.push("unknown action"); return route.abort(); }
    state.calls++;
    if (state.hold) await state.hold;
    if (state.abort) return route.abort("failed");
    return route.continue();
  });
  return state;
}
for (const lang of ["en", "vi"]) for (const kind of ["no-show", "late", "group"]) {
  const id = `${kind === "late" ? "late-cancellation" : kind === "group" ? "group-cancellation" : kind}-fee-approval-queue`;
  const collect = /^(Collect|Thu)/;
  test.describe(`${lang} ${kind}`, () => {
    test.beforeEach(async ({ page }) => { await page.addInitScript(l => localStorage.setItem("nailiq-user-lang", l), lang); });
    test("cancel and Escape send no action; confirmation shows exact amount/card/type", async ({ page, context }) => {
      const calls = await guard(context); await page.goto("/");
      const button = page.getByTestId(id).getByRole("button", { name: collect });
      // WebKit pointer activation need not focus native buttons. Verify keyboard restoration explicitly.
      await button.focus(); await button.press("Enter"); const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("VISA •••• 1111");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await expect(dialog).toContainText(lang === "en" ? "$1.00" : "1,00");
      await expect(dialog).toContainText(kind === "group" ? (lang === "en" ? "Organizer card" : "Thẻ người tổ chức") : (lang === "en" ? "Saved card" : "Thẻ đã lưu"));
      await dialog.getByRole("button", { name: lang === "en" ? "Cancel" : "Hủy", exact: true }).click();
      await expect(dialog).not.toBeVisible(); await expect(button).toBeFocused();
      await button.click(); await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible();
      expect(calls.calls).toBe(0); expect(calls.blocked).toEqual([]);
    });
    test("single dispatch while pending, busy Escape blocked, succeeded status survives reload", async ({ page, context }) => {
      const calls = await guard(context); let release!: () => void;
      calls.hold = new Promise(resolve => { release = resolve; });
      await page.goto("/"); const queue = page.getByTestId(id);
      await queue.getByRole("button", { name: collect }).click();
      const dialog = page.getByRole("dialog");
      const confirm = dialog.getByRole("button", { name: /^(Confirm collection|Xác nhận thu)/ });
      try {
        await confirm.dblclick(); await expect(confirm).toBeDisabled();
        await expect.poll(() => calls.calls).toBe(1);
        await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("button", { name: lang === "en" ? "Cancel" : "Hủy", exact: true })).toBeDisabled();
      } finally { release(); }
      await expect(dialog).not.toBeVisible();
      await expect(queue).toContainText(lang === "en" ? "Collected — receipt recorded" : "Đã thu phí — có biên nhận");
      await expect(queue.getByRole("button", { name: collect })).toHaveCount(0);
      await page.reload(); await expect(queue).toContainText(lang === "en" ? "Collected — receipt recorded" : "Đã thu phí — có biên nhận");
      expect(calls.calls).toBe(1); expect(calls.blocked).toEqual([]);
    });
    for (const fault of ["decline", "unknown", "stale-unknown", "abort"]) test(`${fault} never says collected and never offers blind repeat`, async ({ page, context }) => {
      const calls = await guard(context); calls.abort = fault === "abort";
      if (fault !== "abort") await context.addCookies([{ name: "qa-fault", value: fault, url: origin }]);
      await page.goto("/"); const queue = page.getByTestId(id);
      await queue.getByRole("button", { name: collect }).click();
      await page.getByRole("dialog").getByRole("button", { name: /^(Confirm collection|Xác nhận thu)/ }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      const expected = fault === "decline" ? (lang === "en" ? "Collection failed" : "Thu phí không thành công")
        : fault === "unknown" ? (lang === "en" ? "Reconciling — do not retry" : "Đang đối soát — không thử lại")
          : (lang === "en" ? "Result unconfirmed — reload to check" : "Kết quả chưa rõ — tải lại để kiểm tra");
      await expect(queue).toContainText(expected);
      await expect(queue.getByRole("button", { name: collect })).toHaveCount(0);
      await expect(queue).not.toContainText(lang === "en" ? "Collected — receipt recorded" : "Đã thu phí — có biên nhận");
      expect(calls.calls).toBe(1); expect(calls.blocked).toEqual([]);
    });
    test("approval does not claim disabled dispatch and does not collect", async ({ page, context }) => {
      const calls = await guard(context); await page.goto("/?pending=1"); const queue = page.getByTestId(id);
      await queue.getByRole("button", { name: /^(Approve|Duyệt)/ }).click();
      await expect(queue.getByRole("status")).toHaveText(lang === "en" ? "Approved. No payment was sent. Collection is a separate step." : "Đã duyệt. Chưa gửi lệnh thanh toán; Thu là bước riêng.");
      await expect(queue.getByRole("button", { name: collect })).toBeVisible();
      expect(calls.calls).toBe(1); expect(calls.blocked).toEqual([]);
    });
  });
}
