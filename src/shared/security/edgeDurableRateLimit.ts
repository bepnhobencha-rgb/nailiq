/** Edge/Proxy-compatible durable limiter. Deliberately avoids node:crypto and
 * shared clients so Proxy can run in its restricted runtime. */

import { resolveSupabaseServerUrl } from "@/shared/lib/supabase/serverUrl";

export type EdgeRateLimitResult = "allowed" | "limited" | "unavailable";

type EdgeBucket = {
  name: string;
  limit: number;
  windowSeconds: number;
};

type PersistedBucket = {
  p_key: string;
  p_limit: number;
  p_window_seconds: number;
};

type DurableRpcTarget = {
  url: string;
  serviceKey: string;
  activeKeys: Set<string>;
  references: number;
};

type DurableRpcRequest = {
  target: DurableRpcTarget;
  persistedBuckets: PersistedBucket[];
  keys: Set<string>;
  ready: boolean;
  state: "queued" | "active" | "settled";
  resolve: (result: EdgeRateLimitResult) => void;
  queueTimeout: ReturnType<typeof setTimeout>;
};

// This scheduler is only per module/process. The database remains the global
// authority, so correctness never depends on warm-instance reuse. Six physical
// RPCs leave capacity in the local ten-connection PostgREST pool for the page's
// own server-side queries; each RPC can consume up to 32 logical requests.
const MAX_DURABLE_RPC_IN_FLIGHT = 6;
const MAX_DURABLE_RPC_QUEUE = 512;
const MAX_DURABLE_REQUESTS_PER_RPC = 32;
const DURABLE_RPC_FLUSH_MS = 2;
const DURABLE_RPC_WAIT_MS = 5_000;
const DURABLE_RPC_FETCH_MS = 5_000;

let durableRpcInFlight = 0;
let durableRpcFlushTimer: ReturnType<typeof setTimeout> | undefined;
const durableRpcQueue: DurableRpcRequest[] = [];
const durableRpcTargets: DurableRpcTarget[] = [];

function sameTarget(
  target: DurableRpcTarget,
  url: string,
  serviceKey: string,
) {
  return target.url === url && target.serviceKey === serviceKey;
}

function resolveDurableRpcTarget(url: string, serviceKey: string) {
  const existing = durableRpcTargets.find((target) =>
    sameTarget(target, url, serviceKey),
  );
  if (existing) return existing;

  const target: DurableRpcTarget = {
    url,
    serviceKey,
    activeKeys: new Set<string>(),
    references: 0,
  };
  durableRpcTargets.push(target);
  return target;
}

function releaseDurableRpcTargetIfUnused(target: DurableRpcTarget) {
  if (target.references !== 0 || target.activeKeys.size !== 0) return;
  const index = durableRpcTargets.indexOf(target);
  if (index >= 0) durableRpcTargets.splice(index, 1);
}

function settleDurableRpcRequest(
  request: DurableRpcRequest,
  result: EdgeRateLimitResult,
) {
  if (request.state === "settled") return;
  clearTimeout(request.queueTimeout);
  request.state = "settled";
  request.target.references = Math.max(0, request.target.references - 1);
  request.resolve(result);
  releaseDurableRpcTargetIfUnused(request.target);
}

function removeQueuedRequest(request: DurableRpcRequest) {
  const index = durableRpcQueue.indexOf(request);
  if (index >= 0) durableRpcQueue.splice(index, 1);
}

function keysOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  for (const key of left) {
    if (right.has(key)) return true;
  }
  return false;
}

function hasEarlierOverlappingRequest(
  index: number,
  request: DurableRpcRequest,
) {
  for (let earlierIndex = 0; earlierIndex < index; earlierIndex += 1) {
    const earlier = durableRpcQueue[earlierIndex];
    if (
      earlier.state === "queued" &&
      earlier.target === request.target &&
      keysOverlap(earlier.keys, request.keys)
    ) {
      return true;
    }
  }
  return false;
}

