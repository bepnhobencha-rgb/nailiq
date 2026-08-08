import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const mutations = readFileSync(
  resolve(root, "src/shared/ai/lessonMutations.ts"),
  "utf8",
);
const analysis = readFileSync(
  resolve(root, "src/shared/ai/analyzeOutcomes.ts"),
  "utf8",
);
const tracker = readFileSync(
  resolve(root, "src/shared/ai/agentOutcomeTracker.ts"),
  "utf8",
);
const agents = [
  "src/shared/winback/agentWinback.ts",
  "src/shared/winback/agentRebook.ts",
  "src/shared/firstvisit/agentFirstVisit.ts",
  "src/shared/ai/agentVipCare.ts",
].map((file) => readFileSync(resolve(root, file), "utf8"));

describe("AI outcome adaptation boundary", () => {
  it("binds adaptive lesson reads and writes to one salon", () => {
    expect(mutations).toContain('.eq("salon_id" as never, params.salonId)');
    expect(mutations).toContain('scope: "segment"');
    expect(mutations).toContain("outcome_adaptation:");
    expect(mutations).toContain("outcomeAdaptationId");
    expect(mutations).toContain('{ onConflict: "id" }');
  });

  it("recovers historical phones and follows only active salon aliases", () => {
    expect(tracker).toContain("loadHistoricalTargetPhones");
    expect(tracker).toContain('.eq("salon_id" as never, salonId)');
    expect(tracker).toContain("loadCanonicalProfilesByPhone");
    expect(tracker).toContain(
      '.from("salon_client_identity_aliases" as never)',
    );
    expect(tracker).toContain('.eq("active" as never, true)');
    expect(tracker).toContain('.eq("client_profile_id", canonicalProfileId)');
    expect(tracker).toContain('.in("client_phone", lookupPhones)');
  });

  it("records a phone for every newly trackable customer action", () => {
    for (const agent of agents) {
      expect(agent).toMatch(/payload:\s*\{[\s\S]{0,180}phone[,:]/);
    }
  });

  it("uses resolution time for the rolling outcome window", () => {
    expect(tracker).toContain('.gte("outcome_at", since)');
    expect(analysis).toContain('.gte("outcome_at" as never, since)');
  });

  it("bounds last-touch attribution and surfaces persistence failures", () => {
    expect(tracker).toContain("nextNewerTouchByIdentity");
    expect(tracker).toContain('profileQuery.lte("created_at"');
    expect(tracker).toContain('profileQuery.lt("created_at"');
    expect(tracker).toContain(
      ".find((candidate) => !attributedBookingIds.has(candidate.id))",
    );
    expect(tracker).toContain("if (actionsError) throw");
    expect(tracker).toContain("if (updateError) throw");
  });

  it("applies learned caps without introducing a new sender", () => {
    for (const agent of agents) {
      expect(agent).toContain("applyLearnedAgentCap");
    }
    expect(mutations).not.toContain("sendSmsReminder");
    expect(mutations).not.toContain("getResendClient");
  });
});
