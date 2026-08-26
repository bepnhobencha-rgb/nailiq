import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readJson = (path: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as {
    version?: string;
    packages?: Record<string, { version?: string }>;
  };

describe("NailIQ release metadata", () => {
  it("keeps the approved RC version synchronized across npm metadata", () => {
    const packageJson = readJson("package.json");
    const packageLock = readJson("package-lock.json");

    expect(packageJson.version).toBe("1.0.0-rc.1");
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages?.[""]?.version).toBe(packageJson.version);
  });

  it("records accountable owners without claiming an immutable deployment", () => {
    const release = readFileSync(
      resolve(process.cwd(), "docs/releases/NAILIQ-1.0.0-RC1.md"),
      "utf8",
    );

    expect(release).toContain("| QA Lead | John |");
    expect(release).toContain("| Engineering / Release Owner | John |");
    expect(release).toContain("LOCAL_CANDIDATE_NOT_IMMUTABLE");
    expect(release).toContain("No commit, push, merge, migration");
    expect(release).toContain("dpl_8DDqNon5zMDgX3c81WwWWzNWwL5J");
    expect(release).toContain("compatibility not proven");
  });
});
