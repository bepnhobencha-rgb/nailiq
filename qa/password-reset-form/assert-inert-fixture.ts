import { readFileSync } from "node:fs";

export function assertInertFixture() {
  const manifest = JSON.parse(readFileSync("qa/password-reset-form/.next/server/server-reference-manifest.json", "utf8"));
  const actions = Object.values(manifest.node) as { filename: string; exportedName: string }[];
  const expectedActions = [
    "action.ts:completeSalonOwnerPasswordReset",
    "email-password-action.ts:authenticateWithEmailPassword",
    "email-password-action.ts:resendSignupConfirmationEmail",
    "magic-link-action.ts:sendEmailMagicLink",
    "superadmin-action.ts:completeSuperadminPasswordReset",
  ];
  if (JSON.stringify(actions.map(action => `${action.filename}:${action.exportedName}`).sort()) !== JSON.stringify(expectedActions)) {
    throw new Error("Fixture must contain only its five inert actions; refusing to test an Auth-backed build");
  }
}
