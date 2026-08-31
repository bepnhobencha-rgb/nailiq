import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EMAIL_EXPERIENCE_REGISTRY,
  registeredEmailSourceModules,
} from "@/shared/lib/emailExperienceRegistry";

const cwd = process.cwd();

function productionFiles(root: string): string[] {
  const absoluteRoot = resolve(cwd, root);
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const absolute = resolve(directory, entry);
      const path = relative(cwd, absolute).replaceAll("\\", "/");
      if (statSync(absolute).isDirectory()) {
        if (entry !== "__tests__") visit(absolute);
      } else if (/\.(?:ts|tsx)$/.test(entry) && !/\.(?:spec|test)\./.test(entry)) {
        found.push(path);
      }
    }
  };
  visit(absoluteRoot);
  return found;
}

describe("email experience registry boundary", () => {
  it("registers every production Resend dispatch module", () => {
    const dispatchers = [
      ...productionFiles("src"),
      ...productionFiles("supabase/functions"),
    ].filter((path) => {
      if (path === "src/shared/lib/emailCompliance.ts") return false;
      const source = readFileSync(resolve(cwd, path), "utf8");
      return /\bemails\.send\s*\(|api\.resend\.com\/emails/.test(source);
    });

    expect(registeredEmailSourceModules()).toEqual(
      expect.arrayContaining(dispatchers),
    );
    for (const path of dispatchers) {
      const source = readFileSync(resolve(cwd, path), "utf8");
      expect(source, path).toMatch(/emailExperienceTags|buildEmailExperience|nailiq_email/);
    }
  });

  it("assigns signed receipt truth without weakening stronger domain evidence", () => {
    const definitions = Object.values(EMAIL_EXPERIENCE_REGISTRY);
    expect(definitions.some(
      (definition) => definition.deliveryTruth === "registered_webhook",
    )).toBe(true);
    expect(definitions.some(
      (definition) => definition.deliveryTruth === "domain_outbox_and_registered_webhook",
    )).toBe(true);
    for (const definition of definitions) {
      expect([
        "customer_booking",
        "owner_booking",
        "booking_otp",
        "registered_webhook",
        "domain_outbox_and_registered_webhook",
      ]).toContain(definition.deliveryTruth);
    }
  });
});
