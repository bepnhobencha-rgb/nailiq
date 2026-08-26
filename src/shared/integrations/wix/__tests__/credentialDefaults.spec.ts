import { describe, expect, it } from "vitest";

import { resolveWixEnabledOnCredentialSave } from "@/shared/integrations/wix/credentialDefaults";

describe("Wix credential activation boundary", () => {
  it("keeps a brand-new credential row disabled until explicit enable", () => {
    expect(resolveWixEnabledOnCredentialSave(undefined, undefined)).toBe(false);
  });

  it("preserves an existing explicit state during credential rotation", () => {
    expect(resolveWixEnabledOnCredentialSave(true, undefined)).toBe(true);
    expect(resolveWixEnabledOnCredentialSave(false, undefined)).toBe(false);
  });

  it("honors an explicit owner choice", () => {
    expect(resolveWixEnabledOnCredentialSave(false, true)).toBe(true);
    expect(resolveWixEnabledOnCredentialSave(true, false)).toBe(false);
  });
});
