import { readFile, stat } from "node:fs/promises";

import { evaluatePilotAcceptance } from "../../src/shared/pilot/pilotAcceptance";
import { isPilotEvidencePassEligible, parsePilotEvidenceFile } from "../../src/shared/pilot/pilotEvidenceFile";

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length !== 3) {
    console.error("Usage: npx tsx scripts/qa/evaluate-masterplan-pilot.ts <local-aggregate.json>");
    process.exitCode = 2;
    return;
  }

  let input: unknown;
  try {
    const metadata = await stat(inputPath);
    if (!metadata.isFile() || metadata.size > 1_000_000) throw new Error("invalid_input");
    input = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    console.error("Could not read a valid local JSON evidence file (maximum 1 MB).");
    process.exitCode = 2;
    return;
  }

  const parsed = parsePilotEvidenceFile(input);
  if (!parsed.ok) {
    console.error(`Invalid evidence fields: ${parsed.fields.join(", ")}`);
    process.exitCode = 2;
    return;
  }

  const result = evaluatePilotAcceptance(parsed.value);
  const label = parsed.value.evidenceKind === "synthetic"
    ? "DỮ LIỆU GIẢ — chỉ kiểm thử bộ chấm, không phải bằng chứng pilot"
    : "PHIẾU NGƯỜI THẬT TỰ KHAI — phải đối chiếu phiếu gốc có xác nhận";
  console.log(label);
  console.log(`Kết quả tính toán: ${result.status.toUpperCase()}`);
  console.log(`Cổng nghiệm thu: ${parsed.value.evidenceKind === "synthetic" ? "NOT_PROVEN (DỮ LIỆU GIẢ)" : result.status.toUpperCase()}`);
  console.log(`Người đạt điều kiện: ${result.qualifiedParticipants}/${result.measuredParticipants}`);
  for (const gate of result.gates) {
    console.log(`${gate.status.toUpperCase()} ${gate.code}: ${gate.detail}`);
  }
  if (!isPilotEvidencePassEligible(parsed.value, result)) process.exitCode = 1;
}

void main();