function selectDurableRpcBatch() {
  let target: DurableRpcTarget | undefined;
  const batch: DurableRpcRequest[] = [];
  const batchKeys = new Set<string>();

  for (let index = 0; index < durableRpcQueue.length; index += 1) {
    const request = durableRpcQueue[index];

    // Preparation is normally shorter than the coalescing delay. Stopping at
    // an earlier placeholder makes invocation order deterministic even if two
    // WebCrypto promises settle out of order.
    if (!request.ready) break;
    if (request.state !== "queued") continue;
    if (target && request.target !== target) continue;
    if (keysOverlap(request.keys, request.target.activeKeys)) continue;
    if (keysOverlap(request.keys, batchKeys)) continue;
    if (hasEarlierOverlappingRequest(index, request)) continue;

    target ??= request.target;
    batch.push(request);
    for (const key of request.keys) batchKeys.add(key);
    if (batch.length >= MAX_DURABLE_REQUESTS_PER_RPC) break;
  }

  return batch;
}

function scheduleDurableRpcDrain(delayMs = DURABLE_RPC_FLUSH_MS) {
  if (durableRpcFlushTimer !== undefined) return;
  durableRpcFlushTimer = setTimeout(() => {
    durableRpcFlushTimer = undefined;
    drainDurableRpcQueue();
  }, delayMs);
}

function failBatch(
  batch: readonly DurableRpcRequest[],
  result: EdgeRateLimitResult = "unavailable",
) {
  for (const request of batch) settleDurableRpcRequest(request, result);
}

