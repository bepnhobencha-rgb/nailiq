import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const artifacts=process.env.NAILIQ_QA_ARTIFACT_DIR!;
export default defineConfig({testDir:"./e2e",testMatch:"p0-removal-recovery-outcomes.spec.ts",workers:1,retries:0,timeout:90000,
 use:{trace:"off",screenshot:"off",video:"off"},outputDir:resolve(artifacts,"artifacts"),
 reporter:[["list"],["json",{outputFile:resolve(artifacts,"results.json")}]]});
