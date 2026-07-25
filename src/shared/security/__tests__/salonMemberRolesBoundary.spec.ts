import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260725192550_allow_operational_salon_member_roles.sql",
  ),
  "utf8",
);

describe("salon member authorization roles", () => {
  it.each(["owner", "admin", "senior", "receptionist", "nail_tech"])(
    "permits the %s role",
    (role) => {
      expect(migration).toContain(`'${role}'`);
    },
  );
});
