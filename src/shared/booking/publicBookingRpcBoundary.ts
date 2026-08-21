export const PUBLIC_BOOKING_RPC_TIMEOUT_MS = 12_000;

export type PublicBookingRpcBoundaryResult<T> =
  | { kind: "completed"; requestId: string; value: T }
  | { kind: "outcome_unknown"; requestId: string };

/**
 * Bounds the browser wait for the canonical booking RPC without pretending an
 * aborted HTTP request means PostgreSQL did not commit. The caller-owned
 * request ID is returned unchanged so the next explicit confirmation can
 * inspect/replay the same logical booking instead of minting another write.
 */
export async function runBoundedPublicBookingRpc<T>(args: {
  requestId: string;
  invoke: (requestId: string, signal: AbortSignal) => PromiseLike<T>;
  timeoutMs?: number;
}): Promise<PublicBookingRpcBoundaryResult<T>> {
  const timeoutMs = args.timeoutMs ?? PUBLIC_BOOKING_RPC_TIMEOUT_MS;
  if (!args.requestId || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("invalid_public_booking_rpc_boundary");
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const operation: Promise<PublicBookingRpcBoundaryResult<T>> = Promise.resolve()
    .then(() => args.invoke(args.requestId, controller.signal))
    .then(
      (value): PublicBookingRpcBoundaryResult<T> => ({
        kind: "completed",
        requestId: args.requestId,
        value,
      }),
      (error: unknown): PublicBookingRpcBoundaryResult<T> => {
        if (controller.signal.aborted) {
          return { kind: "outcome_unknown", requestId: args.requestId };
        }
        throw error;
      },
    );

  const timeout = new Promise<PublicBookingRpcBoundaryResult<T>>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve({ kind: "outcome_unknown", requestId: args.requestId });
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
