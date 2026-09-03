import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const center = readFileSync(join(process.cwd(), "src/components/receptionist/ReceptionistCenter.tsx"), "utf8");
const card = readFileSync(join(process.cwd(), "src/components/receptionist/TurnIqHandoffCard.tsx"), "utf8");
const page = readFileSync(join(process.cwd(), "src/app/dashboard/[slug]/center/page.tsx"), "utf8");

describe("TurnIQ M4T Receptionist Center handoff boundary", () => {
  it("loads and renders only behind the existing TurnIQ read gate", () => {
    expect(page).toContain("turnIqEnabled");
    expect(page).toContain("loadTrustedTurnIqHandoffQueue(slug)");
    expect(center).toContain("turnIqEnabled && isViewingToday && viewMode === \"day\"");
    expect(center).toContain("<TurnIqHandoffCard");
  });

  it("uses identifier-only trusted Server Actions for every mutation", () => {
    expect(card).toContain("onRecommend(input)");
    expect(card).toContain("onConfirm(input)");
    expect(card).toContain("onPerformer(input)");
    expect(card).not.toMatch(/opportunityCreditCents|candidateTrace|internalDecisionTrace/);
  });

  it("keeps committed-success copy distinct from read-back refresh", () => {
    expect(card).toContain("await load(result.result.handoffPlanId, true)");
    expect(card).toContain("await onRefresh().catch(() => undefined)");
    expect(card).toContain("ghi lượt đúng một lần");
  });
});
