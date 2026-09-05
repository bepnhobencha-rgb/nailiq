import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(
    process.cwd(),
    ".github/workflows/remote-qa-certification.yml",
  ),
  "utf8",
);

describe("Remote QA Certification safety boundary", () => {
  it("checks out and verifies one immutable candidate SHA", () => {
    expect(workflow).toContain("candidate_sha:");
    expect(workflow).toContain(
      '[[ "${target}" =~ ^[0-9a-f]{40}$ ]]',
    );
    expect(workflow).toContain("ref: ${{ steps.target.outputs.sha }}");
    expect(workflow).toContain(
      'test "$(git rev-parse HEAD)" = "${{ steps.target.outputs.sha }}"',
    );
    expect(workflow).toContain("persist-credentials: false");
  });

  it("uses a schema-only disposable database and production guard", () => {
    expect(workflow).toContain("supabase start");
    expect(workflow).toContain("scripts/assert-e2e-not-production.ts");
    expect(workflow).toContain("scripts/apply-baseline.sh");
    expect(workflow).toContain("scripts/check-schema-parity.ts");
    expect(workflow).toContain("scripts/seed-e2e.ts");
    expect(workflow).toContain("NAILIQ_DISPOSABLE_DB: \"1\"");
    expect(workflow).not.toContain("fshmobzyjhmtvndobwsy");
    expect(workflow).not.toContain("nailiq.ca");
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("hard-disables every outbound and payment path", () => {
    for (const expected of [
      'DISABLE_OUTBOUND_SMS: "1"',
      'DISABLE_OUTBOUND_EMAIL: "1"',
      'DISABLE_OUTBOUND_CALLS: "1"',
      'NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH: "false"',
      'NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH: "false"',
      'NAILIQ_SQUARE_PAYMENT_WEBHOOK_INGESTION: "false"',
      'PAYMENT_LEDGER_WORKERS_ENABLED: "false"',
      'SMART_CHECKOUT_SANDBOX_DISPATCH_ENABLED: "0"',
      'SMART_CHECKOUT_SANDBOX_PROVIDER_READS_ENABLED: "0"',
      'SMART_CHECKOUT_SANDBOX_PAIRING_ENABLED: "0"',
      'SMART_CHECKOUT_SANDBOX_WEBHOOK_INGESTION_ENABLED: "0"',
      'SMART_CHECKOUT_RECONCILIATION_ENABLED: "0"',
      'TWILIO_AUTH_TOKEN: ""',
      'RESEND_API_KEY: ""',
      'STRIPE_SECRET_KEY: ""',
      'SQUARE_WEBHOOK_PROFILES_JSON: "[]"',
      'ANTHROPIC_API_KEY: ""',
      'OPENAI_API_KEY: ""',
      'WIX_API_KEY: ""',
    ]) {
      expect(workflow).toContain(expected);
    }
  });

  it("always sweeps fixtures, destroys the database and uploads evidence", () => {
    expect(workflow).toMatch(
      /name: Sweep marker-owned fixtures\n\s+if: always\(\)\n\s+run: npx tsx scripts\/e2e-sweep\.ts/,
    );
    expect(workflow).toMatch(
      /name: Destroy disposable Supabase\n\s+if: always\(\)\n\s+run: supabase stop --no-backup/,
    );
    expect(workflow).toContain("actions/upload-artifact@v7");
    expect(workflow).toContain("retention-days: 14");
  });

  it("keeps repository permissions read-only", () => {
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(workflow).not.toMatch(/pull-requests:\s*write/);
    expect(workflow).not.toMatch(/id-token:\s*write/);
  });
});
