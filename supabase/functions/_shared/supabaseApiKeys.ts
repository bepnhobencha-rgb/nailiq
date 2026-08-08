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

  throw new Error(`Missing Supabase secret key named ${name}`);
}

export function supabasePublishableKey(name = "default"): string {
  const key = readNamedKey("SUPABASE_PUBLISHABLE_KEYS", name);
  if (key) return key;

  throw new Error(`Missing Supabase publishable key named ${name}`);
}

export function acceptedInternalSecretKeys(): string[] {
  return [supabaseSecretKey()];
}
