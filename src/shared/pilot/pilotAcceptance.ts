/** Pure scorecard for the two-salon Master Plan pilot. No customer data or I/O. */
export const PILOT_TASKS = [
  "view_today",
  "create_booking",
  "add_walkin",
  "change_status",
  "find_customer",
] as const;

/** The owner-approved cohort; codes are intentionally opaque to the scorer. */
export const PILOT_SALON_CODES = ["S1", "S2"] as const;

export type PilotTask = (typeof PILOT_TASKS)[number];
export type PilotGateStatus = "pass" | "fail" | "not_proven";

export type PilotTaskObservation = {
  task: PilotTask;
  completed: boolean | null;
  independent: boolean | null;
  durationSeconds: number | null;
};

export type PilotParticipant = {
  /** Opaque pilot code, never a name, phone, email, or NailIQ user ID. */
  code: string;
  salonCode: string;
  role: "owner" | "receptionist";
  olderOwner: boolean | null;
  lowTech: boolean | null;
  knownToTeam: boolean | null;
  techProfessional: boolean | null;
  firstShiftHelpCount: number | null;
  tasks: PilotTaskObservation[];
};

export type PilotSalon = {
  code: string;
  observedDays: number | null;
  wantsToContinue: boolean | null;
  dataLossOccurred: boolean | null;
};

export type PilotGate = {
  code: string;
  status: PilotGateStatus;
  detail: string;
};

export type PilotAcceptance = {
  status: PilotGateStatus;
  gates: PilotGate[];
  qualifiedParticipants: number;
  measuredParticipants: number;
};

function uniqueCodes(values: string[]): boolean {
  return values.every((value) => typeof value === "string" && value.trim().length > 0) &&
    new Set(values.map((value) => value.trim())).size === values.length;
}

