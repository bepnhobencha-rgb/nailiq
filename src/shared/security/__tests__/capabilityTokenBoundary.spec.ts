import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260724071500_deny_direct_capability_token_access.sql",
);
const proof = read(
  "scripts/security/check-capability-token-boundary.sql",
);
const rollback = read(
  "scripts/security/rehearse-capability-token-boundary-rollback.sql",
);

const tables = [
  "party_links",
  "party_link_claims",
  "party_link_change_requests",
  "salon_invite_tokens",
];

describe("capability-token boundary", () => {
  it("removes direct API grants and preserves service-role access", () => {
    for (const table of tables) {
      expect(migration).toContain(`public.${table}`);
      expect(proof).toContain(`'${table}'`);
    }
    expect(migration.match(/REVOKE ALL PRIVILEGES/g)).toHaveLength(4);
    expect(migration.match(/GRANT ALL PRIVILEGES/g)).toHaveLength(4);
    expect(proof).toMatch(
      /has_any_column_privilege\(\s*'authenticated'/,
    );
  });

  it("adds one restrictive false policy per table", () => {
    expect(migration.match(/AS RESTRICTIVE/g)).toHaveLength(4);
    expect(migration.match(/USING \(false\)/g)).toHaveLength(4);
    expect(migration.match(/WITH CHECK \(false\)/g)).toHaveLength(4);
    expect(proof).toContain("v_policy_count <> 1");
    expect(proof).toContain("AND NOT polpermissive");
  });

  it("rehearses the exact legacy grants inside a rollback", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("ROLLBACK;");
    expect(rollback.match(/GRANT ALL PRIVILEGES ON TABLE/g)).toHaveLength(4);
    expect(rollback).toContain(
      "\\ir check-capability-token-boundary.sql",
    );
  });

  it("keeps every direct table access path on a server service client", () => {
    const partyActions = read("src/shared/booking/partyLinkActions.ts");
    const rsvpActions = read(
      "src/shared/booking/groupMemberRsvpActions.ts",
    );
    const partyCards = read(
      "src/shared/dashboard/loadPartyCardsAction.ts",
    );
    const inviteActions = read(
      "src/shared/dashboard/inviteTokenActions.ts",
    );
    const receptionist = read(
      "src/shared/dashboard/receptionistActions.ts",
    );
    const partyPage = read("src/app/party/[token]/page.tsx");

    for (const source of [
      partyActions,
      rsvpActions,
      partyCards,
      inviteActions,
    ]) {
      expect(source).toContain('"use server"');
      expect(source).toContain("createServiceRoleClient");
    }
    expect(receptionist).toContain("createServiceRoleClient");
    expect(partyPage).toContain("createServiceRoleClient");
  });

  it("updates the blank-database parity tripwire", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("policies: 151");
    expect(parity).toContain(
      "const GRANTS = { anon: 57, authenticated: 64, service_role: 105 }",
    );
  });
});
