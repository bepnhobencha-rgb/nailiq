import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), "utf8");

describe("AI owner-preference boundary", () => {
  it("scopes learned decision history and mutations to one salon", () => {
    const preference = read("src/shared/ai/ownerPreference.ts");
    const mutations = read("src/shared/ai/lessonMutations.ts");

    expect(preference).toContain('.eq("salon_id"');
    expect(preference).toContain('.eq("action_type"');
    expect(preference).toContain('"payload->>proposal_source"');
    expect(mutations).toContain('.eq("salon_id" as never, params.salonId)');
    expect(mutations).toContain('"owner-preference"');
    expect(mutations).toContain('{ onConflict: "id" }');
  });

  it("only suppresses proposals and never adds a sender or execution authority", () => {
    const strategist = read("src/shared/ai/agentStrategist.ts");
    const preference = read("src/shared/ai/ownerPreference.ts");

    expect(strategist).toContain("proposal_suppressed_owner_preference");
    expect(strategist).toContain("!proposalCooldown");
    expect(preference).not.toMatch(/sendSms|sendEmail|enqueueApprovedAction/);
  });
});
