/** Test-only transport for one synthetic booking and one SDK token. */
export function createSdkSaveGuard(input: {
  sourceToken: string; accessToken: string; syntheticEmail: string;
  verifyOperation: (id: string) => Promise<boolean>; nativeFetch: typeof fetch;
}) {
  if (!/^cnon:[A-Za-z0-9_-]{20,1024}$/.test(input.sourceToken)
    || !/^synthetic-[a-z0-9-]+@example\.com$/.test(input.syntheticEmail)) throw Error("sdk_fixture_invalid");
  let cards = 0; let customers = 0; let searches = 0;
  const deny = (): never => { throw Error("sdk_transport_denied"); };
  const object = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  return { counts: () => ({ cards, customers, searches }), fetch: (async (url, init) => {
    const req = new Request(url, init); const u = new URL(req.url);
    if (u.username || u.password) deny();
    if (u.origin === "https://osdqutwunokiielbairj.supabase.co" && u.pathname.startsWith("/rest/v1/")) {
      return input.nativeFetch(req, { redirect: "error" });
    }
    if (u.origin !== "https://connect.squareupsandbox.com" || u.search || req.method !== "POST"
      || req.headers.get("Authorization") !== `Bearer ${input.accessToken}`) deny();
    const b = object(await req.clone().json()); if (!b) return deny();
    if (u.pathname === "/v2/customers/search") {
      const f = object(object(b.query)?.filter); const keys = Object.keys(f ?? {});
      const exact = keys.length === 1 ? object(f?.[keys[0]])?.exact : null;
      if (!(keys[0] === "email_address" && exact === input.syntheticEmail)
        && !(keys[0] === "reference_id" && typeof exact === "string" && /^nq-customer:[0-9a-f-]{36}$/i.test(exact))) deny();
      if (++searches > 3) deny();
    } else if (u.pathname === "/v2/customers") {
      if (typeof b.given_name !== "string" || !b.given_name.startsWith("Synthetic") || b.email_address !== input.syntheticEmail
        || b.phone_number != null || !/^nq-customer:[0-9a-f-]{36}$/i.test(String(b.reference_id)) || ++customers > 1) deny();
    } else if (u.pathname === "/v2/cards") {
      const card = object(b.card); const ref = String(card?.reference_id ?? "");
      if (b.source_id !== input.sourceToken || !/^nq-card:[0-9a-f-]{36}$/i.test(ref)
        || Object.keys(b).some(k => !["source_id", "idempotency_key", "card"].includes(k))
        || Object.keys(card ?? {}).some(k => !["customer_id", "reference_id"].includes(k))
        || !await input.verifyOperation(ref.slice(8)) || ++cards > 1) deny();
    } else deny();
    // Exact SDK token and provider request body pass through unchanged.
    return input.nativeFetch(req, { redirect: "error" });
  }) as typeof fetch };
}
