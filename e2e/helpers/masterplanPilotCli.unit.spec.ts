import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PilotEvidenceFile } from "../../src/shared/pilot/pilotEvidenceFile";

const root = process.cwd();
const script = resolve(root, "scripts/qa/evaluate-masterplan-pilot.ts");
const fixtureRoot = resolve(root, "scripts/qa/fixtures");
const temporaryDirectories: string[] = [];

function temporaryPath(name = "evidence.json") {
  const directory = mkdtempSync(join(tmpdir(), "nailiq-pilot-cli-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function syntheticFixture(): PilotEvidenceFile {
  return JSON.parse(readFileSync(join(fixtureRoot, "masterplan-pilot-synthetic.json"), "utf8")) as PilotEvidenceFile;
}

function evidencePath(input: unknown) {
  const path = temporaryPath();
  writeFileSync(path, JSON.stringify(input));
  return path;
}

function run(...args: string[]) {
  // Execute the real CLI, not a mocked evaluator. No inherited credentials,
  // NODE_OPTIONS, dotenv, network client, database or provider is involved.
  // Node's tsx import avoids the separate tsx CLI IPC server in sandboxes.
  const result = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DISABLE_OUTBOUND_SMS: "1",
      DISABLE_OUTBOUND_EMAIL: "1",
      DISABLE_OUTBOUND_CALLS: "1",
      DISABLE_OUTBOUND_PAYMENTS: "1",
      DISABLE_PAYMENT_PROVIDER: "1",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  // Only directories created by this suite are removed, never submitted files.
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Master Plan pilot CLI process boundary (synthetic only)", () => {
  it("returns exit 1 for a passing synthetic formula and preserves the input", () => {
    const path = evidencePath(syntheticFixture());
    const before = readFileSync(path, "utf8");
    const result = run(path);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Kết quả tính toán: PASS");
    expect(result.stdout).toContain("Cổng nghiệm thu: NOT_PROVEN (DỮ LIỆU GIẢ)");
    expect(result.stderr).toBe("");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("returns exit 1 for the blank human template without claiming any observed person", () => {
    const result = run(join(fixtureRoot, "masterplan-pilot-human-blank.json"));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Cổng nghiệm thu: NOT_PROVEN");
    expect(result.stdout).toContain("Người đạt điều kiện: 0/0");
    expect(result.stderr).toBe("");
  });

  it("labels a qualifying human-shaped test record as self-declared, not independently verified", () => {
    // All numbers still come from the synthetic fixture. This is a CLI branch
    // test, NOT a real pilot result or a release certificate.
    const input = { ...syntheticFixture(), evidenceKind: "human_observation" };
    const result = run(evidencePath(input));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PHIẾU NGƯỜI THẬT TỰ KHAI — phải đối chiếu phiếu gốc có xác nhận");
    expect(result.stdout).toContain("Kết quả tính toán: PASS");
    expect(result.stderr).toBe("");
  });

  it("returns exit 1 for a measured failure even when the input claims human observation", () => {
    const input = syntheticFixture();
    input.evidenceKind = "human_observation";
    input.salons[0].dataLossOccurred = true;
    const result = run(evidencePath(input));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Cổng nghiệm thu: FAIL");
    expect(result.stdout).toContain("FAIL data_integrity");
  });

  it.each(["first_shift_help", "salon_retention", "observation_window", "five_tasks_and_speed"] as const)(
    "preserves decisive %s failure when another observation is missing",
    (gate) => {
      const input = syntheticFixture();
      input.evidenceKind = "human_observation";
      if (gate === "first_shift_help") {
        input.participants[0].firstShiftHelpCount = 2;
        input.participants[1].firstShiftHelpCount = null;
      } else if (gate === "salon_retention") {
        input.salons[0].wantsToContinue = false;
        input.salons[1].wantsToContinue = null;
      } else if (gate === "observation_window") {
        input.salons[0].observedDays = 6;
        input.salons[1].observedDays = null;
      } else {
        input.participants[0].tasks.find((task) => task.task === "create_booking")!.durationSeconds = 60;
        input.participants[1].tasks[0].durationSeconds = null;
      }
      const result = run(evidencePath(input));
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Cổng nghiệm thu: FAIL");
      expect(result.stdout).toContain(`FAIL ${gate}:`);
    },
  );

  it("rejects a third salon at the actual CLI boundary", () => {
    const input = syntheticFixture();
    input.salons[0].code = "S3";
    const result = run(evidencePath(input));
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid evidence fields: salons.0.code");
  });

  it("rejects accidental contact fields without printing their contents", () => {
    const input = syntheticFixture();
    const privateEmail = "cli-privacy-sentinel@example.invalid";
    const privatePhone = "+16045550123";
    const path = evidencePath({
      ...input,
      participants: [{ ...input.participants[0], email: privateEmail, phone: privatePhone }],
    });
    const result = run(path);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid evidence fields: participants.0");
    expect(result.stderr).not.toContain(privateEmail);
    expect(result.stderr).not.toContain(privatePhone);
    expect(result.stderr).not.toContain(path);
  });

  it("rejects malformed JSON without echoing its content or file name", () => {
    const path = temporaryPath("private-file-sentinel.json");
    writeFileSync(path, '{"private":"malformed-content-sentinel",');
    const result = run(path);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Could not read a valid local JSON evidence file");
    expect(result.stderr).not.toContain("malformed-content-sentinel");
    expect(result.stderr).not.toContain("private-file-sentinel");
  });

  it("rejects files above the 1 MB boundary before parsing", () => {
    const path = temporaryPath();
    writeFileSync(path, " ".repeat(1_000_001));
    const result = run(path);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("maximum 1 MB");
  });

  it("rejects missing files without leaking their path", () => {
    const path = temporaryPath("missing-private-sentinel.json");
    const result = run(path);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("missing-private-sentinel");
  });

  it("rejects a directory as evidence without reading its children", () => {
    const path = temporaryPath();
    const result = run(resolve(path, ".."));
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Could not read a valid local JSON evidence file");
  });

  it.each([[], ["private-argument-sentinel", "extra-argument-sentinel"]])(
    "rejects an invalid argument count without echoing submitted arguments: %j",
    (...args: string[]) => {
      const result = run(...args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage:");
      expect(result.stderr).not.toContain("private-argument-sentinel");
      expect(result.stderr).not.toContain("extra-argument-sentinel");
    },
  );
});
