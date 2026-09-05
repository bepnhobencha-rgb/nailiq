import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const actions = readFileSync(
  resolve(root, "src/shared/dashboard/receptionistActions.ts"),
  "utf8",
);
const addForm = readFileSync(
  resolve(root, "src/components/receptionist/WalkinAddForm.tsx"),
  "utf8",
);
const sidebar = readFileSync(
  resolve(root, "src/components/receptionist/WalkinQueueSidebar.tsx"),
  "utf8",
);
const drawer = readFileSync(
  resolve(root, "src/components/receptionist/WalkinContactDrawer.tsx"),
  "utf8",
);

describe("progressive walk-in contact boundary", () => {
  it("requires only name and service for initial intake", () => {
    expect(addForm).toContain("clientPhone: string | null");
    expect(addForm).toContain("clientPhone: trimmedPhone || null");
    expect(addForm).not.toContain("setPhoneError(labels.phoneRequired)");
    expect(addForm).toContain("phoneOptionalHint");
  });

  it("keeps contact updates salon-scoped and restricted to waiting walk-ins", () => {
    const boundary = actions.slice(
      actions.indexOf("export async function updateWalkinContact"),
      actions.indexOf("export async function cancelWaitingWalkin"),
    );
    expect(boundary).toContain('.eq("salon_id", ctx.salon.id)');
    expect(boundary).toContain('.eq("source", "walkin")');
    expect(boundary).toContain('.eq("status", "waiting")');
    expect(boundary).toContain("hasPhone: contact.phone !== null");
    expect(boundary).not.toContain("sms_consent_at:");
  });

  it("never treats staff-entered contact as SMS consent or sends automatically", () => {
    expect(drawer).toContain("smsConsentNo");
    expect(drawer).not.toContain("sendSms");
    expect(drawer).not.toContain("sendEmail");
    expect(actions).toContain("walkin_contact_updated");
  });

  it("gates step-out hold on having a contact method", () => {
    expect(sidebar).toContain('mode: "step_out"');
    expect(sidebar).toContain("if (hasContact)");
    expect(sidebar).toContain("holdAfterSave");
  });
});
