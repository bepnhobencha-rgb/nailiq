/**
 * Unit tests for isNoActiveResponseError — decides which Realtime `error` events
 * the voice modal swallows (harmless cancel races) vs. surfaces (real errors).
 *
 * Regression guard for: "Cancellation failed: no active response found" must be
 * treated as a no-op, while genuine errors (rate limit, connection, etc.) must
 * still be shown.
 *
 * Run: npx tsx src/components/booking/__tests__/voiceErrorClassify.test.ts
 */
import { isNoActiveResponseError } from "../voiceErrorClassify";

let pass = 0,
  fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}`);
    console.error(e);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── Harmless cancel races → swallow (return true) ───────────────────
test("matches the observed message verbatim", () => {
  assert(
    isNoActiveResponseError({ message: "Cancellation failed: no active response found" }),
    "the exact observed error must be swallowed",
  );
});
test("matches by 'no active response' message fragment (any casing)", () => {
  assert(isNoActiveResponseError({ message: "Error: No Active Response" }), "case-insensitive match");
});
test("matches known cancel error codes", () => {
  assert(isNoActiveResponseError({ code: "response_cancel_not_active" }), "code not_active");
  assert(isNoActiveResponseError({ code: "response_cancel_empty" }), "code empty");
});

// ── Real errors → keep visible (return false) ───────────────────────
test("does NOT swallow rate-limit errors", () => {
  assert(!isNoActiveResponseError({ type: "rate_limit_error", code: "rate_limit_exceeded" }), "rate limit stays visible");
});
test("does NOT swallow the response.create race (handled elsewhere)", () => {
  assert(!isNoActiveResponseError({ code: "conversation_already_has_active_response" }), "not this predicate's job");
});
test("does NOT swallow a generic server error", () => {
  assert(!isNoActiveResponseError({ code: "server_error", message: "internal failure" }), "real error stays visible");
});
test("does NOT swallow undefined / empty", () => {
  assert(!isNoActiveResponseError(undefined), "undefined is not a cancel race");
  assert(!isNoActiveResponseError({}), "empty object is not a cancel race");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
