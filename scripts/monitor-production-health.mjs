#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function assertAllowedTarget(baseUrl, allowProductionReadOnly = false) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("monitor_target_requires_https");
  }
  if ((url.hostname === "nailiq.ca" || url.hostname === "www.nailiq.ca") && !allowProductionReadOnly) {
    throw new Error("production_read_only_confirmation_required");
  }
  return url.origin;
}

function validateProbe(path, body) {
  if (!isObject(body)) throw new Error(`${path}:invalid_json_shape`);

  if (path === "/api/version") {
    if (typeof body.id !== "string" || body.id.length < 7) {
      throw new Error(`${path}:invalid_deployment_identity`);
    }
    return body.id;
  }

  if (!validTimestamp(body.timestamp)) throw new Error(`${path}:invalid_timestamp`);
  if (typeof body.version !== "string" || body.version.length < 7) {
    throw new Error(`${path}:invalid_deployment_identity`);
  }

  if (path === "/api/health") {
    if (body.status !== "ok") throw new Error(`${path}:not_healthy`);
    return body.version;
  }

  if (body.status !== "ready") throw new Error(`${path}:not_ready`);
  if (!isObject(body.checks)) throw new Error(`${path}:missing_checks`);
  if (body.checks.database_schema?.status !== "ok") {
    throw new Error(`${path}:database_schema_not_ready`);
  }
  if (body.checks.cron_authorization?.status !== "ok") {
    throw new Error(`${path}:cron_authorization_not_ready`);
  }
  return body.version;
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "NailIQ-Production-Monitor/1.0" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("invalid_content_type");
  }
  return response.json();
}

async function probeWithRetry({ fetchImpl, url, path, attempts, timeoutMs }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const body = await fetchJson(fetchImpl, `${url}${path}`, timeoutMs);
      const identity = validateProbe(path, body);
      return { path, attempt, latency_ms: Date.now() - startedAt, identity };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${path}:${lastError instanceof Error ? lastError.message : "unknown_failure"}`);
}

export async function runProductionMonitor({
  baseUrl,
  allowProductionReadOnly = false,
  attempts = DEFAULT_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  simulateFailure = false,
}) {
  const origin = assertAllowedTarget(baseUrl, allowProductionReadOnly);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error("invalid_attempt_count");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    throw new Error("invalid_timeout_ms");
  }
  if (simulateFailure) throw new Error("simulated_monitor_failure");

  const paths = ["/api/version", "/api/health", "/api/ready"];
  const probes = [];
  for (const path of paths) {
    probes.push(await probeWithRetry({ fetchImpl, url: origin, path, attempts, timeoutMs }));
  }

  const identities = new Set(probes.map((probe) => probe.identity));
  if (identities.size !== 1) throw new Error("deployment_identity_mismatch");

  return {
    ok: true,
    checked_at: new Date().toISOString(),
    target_origin: origin,
    deployment_identity: probes[0].identity,
    probes,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--") && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      values.set(arg, argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--")) {
      values.set(arg, true);
    }
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.get("--base-url");
  if (typeof baseUrl !== "string") throw new Error("base_url_required");
  const result = await runProductionMonitor({
    baseUrl,
    allowProductionReadOnly: args.get("--allow-production-read-only") === true,
    simulateFailure: args.get("--simulate-failure") === true,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
