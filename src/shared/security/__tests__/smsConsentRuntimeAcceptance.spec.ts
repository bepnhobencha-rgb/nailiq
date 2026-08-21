import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { requireSmsConsentClear } from "../../../../supabase/functions/_shared/smsConsentSuppression";

function productionFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") files.push(...productionFiles(absolute));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

describe("MQA-0102 SMS STOP/START runtime adoption", () => {
  const salonId = "11111111-1111-4111-8111-111111111111";
  const hashKeyId = "22222222-2222-4222-8222-222222222222";
  const phoneHash = "a".repeat(64);

  function edgeClient(rows: unknown[]) {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: rows[0], error: null })
      .mockResolvedValueOnce({ data: rows[1], error: null });
    return { db: { rpc }, rpc };
  }

  it("allows an Edge Function provider call only for the exact DB clear result", async () => {
    const { db, rpc } = edgeClient([
      { success: true, code: "hashed", contract_version: 1, phone_hash: phoneHash, hash_key_id: hashKeyId },
      {
        success: true, code: "clear", contract_version: 1, suppressed: false,
        reason: "clear", affirmative_consent_not_evaluated: true,
      },
    ]);
    await expect(requireSmsConsentClear(db, salonId, "+16045550123")).resolves.toEqual({
      allowed: true,
      reason: "clear",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "load_sms_outbound_suppression", {
      p_salon_id: salonId,
      p_phone_hash: phoneHash,
      p_hash_key_id: hashKeyId,
    });
  });

  it("preserves provider STOP and fails closed when Edge Function consent truth is unavailable", async () => {
    const stopped = edgeClient([
      { success: true, code: "hashed", contract_version: 1, phone_hash: phoneHash, hash_key_id: hashKeyId },
      {
        success: true, code: "suppressed", contract_version: 1, suppressed: true,
        reason: "provider_stop", affirmative_consent_not_evaluated: true,
      },
    ]);
    await expect(requireSmsConsentClear(stopped.db, salonId, "+16045550123")).resolves.toEqual({
      allowed: false,
      reason: "provider_stop",
    });

    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "unavailable" } });
    await expect(requireSmsConsentClear({ rpc }, salonId, "+16045550123")).resolves.toEqual({
      allowed: false,
      reason: "consent_unavailable",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("requires an exact salonId at every production Next.js SMS dispatch", () => {
    const missing: string[] = [];
    for (const file of productionFiles(path.join(process.cwd(), "src"))) {
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("sendSmsReminder(")) continue;
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
          node.expression.text === "sendSmsReminder"
        ) {
          const options = node.arguments[2];
          if (!options || !/\bsalonId\b/.test(options.getText(ast))) {
            const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
            missing.push(`${path.relative(process.cwd(), file)}:${line}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(missing).toEqual([]);
  });

  it("gates every legacy Edge Function Twilio Messages call before provider dispatch", () => {
    const root = path.join(process.cwd(), "supabase/functions");
    const bypasses: string[] = [];
    for (const file of productionFiles(root)) {
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("api.twilio.com/2010-04-01/Accounts") || file.includes("_shared")) continue;
      // Voice transfer is not an SMS Messages endpoint.
      if (!source.includes("/Messages.json")) continue;
      if (
        !source.includes('from "../_shared/smsConsentSuppression.ts"') ||
        (source.match(/requireSmsConsentClear\(/g)?.length ?? 0) < 1
      ) bypasses.push(path.relative(process.cwd(), file));
    }
    expect(bypasses).toEqual([]);
  });

  it("keeps both signed inbound webhooks bounded and provider opt-out aware", () => {
    for (const file of [
      "src/app/api/twilio/inbound/route.ts",
      "src/app/api/twilio/sms/route.ts",
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source).toContain("readUrlEncodedFormWithLimit(req, 16_384)");
      expect(source).toContain("classifyInboundSmsCommand");
      expect(source).toContain("recordInboundSmsConsent");
      expect(source.indexOf("validateTwilioSignature")).toBeLessThan(source.lastIndexOf("recordInboundSmsConsent({"));
    }
  });
});
