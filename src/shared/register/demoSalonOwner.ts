import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const DEMO_OWNER_EMAIL = "nailiq-demo-salon-owner@signup.nailiq.invalid";

async function findAuthUserIdByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<string | undefined> {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) {
      console.error("[findAuthUserIdByEmail]", error);
      return undefined;
    }
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return undefined;
}

/**
 * Shared demo-owner Auth user for `salon_members` FK — email/password only (no Phone provider).
 */
export async function getOrCreateDemoSalonOwnerUserId(): Promise<string | null> {
  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return null;
  }

  const existing = await findAuthUserIdByEmail(admin, DEMO_OWNER_EMAIL);
  if (existing) return existing;

  const password = randomBytes(32).toString("base64url");
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: DEMO_OWNER_EMAIL,
    password,
    email_confirm: true,
  });

  if (!cErr && created.user?.id) {
    return created.user.id;
  }

  const msg = (cErr?.message ?? "").toLowerCase();
  const duplicate =
    msg.includes("already") ||
    msg.includes("registered") ||
    msg.includes("exists");

  if (!duplicate) {
    console.error("[getOrCreateDemoSalonOwnerUserId] createUser", cErr);
    return null;
  }

  const found = await findAuthUserIdByEmail(admin, DEMO_OWNER_EMAIL);
  return found ?? null;
}
