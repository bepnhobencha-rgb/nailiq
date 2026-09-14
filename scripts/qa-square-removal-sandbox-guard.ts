import { createCardSandboxGuard, type CardSandboxConfig } from "./qa-square-card-sandbox-guard";

export const REMOVAL_QA_ORIGIN = "https://osdqutwunokiielbairj.supabase.co";
const SQUARE = "https://connect.squareupsandbox.com";
type Mode = "success" | "response_loss" | "db_before" | "db_after";
/** Test transport only. The existing guard owns creation and identity checks;
 * this outer boundary permits removal only of cards created during this run.
 * Its QA REST transport is independent of the legacy guard's local database. */
export function createRemovalSandboxGuard(config: CardSandboxConfig, nativeFetch: typeof fetch) {
  const create = createCardSandboxGuard(config, nativeFetch);
  const cards = new Set<string>();
  const disabled = new Set<string>();
  let armed = false;
  let mode: Mode = "success";
  let lost = false;
  let dbLost = false;
  let reads = 0;
  let writes = 0;
  let deniedWrites = 0;
  const stop = (code: string): never => { throw new Error(code); };
  return {
    async preflight() { armed = false; await create.preflight(); armed = true; },
    setMode(value: Mode) { mode = value; lost = false; dbLost = false; },
    counts: () => ({ ...create.counts(), removalReads: reads, disableCalls: writes, deniedDuplicateDisables: deniedWrites, responseLost: lost, databaseResponseLost: dbLost }),
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      const u = new URL(req.url);
      if (!armed) stop("sandbox_preflight_required");
      if (u.username || u.password) stop("sandbox_network_boundary_denied");
      if (u.origin === REMOVAL_QA_ORIGIN && u.pathname.startsWith("/rest/v1/")) {
        if (u.pathname.endsWith("/rpc/complete_booking_card_management_operation") && req.method === "POST" && !dbLost && (mode === "db_before" || mode === "db_after")) {
          dbLost = true;
          if (mode === "db_after") await nativeFetch(req, { redirect: "error" });
          throw new Error("qa_database_response_loss");
        }
        return nativeFetch(req, { redirect: "error" });
      }
      if (u.origin !== SQUARE) stop("sandbox_network_boundary_denied");
      const match = u.pathname.match(/^\/v2\/cards\/([^/]+)(\/disable)?$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (!cards.has(id) || u.search || req.headers.get("Authorization") !== `Bearer ${config.square.accessToken}`) stop("sandbox_card_not_owned_by_run");
        if (!match[2] && req.method === "GET") {
          if (mode === "response_loss" && lost) throw new Error("qa_fallback_read_timeout");
          reads++;
          return nativeFetch(req, { redirect: "error" });
        }
        if (match[2] && req.method === "POST") {
          const body = await req.clone().text();
          if (body && body.trim() !== "{}") stop("sandbox_disable_body_denied");
          if (disabled.has(id)) { deniedWrites++; stop("sandbox_duplicate_disable_denied"); }
          if (writes >= 4) stop("sandbox_removal_budget_exceeded");
          disabled.add(id); writes++;
          const response = await nativeFetch(req, { redirect: "error" });
          if (response.ok && mode === "response_loss" && !lost) {
            lost = true; await response.arrayBuffer(); throw new Error("qa_disable_response_loss");
          }
          return response;
        }
        stop("sandbox_removal_method_denied");
      }
      const sent = u.pathname === "/v2/cards" && req.method === "POST" ? await req.clone().json() : null;
      const response = await create.fetch(req);
      if (u.pathname === "/v2/cards" && req.method === "POST" && response.ok) {
        const value = await response.clone().json();
        if (typeof value?.card?.id !== "string" || value.card.customer_id !== sent.card?.customer_id || value.card.merchant_id !== config.square.merchantId || value.card.reference_id !== sent.card?.reference_id) stop("sandbox_created_card_receipt_invalid");
        cards.add(value.card.id);
      }
      return response;
    }) as typeof fetch,
  };
}
