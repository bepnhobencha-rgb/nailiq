type NamedKeys = Record<string, string>;

function readNamedKey(environmentVariable: string, name: string): string | null {
  const raw = Deno.env.get(environmentVariable)?.trim();
  if (!raw) return null;

  try {
    const keys = JSON.parse(raw) as NamedKeys;
    const key = keys[name]?.trim();
    return key || null;
  } catch {
    throw new Error(`${environmentVariable} is not valid JSON`);
  }
}

export function supabaseSecretKey(name = "default"): string {
  const key = readNamedKey("SUPABASE_SECRET_KEYS", name);
  if (key) return key;

  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacy) return legacy;

  throw new Error(`Missing Supabase secret key named ${name}`);
}

export function supabasePublishableKey(name = "default"): string {
  const key = readNamedKey("SUPABASE_PUBLISHABLE_KEYS", name);
  if (key) return key;

  const legacy = Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  if (legacy) return legacy;

  throw new Error(`Missing Supabase publishable key named ${name}`);
}

/**
 * Temporary dual-key support for a zero-downtime migration.
 * Remove the legacy candidate after every caller has moved to `apikey`.
 */
export function acceptedInternalSecretKeys(): string[] {
  const keys = [supabaseSecretKey()];
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacy && !keys.includes(legacy)) keys.push(legacy);
  return keys;
}