async function executeDurableRpcBatch(batch: readonly DurableRpcRequest[]) {
  const target = batch[0]?.target;
  if (!target) return;

  const controller = new AbortController();
  let fetchTimeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    fetchTimeout = setTimeout(() => {
      controller.abort();
      reject(new Error("durable rate-limit RPC timed out"));
    }, DURABLE_RPC_FETCH_MS);
  });

  try {
    const allowed: unknown = await Promise.race([
      (async () => {
        const response = await fetch(
          `${target.url}/rest/v1/rpc/rate_limit_hit_request_batch`,
          {
            method: "POST",
            headers: {
              apikey: target.serviceKey,
              Authorization: `Bearer ${target.serviceKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              p_requests: batch.map((request) => request.persistedBuckets),
            }),
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw new Error("durable rate-limit RPC failed");
        }
        return response.json() as Promise<unknown>;
      })(),
      timeoutPromise,
    ]);

    if (
      !Array.isArray(allowed) ||
      allowed.length !== batch.length ||
      allowed.some((value) => typeof value !== "boolean")
    ) {
      failBatch(batch);
      return;
    }

    batch.forEach((request, index) => {
      settleDurableRpcRequest(
        request,
        allowed[index] ? "allowed" : "limited",
      );
    });
  } catch {
    failBatch(batch);
  } finally {
    if (fetchTimeout !== undefined) clearTimeout(fetchTimeout);
    for (const request of batch) {
      for (const key of request.keys) target.activeKeys.delete(key);
    }
    durableRpcInFlight = Math.max(0, durableRpcInFlight - 1);
    releaseDurableRpcTargetIfUnused(target);
    if (durableRpcQueue.length > 0) scheduleDurableRpcDrain(0);
  }
}

function drainDurableRpcQueue() {
  while (durableRpcInFlight < MAX_DURABLE_RPC_IN_FLIGHT) {
    const batch = selectDurableRpcBatch();
    if (batch.length === 0) return;

    const selected = new Set(batch);
    for (let index = durableRpcQueue.length - 1; index >= 0; index -= 1) {
      if (selected.has(durableRpcQueue[index])) {
        durableRpcQueue.splice(index, 1);
      }
    }

    for (const request of batch) {
      clearTimeout(request.queueTimeout);
      request.state = "active";
      for (const key of request.keys) request.target.activeKeys.add(key);
    }
    durableRpcInFlight += 1;
    void executeDurableRpcBatch(batch);
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function preparePersistedBuckets(input: {
  scope: string;
  material: string[];
  buckets: readonly EdgeBucket[];
}) {
  const persistedBuckets: PersistedBucket[] = [];
  for (const bucket of input.buckets) {
    const digest = await sha256(
      JSON.stringify([input.scope, bucket.name, ...input.material]),
    );
    const key = `public-edge:${input.scope}:${bucket.name}:${digest}`;
    if (key.length > 300) {
      throw new Error("durable rate-limit key is too long");
    }
    persistedBuckets.push({
      p_key: key,
      p_limit: bucket.limit,
      p_window_seconds: bucket.windowSeconds,
    });
  }
  return persistedBuckets;
}

export async function consumeEdgeDurableRateLimits(input: {
  scope: string;
  material: string[];
  buckets: readonly EdgeBucket[];
}): Promise<EdgeRateLimitResult> {
  const url = resolveSupabaseServerUrl()?.replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (
    !url ||
    !serviceKey ||
    typeof input.scope !== "string" ||
    !input.scope ||
    !Array.isArray(input.material) ||
    input.material.length === 0 ||
    input.material.some((value) => typeof value !== "string" || !value) ||
    !Array.isArray(input.buckets) ||
    input.buckets.length < 1 ||
    input.buckets.length > 4 ||
    input.buckets.some(
      (bucket) =>
        typeof bucket?.name !== "string" ||
        !bucket.name ||
        !Number.isSafeInteger(bucket.limit) ||
        bucket.limit < 1 ||
        bucket.limit > 2_147_483_647 ||
        !Number.isSafeInteger(bucket.windowSeconds) ||
        bucket.windowSeconds < 1 ||
        bucket.windowSeconds > 2_147_483_647,
    )
  ) {
    return "unavailable";
  }
  if (durableRpcQueue.length >= MAX_DURABLE_RPC_QUEUE) return "unavailable";

  const target = resolveDurableRpcTarget(url, serviceKey);
  return new Promise<EdgeRateLimitResult>((resolve) => {
    const request = {
      target,
      persistedBuckets: [],
      keys: new Set<string>(),
      ready: false,
      state: "queued",
      resolve,
    } as Omit<DurableRpcRequest, "queueTimeout"> & {
      queueTimeout?: ReturnType<typeof setTimeout>;
    };

    target.references += 1;
    durableRpcQueue.push(request as DurableRpcRequest);
    request.queueTimeout = setTimeout(() => {
      if (request.state !== "queued") return;
      removeQueuedRequest(request as DurableRpcRequest);
      settleDurableRpcRequest(request as DurableRpcRequest, "unavailable");
      if (durableRpcQueue.length > 0) scheduleDurableRpcDrain(0);
    }, DURABLE_RPC_WAIT_MS);

    void preparePersistedBuckets(input)
      .then((persistedBuckets) => {
        if (request.state !== "queued") return;
        const keys = new Set(persistedBuckets.map((bucket) => bucket.p_key));
        if (keys.size !== persistedBuckets.length) {
          removeQueuedRequest(request as DurableRpcRequest);
          settleDurableRpcRequest(request as DurableRpcRequest, "unavailable");
          if (durableRpcQueue.length > 0) scheduleDurableRpcDrain(0);
          return;
        }
        request.persistedBuckets = persistedBuckets;
        request.keys = keys;
        request.ready = true;
        scheduleDurableRpcDrain();
      })
      .catch(() => {
        if (request.state !== "queued") return;
        removeQueuedRequest(request as DurableRpcRequest);
        settleDurableRpcRequest(request as DurableRpcRequest, "unavailable");
        if (durableRpcQueue.length > 0) scheduleDurableRpcDrain(0);
      });
  });
}
