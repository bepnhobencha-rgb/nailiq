import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const adapter = readFileSync(
  join(process.cwd(), "src/shared/turniq/trustedGroupRecommendation.ts"),
  "utf8",
);
const actions = readFileSync(
  join(process.cwd(), "src/shared/turniq/serverActions.ts"),
  "utf8",
);
const card = readFileSync(
  join(process.cwd(), "src/components/receptionist/TurnIqGroupPlanCard.tsx"),
  "utf8",
);
const center = readFileSync(
  join(process.cwd(), "src/components/receptionist/ReceptionistCenter.tsx"),
  "utf8",
);

describe("TurnIQ M4D Receptionist group boundary", () => {
  it("loads a salon-scoped PII-free group queue", () => {
    const loader = adapter.slice(
      adapter.indexOf("export async function loadTrustedTurnIqGroupQueue"),
    );
    expect(loader).toContain("resolveTurnIqContext(slug)");
    expect(loader).toContain("canUseTurnIqLiveBoard(context.role)");
    expect(loader).toContain('.eq("salon_id", context.salonId)');
    expect(loader).toContain("group_id, service_id, staff_id, start_time_utc");
    expect(loader).not.toContain("client_phone");
    expect(loader).not.toContain("client_email");
    expect(loader).not.toContain("client_notes");
    expect(loader).not.toContain("tip_cents");
  });

  it("keeps mutations in validated Server Actions", () => {
    expect(actions).toContain(
      "turnIqGroupRecommendationActionInputSchema.safeParse(input)",
    );
    expect(actions).toContain(
      "turnIqGroupConfirmationActionInputSchema.safeParse(input)",
    );
    expect(actions).toContain("loadTrustedTurnIqGroupQueue(parsed.data.slug)");
    expect(card).toContain("onRecommend(pending.input)");
    expect(card).toContain("onConfirm(pending.input)");
    expect(card).not.toContain("createServiceRoleClient");
  });

  it("preserves committed success and exact command envelopes across transport loss", () => {
    expect(card).toContain("recommendRetryRef");
    expect(card).toContain("confirmRetryRef");
    expect(card).toContain("Retry will reuse the same command");
    expect(card).toContain("Confirmation is authoritative");
    expect(card).toContain("Bookings are unchanged");
    expect(card).toContain("preserveCommittedMessage");
    expect(card).toContain("loadPlan(result.result.groupPlanId, true)");
  });

  it("blocks offline mutations and mounts only inside the TurnIQ day surface", () => {
    expect(card).toContain("disabled={offline}");
    expect(card).toContain("if (!selected || selected.readiness !== \"ready\" || offline)");
    expect(center).toContain("<TurnIqGroupPlanCard");
    expect(center).toContain(
      'turnIqEnabled && isViewingToday && viewMode === "day"',
    );
  });
});
