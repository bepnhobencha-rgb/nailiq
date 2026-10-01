import { describe, expect, it } from "vitest";

import {
  evaluatePilotAcceptance,
  PILOT_TASKS,
  type PilotParticipant,
  type PilotSalon,
} from "../pilotAcceptance";

const salons: PilotSalon[] = [
  { code: "S1", observedDays: 7, wantsToContinue: true, dataLossOccurred: false },
  { code: "S2", observedDays: 10, wantsToContinue: true, dataLossOccurred: false },
];

function participant(index: number): PilotParticipant {
  return {
    code: `P${index}`,
    salonCode: ["S1", "S2"][index % 2],
    role: index === 0 ? "owner" : "receptionist",
    olderOwner: index === 0,
    lowTech: index > 0,
    knownToTeam: false,
    techProfessional: false,
    firstShiftHelpCount: 0,
    tasks: PILOT_TASKS.map((task) => ({
      task,
      completed: true,
      independent: true,
      durationSeconds: task === "create_booking" ? 59 : task === "add_walkin" ? 29 : 10,
    })),
  };
}

describe("Master Plan two-salon pilot acceptance", () => {
  it("passes only with a complete qualifying human-observation record", () => {
    const result = evaluatePilotAcceptance({ salons, participants: Array.from({ length: 5 }, (_, i) => participant(i)) });
    expect(result.status).toBe("pass");
    expect(result.qualifiedParticipants).toBe(5);
    expect(result.gates.every((gate) => gate.status === "pass")).toBe(true);
  });

  it("does not call an incomplete pilot PASS", () => {
    const result = evaluatePilotAcceptance({ salons: salons.slice(0, 1), participants: [participant(0)] });
    expect(result.status).toBe("not_proven");
    expect(result.gates.find((gate) => gate.code === "two_salons")?.status).toBe("not_proven");
    expect(result.gates.find((gate) => gate.code === "required_people")?.status).toBe("not_proven");
  });

  it("does not silently accept the former three-salon shape", () => {
    const result = evaluatePilotAcceptance({
      salons: [...salons, { code: "S3", observedDays: 14, wantsToContinue: true, dataLossOccurred: false }],
      participants: Array.from({ length: 5 }, (_, i) => participant(i)),
    });
    expect(result.status).toBe("not_proven");
    expect(result.gates.find((gate) => gate.code === "two_salons")?.status).toBe("not_proven");
  });

  it("does not accept two different salons outside the approved S1/S2 cohort", () => {
    const result = evaluatePilotAcceptance({
      salons: [salons[0], { ...salons[1], code: "S3" }],
      participants: Array.from({ length: 5 }, (_, i) => ({
        ...participant(i),
        salonCode: i % 2 === 0 ? "S1" : "S3",
      })),
    });
    expect(result.status).toBe("not_proven");
    expect(result.gates.find((gate) => gate.code === "two_salons")?.status).toBe("not_proven");
  });

  it("requires an observed user at each of the two salons", () => {
    const people = Array.from({ length: 5 }, (_, i) => ({ ...participant(i), salonCode: "S1" }));
    const result = evaluatePilotAcceptance({ salons, participants: people });
    expect(result.status).toBe("not_proven");
    expect(result.gates.find((gate) => gate.code === "participants_by_salon")?.status).toBe("not_proven");
  });

  it("requires all three minimum participants to pass the 80% threshold", () => {
    const people = Array.from({ length: 3 }, (_, i) => participant(i));
    expect(evaluatePilotAcceptance({ salons, participants: people }).status).toBe("pass");
    people[0].tasks.find((task) => task.task === "create_booking")!.durationSeconds = 60;
    const result = evaluatePilotAcceptance({ salons, participants: people });
    expect(result.status).toBe("fail");
    expect(result.qualifiedParticipants).toBe(2);
  });

  it("requires 80% of people to complete all tasks independently within both time limits", () => {
    const participants = Array.from({ length: 5 }, (_, i) => participant(i));
    participants[0].tasks.find((task) => task.task === "create_booking")!.durationSeconds = 60;
    expect(evaluatePilotAcceptance({ salons, participants }).status).toBe("pass");
    participants[1].tasks.find((task) => task.task === "add_walkin")!.durationSeconds = 30;
    const result = evaluatePilotAcceptance({ salons, participants });
    expect(result.status).toBe("fail");
    expect(result.qualifiedParticipants).toBe(3);
  });

  it("fails immediately on any recorded data loss even if other evidence is missing", () => {
    const result = evaluatePilotAcceptance({
      salons: [{ ...salons[0], dataLossOccurred: true }],
      participants: [],
    });
    expect(result.status).toBe("fail");
    expect(result.gates.find((gate) => gate.code === "data_integrity")?.status).toBe("fail");
  });

  it("retains a measured help-limit failure when another person's help count is missing", () => {
    const people = Array.from({ length: 3 }, (_, i) => participant(i));
    people[0].firstShiftHelpCount = 2;
    people[1].firstShiftHelpCount = null;
    const result = evaluatePilotAcceptance({ salons, participants: people });
    expect(result.status).toBe("fail");
    expect(result.gates.find((gate) => gate.code === "first_shift_help")?.status).toBe("fail");
  });

  it("retains a salon's refusal when the other salon has not answered", () => {
    const result = evaluatePilotAcceptance({
      salons: [
        { ...salons[0], wantsToContinue: false },
        { ...salons[1], wantsToContinue: null },
      ],
      participants: Array.from({ length: 3 }, (_, i) => participant(i)),
    });
    expect(result.status).toBe("fail");
    expect(result.gates.find((gate) => gate.code === "salon_retention")?.status).toBe("fail");
  });

  it.each([6, 15])("retains an invalid %i-day observation window when the other window is missing", (observedDays) => {
    const result = evaluatePilotAcceptance({
      salons: [
        { ...salons[0], observedDays },
        { ...salons[1], observedDays: null },
      ],
      participants: Array.from({ length: 3 }, (_, i) => participant(i)),
    });
    expect(result.status).toBe("fail");
    expect(result.gates.find((gate) => gate.code === "observation_window")?.status).toBe("fail");
  });

  it("fails an already unreachable 80% task threshold even when another person is not fully measured", () => {
    const people = Array.from({ length: 5 }, (_, i) => participant(i));
    people[0].tasks.find((task) => task.task === "create_booking")!.durationSeconds = 60;
    people[1].tasks.find((task) => task.task === "add_walkin")!.independent = false;
    people[2].tasks[0].durationSeconds = null;
    const result = evaluatePilotAcceptance({ salons, participants: people });
    expect(result.status).toBe("fail");
    expect(result.gates.find((gate) => gate.code === "five_tasks_and_speed")?.status).toBe("fail");
  });

  it("keeps a still-reachable 80% task threshold unproven until all measurements are present", () => {
    const people = Array.from({ length: 5 }, (_, i) => participant(i));
    people[0].tasks.find((task) => task.task === "create_booking")!.durationSeconds = 60;
    people[1].tasks[0].durationSeconds = null;
    const result = evaluatePilotAcceptance({ salons, participants: people });
    expect(result.status).toBe("not_proven");
    expect(result.gates.find((gate) => gate.code === "five_tasks_and_speed")?.status).toBe("not_proven");
  });

  it("does not infer participant failure rates or help-limit results from duplicate identities", () => {
    const people = Array.from({ length: 3 }, (_, i) => participant(i));
    people[1].code = people[0].code;
    people[0].firstShiftHelpCount = 2;
    people[1].firstShiftHelpCount = null;
    people[0].tasks.find((task) => task.task === "create_booking")!.durationSeconds = 60;
    people[2].tasks[0].durationSeconds = null;
    const result = evaluatePilotAcceptance({ salons, participants: people });
    expect(result.status).toBe("not_proven");
    for (const code of ["participant_identity", "first_shift_help", "five_tasks_and_speed"]) {
      expect(result.gates.find((gate) => gate.code === code)?.status).toBe("not_proven");
    }
  });

  it("does not infer cohort-wide results from a single salon record", () => {
    const result = evaluatePilotAcceptance({
      salons: [{ ...salons[0], observedDays: 6, wantsToContinue: false }],
      participants: [participant(0)],
    });
    expect(result.status).toBe("not_proven");
    for (const code of ["two_salons", "observation_window", "salon_retention"]) {
      expect(result.gates.find((gate) => gate.code === code)?.status).toBe("not_proven");
    }
  });

  it("does not infer success from missing times, help counts, or continuation answers", () => {
    const people = Array.from({ length: 5 }, (_, i) => participant(i));
    people[0].tasks[0].durationSeconds = null;
    people[1].firstShiftHelpCount = null;
    const result = evaluatePilotAcceptance({
      salons: salons.map((salon, index) => index === 1 ? { ...salon, wantsToContinue: null } : salon),
      participants: people,
    });
    expect(result.status).toBe("not_proven");
    expect(result.gates.filter((gate) => gate.status === "not_proven").map((gate) => gate.code)).toEqual(
      expect.arrayContaining(["five_tasks_and_speed", "first_shift_help", "salon_retention"]),
    );
  });

  it("does not infer no data loss or salon consent from omitted runtime JSON fields", () => {
    const result = evaluatePilotAcceptance({
      salons: salons.map((salon, index) => index === 1
        ? { ...salon, dataLossOccurred: undefined, wantsToContinue: undefined } as unknown as PilotSalon
        : salon),
      participants: Array.from({ length: 5 }, (_, i) => participant(i)),
    });
    expect(result.status).toBe("not_proven");
    expect(result.gates.find((gate) => gate.code === "data_integrity")?.status).toBe("not_proven");
    expect(result.gates.find((gate) => gate.code === "salon_retention")?.status).toBe("not_proven");
  });

  it("treats an unknown task code in imported evidence as not proven, not a crash", () => {
    const people = Array.from({ length: 5 }, (_, i) => participant(i));
    people[0].tasks[0].task = "unknown_task" as PilotParticipant["tasks"][number]["task"];
    const result = evaluatePilotAcceptance({ salons, participants: people });
    expect(result.status).toBe("not_proven");
    expect(result.gates.find((gate) => gate.code === "five_tasks_and_speed")?.status).toBe("not_proven");
  });

  it("rejects more than one first-shift help request and fewer than two continuing salons", () => {
    const people = Array.from({ length: 5 }, (_, i) => participant(i));
    people[0].firstShiftHelpCount = 2;
    const result = evaluatePilotAcceptance({
      salons: salons.map((salon) => ({ ...salon, wantsToContinue: salon.code === "S1" })),
      participants: people,
    });
    expect(result.status).toBe("fail");
    expect(result.gates.find((gate) => gate.code === "first_shift_help")?.status).toBe("fail");
    expect(result.gates.find((gate) => gate.code === "salon_retention")?.status).toBe("fail");
  });
});