function validCount(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function taskSet(participant: PilotParticipant): Map<PilotTask, PilotTaskObservation> | null {
  const map = new Map(participant.tasks.map((task) => [task.task, task]));
  return map.size === PILOT_TASKS.length && participant.tasks.length === PILOT_TASKS.length &&
    PILOT_TASKS.every((task) => map.has(task))
    ? map
    : null;
}

/**
 * Conservative interpretation of the Master Plan: the same >=80% of new users
 * must finish all five tasks without help, with booking <60s and walk-in <30s.
 * This scorecard is evidence processing, never a substitute for human observation.
 */
export function evaluatePilotAcceptance(input: {
  salons: PilotSalon[];
  participants: PilotParticipant[];
}): PilotAcceptance {
  const { salons, participants } = input;
  const gates: PilotGate[] = [];
  const add = (code: string, status: PilotGateStatus, detail: string) => {
    gates.push({ code, status, detail });
  };

  if (salons.length !== PILOT_SALON_CODES.length ||
    !uniqueCodes(salons.map((salon) => salon.code)) ||
    !PILOT_SALON_CODES.every((code) => salons.some((salon) => salon.code === code))) {
    add("two_salons", "not_proven", "Cần đúng hai salon S1/S2 trong cohort nghiệm thu.");
  } else {
    add("two_salons", "pass", "Đã có đúng hai salon S1/S2.");
  }

  if (salons.length !== 2 || salons.some((salon) => salon.observedDays == null)) {
    add("observation_window", "not_proven", "Thiếu số ngày quan sát của hai salon.");
  } else if (salons.some((salon) => !validCount(salon.observedDays) || salon.observedDays < 7 || salon.observedDays > 14)) {
    add("observation_window", "fail", "Mỗi salon cần 7–14 ngày quan sát hợp lệ.");
  } else {
    add("observation_window", "pass", "Cả hai salon được quan sát 7–14 ngày.");
  }

  const salonCodes = new Set(salons.map((salon) => salon.code));
  const validParticipants = participants.length > 0 &&
    uniqueCodes(participants.map((participant) => participant.code)) &&
    participants.every((participant) => salonCodes.has(participant.salonCode));
  add(
    "participant_identity",
    validParticipants ? "pass" : "not_proven",
    validParticipants ? "Mã người thử riêng biệt và gắn đúng salon." : "Thiếu người thử hoặc mã người thử/salon không hợp lệ.",
  );
  const everySalonObserved = salons.length === 2 && salons.every((salon) =>
    participants.some((participant) => participant.salonCode === salon.code),
  );
  add(
    "participants_by_salon",
    validParticipants && everySalonObserved ? "pass" : "not_proven",
    "Cần ít nhất một người thử trực tiếp tại mỗi salon.",
  );

  const hasOlderOwner = participants.some((participant) => participant.role === "owner" && participant.olderOwner === true);
  const hasTwoLowTechReceptionists = participants.filter((participant) =>
    participant.role === "receptionist" && participant.lowTech === true,
  ).length >= 2;
  add(
    "required_people",
    validParticipants && hasOlderOwner && hasTwoLowTechReceptionists ? "pass" : "not_proven",
    "Cần ít nhất một chủ lớn tuổi và hai tiếp tân ít dùng công nghệ.",
  );

  const hasIndependentRecruit = participants.some((participant) =>
    participant.knownToTeam === false && participant.techProfessional === false,
  );
  add(
    "recruitment_mix",
    validParticipants && hasIndependentRecruit ? "pass" : "not_proven",
    "Cần chứng minh mẫu thử không chỉ gồm người quen hoặc người làm kỹ thuật.",
  );

  if (!validParticipants || participants.some((participant) => participant.firstShiftHelpCount == null)) {
    add("first_shift_help", "not_proven", "Thiếu số lần cần giúp trong ca đầu của từng người thử.");
  } else if (participants.some((participant) => !validCount(participant.firstShiftHelpCount) || participant.firstShiftHelpCount > 1)) {
    add("first_shift_help", "fail", "Có người cần giúp quá một lần trong ca đầu.");
  } else {
    add("first_shift_help", "pass", "Mỗi người cần giúp không quá một lần trong ca đầu.");
  }

  let qualifiedParticipants = 0;
  const measurementsComplete = validParticipants && participants.every((participant) => {
    const tasks = taskSet(participant);
    return tasks !== null && PILOT_TASKS.every((taskName) => {
      const task = tasks.get(taskName)!;
      return typeof task.completed === "boolean" && typeof task.independent === "boolean" &&
        typeof task.durationSeconds === "number" && Number.isFinite(task.durationSeconds) && task.durationSeconds >= 0;
    });
  });
  if (!measurementsComplete) {
    add("five_tasks_and_speed", "not_proven", "Thiếu kết quả/thời gian của một trong năm việc cho ít nhất một người.");
  } else {
    qualifiedParticipants = participants.filter((participant) => {
      const tasks = taskSet(participant)!;
      const booking = tasks.get("create_booking")!;
      const walkin = tasks.get("add_walkin")!;
      return PILOT_TASKS.every((taskName) => {
        const task = tasks.get(taskName)!;
        return task.completed === true && task.independent === true;
      }) && booking.durationSeconds! < 60 && walkin.durationSeconds! < 30;
    }).length;
    const pass = qualifiedParticipants / participants.length >= 0.8;
    add(
      "five_tasks_and_speed",
      pass ? "pass" : "fail",
      `${qualifiedParticipants}/${participants.length} người tự hoàn thành đủ năm việc; tạo hẹn <60 giây và walk-in <30 giây.`,
    );
  }

  if (salons.some((salon) => salon.dataLossOccurred === true)) {
    add("data_integrity", "fail", "Có sự cố mất dữ liệu; phải dừng pilot và điều tra.");
  } else if (salons.length !== 2 || salons.some((salon) => typeof salon.dataLossOccurred !== "boolean")) {
    add("data_integrity", "not_proven", "Thiếu xác nhận không mất dữ liệu ở hai salon.");
  } else {
    add("data_integrity", "pass", "Không ghi nhận mất dữ liệu ở hai salon.");
  }

  if (salons.length !== 2 || salons.some((salon) => typeof salon.wantsToContinue !== "boolean")) {
    add("salon_retention", "not_proven", "Thiếu câu trả lời muốn tiếp tục của hai salon.");
  } else {
    const continuing = salons.filter((salon) => salon.wantsToContinue === true).length;
    add("salon_retention", continuing === 2 ? "pass" : "fail", `${continuing}/2 salon muốn tiếp tục.`);
  }

  const status = gates.some((gate) => gate.status === "fail")
    ? "fail"
    : gates.some((gate) => gate.status === "not_proven") ? "not_proven" : "pass";
  return { status, gates, qualifiedParticipants, measuredParticipants: participants.length };
}
