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

if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !url || !serviceKey) {
  throw new Error("disposable local Supabase URL and service-role key required");
}
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  throw new Error(`non-local host ${host}`);
}

const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const prefix = "public-edge:mqa-0148-concurrency:";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function payload(identity, reverse = false, limit = 10) {
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
  if (error) throw new Error(`rate-limit cleanup failed: ${error.message}`);
}

async function countRows() {
  const { count, error } = await db
    .from("rate_limits")
    .select("*", { count: "exact", head: true })
    .like("bucket", `${prefix}%`);
  if (error) throw new Error(`rate-limit count failed: ${error.message}`);
  return count ?? 0;
}

async function rpc(pBuckets) {
  const response = await fetch(`${url}/rest/v1/rpc/rate_limit_hit_many`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_buckets: pBuckets }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`rate-limit RPC HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result !== "boolean") {
    throw new Error("rate-limit RPC returned a non-boolean result");
  }
  return result;
}

async function runRpcCalls(callFactories, maxInFlight = 20) {
  const values = [];
  for (let offset = 0; offset < callFactories.length; offset += maxInFlight) {
    const settled = await Promise.allSettled(
      callFactories.slice(offset, offset + maxInFlight).map((call) => call()),
    );
    const failures = settled.filter((result) => result.status === "rejected");
    assert.equal(
      failures.length,
      0,
      JSON.stringify(failures.slice(0, 5).map((result) =>
        result.status === "rejected" ? String(result.reason) : "")),
    );
    for (const result of settled) {
      assert.equal(result.status, "fulfilled");
      values.push(result.value);
    }
  }
  return values;
}

try {
  await cleanup();

  const disjointStarted = performance.now();
  const disjoint = await runRpcCalls(
    Array.from({ length: 350 }, (_, index) =>
      () => rpc(payload(`disjoint-${index}`, index % 2 === 1, 1)),
    ),
  );
  assert.equal(disjoint.filter(Boolean).length, 350);
  assert.equal(await countRows(), 700);
  const { data: disjointRows, error: disjointError } = await db
    .from("rate_limits")
    .select("bucket,count")
    .like("bucket", `${prefix}%`);
  if (disjointError) throw new Error(disjointError.message);
  assert.equal(disjointRows?.every((row) => row.count === 1), true);
  assert.equal(
    disjointRows?.every((row) =>
      /^public-edge:mqa-0148-concurrency:(minute|hour):[0-9a-f]{64}:[0-9]+$/.test(
        row.bucket,
      )),
    true,
  );
  const disjointElapsedMs = Math.round(performance.now() - disjointStarted);

  await cleanup();

  const sharedStarted = performance.now();
  const shared = await runRpcCalls(
    Array.from({ length: 350 }, (_, index) =>
      () => rpc(payload("shared", index % 2 === 1, 175)),
    ),
  );
  const sharedElapsedMs = Math.round(performance.now() - sharedStarted);
  assert.equal(shared.filter(Boolean).length, 175);
  assert.equal(shared.filter((allowed) => !allowed).length, 175);
  const { data: sharedRows, error: sharedError } = await db
    .from("rate_limits")
    .select("bucket,count")
    .like("bucket", `${prefix}%`);
  if (sharedError) throw new Error(sharedError.message);
  assert.equal(sharedRows?.length, 2);
  assert.equal(sharedRows?.every((row) => row.count === 350), true);

  process.stdout.write(JSON.stringify({
    result: "PASS",
    disjoint: {
      calls: 350,
      maxInFlight: 20,
      rows: 700,
      elapsedMs: disjointElapsedMs,
    },
    sharedReversedOrder: {
      calls: 350,
      maxInFlight: 20,
      allowed: 175,
      limited: 175,
      finalCounts: [350, 350],
      elapsedMs: sharedElapsedMs,
    },
  }) + "\n");
} finally {
  await cleanup();
  assert.equal(await countRows(), 0);
}
