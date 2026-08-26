#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

const url = (
  process.env.SUPABASE_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  ""
).replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const exactLocalOrigin = "http://127.0.0.1:54321";

if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !url || !serviceKey) {
  throw new Error(
    "NAILIQ_DISPOSABLE_DB=1 plus a local Supabase URL and service-role key are required",
  );
}

const target = new URL(url);
if (
  target.origin !== exactLocalOrigin ||
  target.pathname !== "/" ||
  target.username !== "" ||
  target.password !== "" ||
  target.search !== "" ||
  target.hash !== ""
) {
  throw new Error(`refusing non-exact local Supabase target ${target.origin}`);
}

const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const prefix = "public-edge:mqa-0148-request-batch-concurrency:";
const maxInFlight = 20;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestBuckets(identity, { limit, reverse = false } = {}) {
  const buckets = [
    {
      p_key: `${prefix}minute:${digest(`${identity}:minute`)}`,
      p_limit: limit,
      p_window_seconds: 60,
    },
    {
      p_key: `${prefix}hour:${digest(`${identity}:hour`)}`,
      p_limit: limit,
      p_window_seconds: 3_600,
    },
  ];
  return reverse ? buckets.reverse() : buckets;
}

async function cleanup() {
  const { error } = await db
    .from("rate_limits")
    .delete()
    .like("bucket", `${prefix}%`);
  if (error) throw new Error(`request-batch cleanup failed: ${error.message}`);
}

async function countRows() {
  const { count, error } = await db
    .from("rate_limits")
    .select("*", { count: "exact", head: true })
    .like("bucket", `${prefix}%`);
  if (error) throw new Error(`request-batch row count failed: ${error.message}`);
  return count ?? 0;
}

async function readRows() {
  const { data, error } = await db
    .from("rate_limits")
    .select("bucket,count")
    .like("bucket", `${prefix}%`)
    .order("bucket")
    .limit(1_000);
  if (error) throw new Error(`request-batch row read failed: ${error.message}`);
  return data ?? [];
}

async function rpc(pRequests) {
  const response = await fetch(
    `${url}/rest/v1/rpc/rate_limit_hit_request_batch`,
    {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_requests: pRequests }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`request-batch RPC HTTP ${response.status}`);
  }
  const result = await response.json();
  if (
    !Array.isArray(result) ||
    result.length !== pRequests.length ||
    !result.every((allowed) => typeof allowed === "boolean")
  ) {
    throw new Error("request-batch RPC returned an invalid positional result");
  }
  return result;
}

async function runRpcCalls(callFactories, concurrency = maxInFlight) {
  assert.ok(concurrency >= 1 && concurrency <= 20);
  const values = [];
  for (let offset = 0; offset < callFactories.length; offset += concurrency) {
    const settled = await Promise.allSettled(
      callFactories.slice(offset, offset + concurrency).map((call) => call()),
    );
    const failures = settled.filter((result) => result.status === "rejected");
    assert.equal(
      failures.length,
      0,
      JSON.stringify(
        failures.slice(0, 5).map((result) =>
          result.status === "rejected" ? String(result.reason) : "",
        ),
      ),
    );
    for (const result of settled) {
      assert.equal(result.status, "fulfilled");
      values.push(result.value);
    }
  }
  return values;
}

