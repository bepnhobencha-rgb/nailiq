/**
 * Classifies OpenAI Realtime `error` events so the voice modal can decide which
 * to surface and which to swallow. Extracted as a pure function so the
 * "don't show a red error for a harmless cancel" rule is unit-testable without a
 * live WebSocket.
 */

export type RealtimeError =
  | { code?: string; message?: string; type?: string }
  | undefined;

/**
 * True when an `error` event is the harmless "tried to cancel a response but
 * none is active" case. This happens on a barge-in race: the client sends
 * response.cancel just as the response finishes on the server, so there is
 * nothing left to cancel. It is a no-op and must NOT be shown to the user or
 * tear down the session.
 *
 * Matched defensively by both error code and message text, since the exact code
 * has varied across Realtime model versions ("Cancellation failed: no active
 * response found").
 */
export function isNoActiveResponseError(err: RealtimeError): boolean {
  if (!err) return false;
  const code = err.code ?? "";
  const msg = err.message ?? "";
  return (
    code === "response_cancel_not_active" ||
    code === "response_cancel_empty" ||
    /no active response/i.test(msg) ||
    /cancellation failed/i.test(msg)
  );
}
