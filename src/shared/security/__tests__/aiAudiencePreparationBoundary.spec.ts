import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const service = readFileSync(
  resolve(root, "src/shared/ai/audiencePreparation.ts"),
  "utf8",
);
const action = readFileSync(
  resolve(root, "src/shared/ai/prepareAudienceAction.ts"),
  "utf8",
);

describe("AI audience preparation boundary", () => {
  it("requires owner/admin and binds the service call to the resolved salon", () => {
    expect(action).toContain("getDashboardWriteClient(input.slug)");
    expect(action).toContain("isOwnerOrAdmin(ctx.role)");
    expect(action).toContain("salonId: ctx.salon.id");
  });

  it("keeps the execution job waiting for separate send authorization", () => {
    expect(service).toContain('job.status !== "waiting_input"');
    expect(service).toContain('blocker: "recipient_selection_required"');
    expect(service).toContain('.eq("status" as never, "waiting_input")');
    expect(service).toContain("no_messages_sent: true");
  });

  it("contains no outbound provider dependency", () => {
    expect(service).not.toContain("sendSmsReminder");
    expect(service).not.toContain("getResendClient");
    expect(service).not.toContain("twilio");
    expect(service).not.toContain(".emails.send");
  });
});