async function runDisjointBatches() {
  const physicalBatches = 12;
  const requestsPerBatch = 16;
  const prewarm = [];

  for (let batch = 0; batch < physicalBatches; batch += 1) {
    for (let position = 0; position < requestsPerBatch; position += 2) {
      prewarm.push(
        requestBuckets(`disjoint-${batch}-${position}`, {
          limit: 1,
          reverse: (batch + position) % 2 === 1,
        }),
      );
    }
  }

  for (let offset = 0; offset < prewarm.length; offset += 32) {
    const slice = prewarm.slice(offset, offset + 32);
    assert.deepEqual(await rpc(slice), Array(slice.length).fill(true));
  }

  const expected = Array.from(
    { length: requestsPerBatch },
    (_, position) => position % 2 === 1,
  );
  const started = performance.now();
  const results = await runRpcCalls(
    Array.from({ length: physicalBatches }, (_, batch) => async () =>
      rpc(
        Array.from({ length: requestsPerBatch }, (_, position) =>
          requestBuckets(`disjoint-${batch}-${position}`, {
            limit: 1,
            reverse: (batch + position) % 2 === 1,
          }),
        ),
      ),
    ),
  );

  for (const result of results) assert.deepEqual(result, expected);

  const rows = await readRows();
  assert.equal(rows.length, physicalBatches * requestsPerBatch * 2);
  assert.equal(rows.filter((row) => row.count === 2).length, rows.length / 2);
  assert.equal(rows.filter((row) => row.count === 1).length, rows.length / 2);
  assert.equal(
    rows.every((row) =>
      /^public-edge:mqa-0148-request-batch-concurrency:(minute|hour):[0-9a-f]{64}:[0-9]+$/.test(
        row.bucket,
      ),
    ),
    true,
  );

  return {
    rpcCalls: physicalBatches,
    logicalRequests: physicalBatches * requestsPerBatch,
    maxInFlight: Math.min(maxInFlight, physicalBatches),
    positionalPattern: expected,
    rows: rows.length,
    countOneRows: rows.filter((row) => row.count === 1).length,
    countTwoRows: rows.filter((row) => row.count === 2).length,
    elapsedMs: Math.round(performance.now() - started),
  };
}

async function runOverlappingBatches() {
  const physicalBatches = 20;
  const requestsPerBatch = 16;
  const limit = 10;
  const started = performance.now();
  const results = await runRpcCalls(
    Array.from({ length: physicalBatches }, (_, batch) => async () => {
      const positions = Array.from(
        { length: requestsPerBatch },
        (_, position) => position,
      );
      if (batch % 2 === 1) positions.reverse();
      return rpc(
        positions.map((position) =>
          requestBuckets(`overlap-${position}`, {
            limit,
            reverse: batch % 2 === 1,
          }),
        ),
      );
    }),
  );

  assert.equal(results.length, physicalBatches);
  assert.equal(
    results.every(
      (result) => result.every((allowed) => allowed === result[0]),
    ),
    true,
  );
  const allowedBatches = results.filter((result) => result[0] === true).length;
  const limitedBatches = results.filter((result) => result[0] === false).length;
  assert.equal(allowedBatches, limit);
  assert.equal(limitedBatches, physicalBatches - limit);

  const rows = await readRows();
  assert.equal(rows.length, requestsPerBatch * 2);
  assert.equal(rows.every((row) => row.count === physicalBatches), true);

  return {
    rpcCalls: physicalBatches,
    logicalRequestResults: physicalBatches * requestsPerBatch,
    maxInFlight,
    reversedOuterAndBucketOrderCalls: physicalBatches / 2,
    allowedBatches,
    limitedBatches,
    rows: rows.length,
    finalCounts: [...new Set(rows.map((row) => row.count))],
    elapsedMs: Math.round(performance.now() - started),
  };
}

try {
  await cleanup();
  assert.equal(await countRows(), 0);

  const disjoint = await runDisjointBatches();
  await cleanup();
  assert.equal(await countRows(), 0);

  const overlappingReversedOrder = await runOverlappingBatches();
  await cleanup();
  assert.equal(await countRows(), 0);

  process.stdout.write(
    `${JSON.stringify({
      result: "PASS",
      rpc: "rate_limit_hit_request_batch",
      target: exactLocalOrigin,
      disjoint,
      overlappingReversedOrder,
      cleanupRows: 0,
    })}\n`,
  );
} finally {
  await cleanup();
  assert.equal(await countRows(), 0);
}
