/**
 * Build a fetch implementation that can reach one already-validated loopback
 * origin only. Redirect following is always disabled so auth headers can never
 * escape to a hosted destination through a local 3xx response.
 */
export function createLoopbackOnlyFetch(
  allowedOrigin,
  { fetchImpl = globalThis.fetch, onAllowed } = {},
) {
  const canonicalOrigin = new URL(allowedOrigin).origin;
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");

  return async (input, init = {}) => {
    const raw = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : String(input);
    const target = new URL(raw);
    if (
      target.origin !== canonicalOrigin
      || target.username
      || target.password
    ) {
      throw new Error("Local rehearsal blocked a non-loopback request");
    }
    onAllowed?.(target);
    return fetchImpl(input, { ...init, redirect: "error" });
  };
}
