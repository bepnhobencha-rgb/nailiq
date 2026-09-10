// No Auth client or provider access exists in this standalone QA app.
export function createClient(): ReturnType<
  typeof import("../../src/shared/lib/supabase/client").createClient
> {
  throw new Error("QA OAuth escaped the disabled control");
}
