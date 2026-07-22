/**
 * Fail-closed authentication for privileged Edge Functions.
 *
 * These functions run with the service-role key, so a UUID or an `apikey`
 * header is not an authorization boundary. Internal callers must present the
 * service-role credential as a Bearer token. The comparison hashes both values
 * first so its running time does not reveal the secret length or prefix.
 */

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest[index] ^ rightDigest[index];
  }
  return difference === 0;
}

export async function isAuthorizedInternalRequest(req: Request): Promise<boolean> {
  const expected = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  if (!expected) return false;

  const authorization = req.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const presented = match?.[1]?.trim() ?? "";
  if (!presented) return false;

  return constantTimeEqual(presented, expected);
}

export async function rejectUnauthorizedInternalRequest(
  req: Request,
  headers: HeadersInit = { "content-type": "application/json" },
): Promise<Response | null> {
  if (await isAuthorizedInternalRequest(req)) return null;

  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers,
  });
}

export function outboundMessageLimit(): number {
  const configured = Number.parseInt(
    Deno.env.get("MAX_OUTBOUND_MESSAGES_PER_RUN") ?? "100",
    10,
  );
  if (!Number.isFinite(configured)) return 100;
  return Math.min(500, Math.max(1, configured));
}

export function outboundMessagingEnabled(): boolean {
  return Deno.env.get("OUTBOUND_MESSAGING_ENABLED") === "true";
}
