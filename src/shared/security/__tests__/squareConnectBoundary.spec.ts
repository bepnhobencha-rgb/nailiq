import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const action = read(
  "src/shared/superadmin/squareConnectionActions.ts",
);
const component = read(
  "src/components/superadmin/SquareConnectionCard.tsx",
);

describe("Square Connect credential boundary", () => {
  it("is founder-only, MFA-aware, and durably rate-limited", () => {
    expect(action).toContain('role !== "founder"');
    expect(action).toContain("getAuthenticatorAssuranceLevel");
    expect(action).toContain('aal?.nextLevel === "aal2"');
    expect(action).toContain('admin.rpc(\n    "rate_limit_hit"');
    expect(action).toContain("p_window_seconds: 900");
    expect(action).toContain("if (limitError)");
  });

  it("rejects cross-salon identity and payment-provider conflicts", () => {
    expect(action).toContain(
      "parsed.data.applicationId !== STUDIO_APPLICATION_ID",
    );
    expect(action).toContain('.eq("merchant_id", validated.merchantId)');
    expect(action).toContain('.eq("location_id", validated.locationId)');
    expect(action).not.toContain(
      "merchant_id.eq.${validated.merchantId}",
    );
    expect(action).not.toContain(
      "location_id.eq.${validated.locationId}",
    );
    expect(action).toContain('error: "account_conflict"');
    expect(action).toContain('error: "payment_provider_conflict"');
    expect(action).toContain('error: "saved_card_conflict"');
    expect(action).toContain(
      "parsed.data.accessToken,\n      parsed.data.applicationId,",
    );
  });

  it("audits only redacted metadata before writing the credential row", () => {
    const validationIndex = action.indexOf(
      "validated = await validateSquareProductionConnection",
    );
    const auditIndex = action.indexOf("await writeAuditLog");
    const upsertIndex = action.indexOf('.from("square_integrations")\n      .upsert');
    expect(validationIndex).toBeGreaterThan(-1);
    expect(validationIndex).toBeLessThan(auditIndex);
    expect(auditIndex).toBeGreaterThan(-1);
    expect(upsertIndex).toBeGreaterThan(auditIndex);
    expect(action).toContain("credentials_stored: Boolean(row.access_token)");
    const auditBlock = action.slice(auditIndex, upsertIndex);
    expect(auditBlock).not.toContain("parsed.data.accessToken");
  });

  it("compensates both the salon provider and integration on verification failure", () => {
    expect(action).toContain("let salonWritten = false");
    expect(action).toContain("salonWritten = true");
    expect(action).toContain("if (salonWritten)");
    expect(action).toContain("payment_provider: salon.payment_provider ?? null");
    expect(action).toContain("if (integrationWritten)");
  });

  it("updates only columns that exist on the salons table", () => {
    const salonWriteBlocks = action.match(
      /\.from\("salons"\)\s*\.update\(\{[\s\S]*?\}\s*as never\)/g,
    );
    expect(salonWriteBlocks).toHaveLength(2);
    for (const block of salonWriteBlocks ?? []) {
      expect(block).toContain("payment_provider");
      expect(block).not.toContain("updated_at");
    }
  });

  it("keeps every new Square write path and deposit switch off", () => {
    expect(action).toContain("deposit_enabled: sameIdentity");
    expect(action).toContain("sync_push_create: sameIdentity");
    expect(action).toContain("sync_push_update: sameIdentity");
    expect(action).toContain("sync_push_cancel: sameIdentity");
    expect(action).toContain(": false,");
    expect(component).toContain("no payment, booking, card, customer, or");
    expect(component).toContain("Square write-sync switches OFF");
  });

  it("submits the token as a password field and never renders it back", () => {
    expect(component).toContain('name="accessToken"');
    expect(component).toContain('type="password"');
    expect(component).not.toContain("result.connected.accessToken");
    expect(component).toContain("is never returned to this");
  });
});
