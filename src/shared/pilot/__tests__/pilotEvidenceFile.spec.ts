import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { evaluatePilotAcceptance, PILOT_TASKS } from "../pilotAcceptance";
import { isPilotEvidencePassEligible, parsePilotEvidenceFile } from "../pilotEvidenceFile";

function validFile() {
  return {
    evidenceKind: "synthetic",
    observerCode: "OBS1",
    salons: [{ code: "S1", observedDays: 7, wantsToContinue: true, dataLossOccurred: false }],
    participants: [{
      code: "P1",
      salonCode: "S1",
      role: "owner",
      olderOwner: true,
      lowTech: false,
      knownToTeam: false,
      techProfessional: false,
      firstShiftHelpCount: 0,
      tasks: PILOT_TASKS.map((task) => ({ task, completed: true, independent: true, durationSeconds: 10 })),
    }],
  };
}

describe("pilot evidence file boundary", () => {
  it("accepts only the narrow aggregate shape", () => {
    expect(parsePilotEvidenceFile(validFile()).ok).toBe(true);
  });

  it.each(["S0", "S3", "S999", "S01", "S2 "])("rejects out-of-cohort salon code %s at both input boundaries", (code) => {
    const file = validFile();
    const salonResult = parsePilotEvidenceFile({ ...file, salons: [{ ...file.salons[0], code }] });
    const participantResult = parsePilotEvidenceFile({
      ...file,
      participants: [{ ...file.participants[0], salonCode: code }],
    });
    expect(salonResult).toEqual({ ok: false, fields: ["salons.0.code"] });
    expect(participantResult).toEqual({ ok: false, fields: ["participants.0.salonCode"] });
  });

  it.each(["S1", "S2"])("accepts approved salon code %s at both input boundaries", (code) => {
    const file = validFile();
    expect(parsePilotEvidenceFile({
      ...file,
      salons: [{ ...file.salons[0], code }],
      participants: [{ ...file.participants[0], salonCode: code }],
    }).ok).toBe(true);
  });

  it("never treats a passing synthetic calculation as release proof", () => {
    const synthetic = parsePilotEvidenceFile(validFile());
    expect(synthetic.ok).toBe(true);
    if (!synthetic.ok) return;
    expect(isPilotEvidencePassEligible(synthetic.value, { status: "pass", gates: [], qualifiedParticipants: 1, measuredParticipants: 1 })).toBe(false);
    expect(isPilotEvidencePassEligible({ ...synthetic.value, evidenceKind: "human_observation" }, { status: "pass", gates: [], qualifiedParticipants: 1, measuredParticipants: 1 })).toBe(true);
    expect(isPilotEvidencePassEligible({ ...synthetic.value, evidenceKind: "human_observation" }, { status: "not_proven", gates: [], qualifiedParticipants: 0, measuredParticipants: 0 })).toBe(false);
  });

  it("rejects extra personal details and never echoes values in errors", () => {
    const file = validFile();
    const withPii = { ...file, participants: [{ ...file.participants[0], email: "private@example.invalid" }] };
    const result = parsePilotEvidenceFile(withPii);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fields).toContain("participants.0");
      expect(JSON.stringify(result.fields)).not.toContain("private@example.invalid");
    }
  });

  it("rejects invalid codes and negative durations", () => {
    const file = validFile();
    file.participants[0].code = "HUY";
    file.participants[0].tasks[0].durationSeconds = -1;
    expect(parsePilotEvidenceFile(file).ok).toBe(false);
  });

  it("rejects a missing data-loss answer instead of defaulting to no loss", () => {
    const file = validFile();
    const salon = { ...file.salons[0] } as Partial<typeof file.salons[number]>;
    delete salon.dataLossOccurred;
    expect(parsePilotEvidenceFile({ ...file, salons: [salon] }).ok).toBe(false);
  });

  it("keeps the blank two-salon human template unproven", () => {
    const template = JSON.parse(readFileSync(resolve(
      process.cwd(),
      "scripts/qa/fixtures/masterplan-pilot-human-blank.json",
    ), "utf8")) as unknown;
    const result = parsePilotEvidenceFile(template);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidenceKind).toBe("human_observation");
    expect(result.value.salons.map((salon) => salon.code)).toEqual(["S1", "S2"]);
    expect(result.value.salons.every((salon) => salon.observedDays === null &&
      salon.wantsToContinue === null && salon.dataLossOccurred === null)).toBe(true);
    expect(result.value.participants).toEqual([]);
    expect(evaluatePilotAcceptance(result.value).status).toBe("not_proven");
  });
});
