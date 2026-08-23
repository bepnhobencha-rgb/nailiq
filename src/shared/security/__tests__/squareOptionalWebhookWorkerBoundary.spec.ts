import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const worker = readFileSync(join(
  root,
  "src/shared/integrations/square/optionalWebhookWorker.ts",
), "utf8");
const optional = readFileSync(join(
  root,
  "src/shared/integrations/square/optionalCapabilities.ts",
), "utf8");
const cron = readFileSync(join(root, "src/app/api/cron/square-sync/route.ts"), "utf8");

describe("Square optional webhook worker boundary", () => {
  it("keeps all application gates hard-off before DB/provider work", () => {
    expect(optional).toMatch(/loyalty:\s*false/);
    expect(optional).toMatch(/gift_cards:\s*false/);
    expect(optional).toMatch(/inventory:\s*false/);
    expect(worker).toMatch(
      /if \(!SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE\[capability\]\)[\s\S]{0,160}return \[\{ status: "disabled", capability \}\]/,
    );
    expect(worker).not.toMatch(/fetch\(|squareup\.com|Authorization/);
  });

  it("claims bounded feature rows and uses only feature-specific adoption RPCs", () => {
    expect(worker).toContain('p_feature: capability');
    expect(worker).toContain('loyalty: "apply_square_loyalty_webhook_event"');
    expect(worker).toContain('gift_cards: "apply_square_gift_card_webhook_event"');
    expect(worker).toContain('inventory: "apply_square_inventory_webhook_event"');
    expect(worker).toContain('p_status: "failed"');
    expect(cron).toContain('processSquareOptionalWebhookInbox("loyalty")');
  });
});
