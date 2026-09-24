// QA-only Node preload. Explicit local/disposable guards; no app code changes.
// Records request lifecycle, never headers, body, cookies, query or tenant slug.
/* eslint-disable @typescript-eslint/no-require-imports -- Synchronous CommonJS preload invoked by Node --require; never imported by the app. */
const http = require("node:http");
const { AsyncLocalStorage } = require("node:async_hooks");
/* eslint-enable @typescript-eslint/no-require-imports */

if (process.env.NAILIQ_DISPOSABLE_DB !== "1"
  || process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321"
  || process.env.SUPABASE_INTERNAL_URL !== "http://127.0.0.1:54321"
  || ["DISABLE_OUTBOUND_SMS", "DISABLE_OUTBOUND_EMAIL", "DISABLE_OUTBOUND_CALLS"].some(key => process.env[key] !== "1")) {
  throw new Error("Stream diagnostic requires isolated local QA with outbound disabled");
}

const storage = new AsyncLocalStorage();
const originalError = console.error;
const originalEmit = http.Server.prototype.emit;
let sequence = 0;
const message = "The destination stream closed early.";

function routeName(raw) {
  const path = String(raw || "").split("?")[0];
  if (["/register", "/register/setup", "/login", "/"].includes(path)) return path;
  if (/^\/dashboard\/[^/]+\/center\/?$/.test(path)) return "/dashboard/[salon]/center";
  if (path.startsWith("/dashboard/")) return "/dashboard/[redacted]";
  if (path.startsWith("/_next/")) return "/_next/[asset]";
  if (path.startsWith("/api/")) return "/api/[redacted]";
  return "/[other]";
}

function record(event, context, extra = {}) {
  // Skip only extra diagnostic asset records; original console.error is still
  // forwarded unchanged by its wrapper, including errors from asset requests.
  if (context?.route === "/_next/[asset]") return;
  // Diagnostic reporting must never alter request/log behavior.
  try {
    originalError.call(console, "[qa-stream] " + JSON.stringify({
      event, at: new Date().toISOString(), pid: process.pid,
      requestId: context?.id ?? null, route: context?.route ?? null,
      method: context?.method ?? null, ...extra,
    }));
  } catch { /* preserve the original request even if a diagnostic sink fails */ }
}

console.error = function (...args) {
  try {
    const error = args.find(value => value && typeof value === "object" && value.message === message);
    const matches = error || args.some(value => typeof value === "string" && value.includes(message));
    if (matches) record("stream-error", storage.getStore(), {
      digest: error && /^\d+$/.test(String(error.digest ?? "")) ? String(error.digest) : null,
    });
  } catch { /* never suppress or replace the original console.error */ }
  return originalError.apply(this, args);
};

http.Server.prototype.emit = function (event, ...args) {
  if (event !== "request") return originalEmit.call(this, event, ...args);
  const [request, response] = args;
  const remote = request.socket?.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
    return originalEmit.call(this, event, ...args);
  }
  const context = {
    id: `${process.pid}-${++sequence}`,
    route: routeName(request.url),
    method: ["GET", "POST", "HEAD", "OPTIONS"].includes(request.method) ? request.method : "OTHER",
  };
  // Socket close can originate outside request async context. Restore the
  // request context only while dispatching this response's existing events.
  const responseEmit = response.emit;
  response.emit = function (...eventArgs) {
    return storage.run(context, () => responseEmit.apply(this, eventArgs));
  };
  response.once("finish", () => record("response-finish", context, { status: response.statusCode }));
  response.once("close", () => record("response-close", context, {
    status: response.statusCode, writableFinished: response.writableFinished,
  }));
  record("request", context);
  return storage.run(context, () => originalEmit.call(this, event, ...args));
};
