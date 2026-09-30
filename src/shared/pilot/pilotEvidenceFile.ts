import { z } from "zod";

import { PILOT_TASKS, type PilotAcceptance, type PilotParticipant, type PilotSalon } from "./pilotAcceptance";

const salonCode = z.string().regex(/^S[0-9]{1,3}$/u);
const participantCode = z.string().regex(/^P[0-9]{1,4}$/u);
const observerCode = z.string().regex(/^OBS[0-9]{1,3}$/u);
const knownBoolean = z.boolean().nullable();
const optionalCount = z.number().int().nonnegative().nullable();

const taskSchema = z.strictObject({
  task: z.enum(PILOT_TASKS),
  completed: knownBoolean,
  independent: knownBoolean,
  durationSeconds: z.number().finite().nonnegative().nullable(),
});

const salonSchema = z.strictObject({
  code: salonCode,
  observedDays: optionalCount,
  wantsToContinue: knownBoolean,
  dataLossOccurred: knownBoolean,
});

const participantSchema = z.strictObject({
  code: participantCode,
  salonCode,
  role: z.enum(["owner", "receptionist"]),
  olderOwner: knownBoolean,
  lowTech: knownBoolean,
  knownToTeam: knownBoolean,
  techProfessional: knownBoolean,
  firstShiftHelpCount: optionalCount,
  tasks: z.array(taskSchema),
});

const evidenceSchema = z.strictObject({
  evidenceKind: z.enum(["synthetic", "human_observation"]),
  observerCode,
  salons: z.array(salonSchema),
  participants: z.array(participantSchema),
});

export type PilotEvidenceFile = {
  evidenceKind: "synthetic" | "human_observation";
  observerCode: string;
  salons: PilotSalon[];
  participants: PilotParticipant[];
};

/** A synthetic fixture can exercise the formula but must never pass a release gate. */
export function isPilotEvidencePassEligible(
  evidence: PilotEvidenceFile,
  result: PilotAcceptance,
): boolean {
  return evidence.evidenceKind === "human_observation" && result.status === "pass";
}

export function parsePilotEvidenceFile(input: unknown):
  | { ok: true; value: PilotEvidenceFile }
  | { ok: false; fields: string[] } {
  const result = evidenceSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  // Never echo submitted values: pilot files must not leak accidental PII via
  // terminal output, CI logs, or error reports.
  return {
    ok: false,
    fields: [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "root"))],
  };
}
