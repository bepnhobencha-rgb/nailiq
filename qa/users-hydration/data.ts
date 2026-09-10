import type { LoadAllUsersResult } from "@/shared/superadmin/superadminTypes";
// Inert fixture: no Auth, provider, database, or real account reads.
export async function requireSuperadminPage() {}
export async function loadAllUsers(): Promise<LoadAllUsersResult> {
  const now = Date.now();
  return { ok: true, users: [
    ["minute", now - 690_000],
    ["live", now - 870_000],
    ["today", now - 86_370_000],
    ["week", now - 604_770_000],
    ["old", Date.parse("2025-01-01T00:30:00Z")],
    ["never", null],
  ].map(([id, timestamp]) => ({
    id: String(id), email: `${id}@example.invalid`,
    lastSignInAt: typeof timestamp === "number" ? new Date(timestamp).toISOString() : null,
    createdAt: id === "never" ? null : "2025-01-01T00:30:00Z",
    memberships: [],
  })) };
}
