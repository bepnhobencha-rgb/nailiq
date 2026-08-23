"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- This preload must run through NODE_OPTIONS=--require before Next.js or Playwright imports. */

const {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  realpathSync,
  writeSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, isAbsolute, sep } = require("node:path");
const { URL } = require("node:url");

const ENABLED = process.env.MQA0126_FAKE_SQUARE_REFUND === "1";

if (ENABLED) {
  const logFile = String(
    process.env.MQA0126_FAKE_SQUARE_LOG_FILE || "",
  ).trim();
  const runNonce = String(process.env.MQA0126_RUN_NONCE || "").trim();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const disposableDb = process.env.NAILIQ_DISPOSABLE_DB === "1";
  const supabaseUrl = String(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  ).trim();
  const supabaseInternalUrl = String(
    process.env.SUPABASE_INTERNAL_URL || "",
  ).trim();
  const vercelEnvironment = String(process.env.VERCEL_ENV || "").trim();

  if (!logFile) {
    throw new Error("MQA0126 fake Square transport requires a log file");
  }
  if (!uuidRe.test(runNonce)) {
    throw new Error("MQA0126 fake Square transport requires a run nonce UUID");
  }
  if (
    !disposableDb ||
    supabaseUrl !== "http://127.0.0.1:54321" ||
    supabaseInternalUrl !== "http://127.0.0.1:54321"
  ) {
    throw new Error("MQA0126 fake Square transport requires the disposable local database");
  }
  if (vercelEnvironment === "production") {
    throw new Error("MQA0126 fake Square transport refuses Vercel production");
  }
  if (typeof globalThis.fetch !== "function") {
    throw new Error("MQA0126 fake Square transport requires global fetch");
  }

  const logParent = realpathSync.native(dirname(logFile));
  const allowedLogParents = ["/private/tmp", tmpdir()]
    .filter(
      (parent, index, candidates) =>
        existsSync(parent) && candidates.indexOf(parent) === index,
    )
    .map((parent) => realpathSync.native(parent));
  if (
    !isAbsolute(logFile) ||
    !allowedLogParents.some(
      (parent) => logParent === parent || logParent.startsWith(`${parent}${sep}`),
    )
  ) {
    throw new Error("MQA0126 fake Square log must be an absolute temporary path");
  }

  const logFd = openSync(
    logFile,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  if (!fstatSync(logFd).isFile()) {
    closeSync(logFd);
    throw new Error("MQA0126 fake Square log must be a regular file");
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  const allowedLoopbackAuthorities = new Set([
    "127.0.0.1:54321",
    "127.0.0.1:3100",
  ]);

  function audit(entry) {
    writeSync(
      logFd,
      `${JSON.stringify({ ...entry, runNonce, pid: process.pid })}\n`,
      null,
      "utf8",
    );
  }

  audit({
    kind: "transport_ready",
    appUrl: "http://127.0.0.1:3100",
    supabaseUrl,
  });

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
    throw new Error("MQA0126 fake Square transport received an invalid URL");
  }

  function requestMethod(input, init) {
    const raw = init && init.method
      ? init.method
      : input && typeof input === "object" && typeof input.method === "string"
        ? input.method
        : "GET";
    return String(raw).toUpperCase();
  }

  function requestHeaders(input, init) {
    if (init && init.headers) return new Headers(init.headers);
    if (input && typeof input === "object" && input.headers) {
      return new Headers(input.headers);
    }
    return new Headers();
  }

  globalThis.fetch = async function mqa0126FakeSquareFetch(input, init) {
    const url = new URL(requestUrl(input));
    const method = requestMethod(input, init);

    if (
      url.origin === "https://connect.squareupsandbox.com" &&
      url.pathname === "/v2/refunds"
    ) {
      if (method !== "POST") {
        throw new Error("MQA0126 fake Square refund requires POST");
      }
      const headers = requestHeaders(input, init);
      if (headers.get("authorization") !== "Bearer fake-local-mqa0126-token") {
        throw new Error("MQA0126 fake Square refund received unexpected authorization");
      }
      if (headers.get("square-version") !== "2024-12-18") {
        throw new Error("MQA0126 fake Square refund received unexpected API version");
      }
      if (headers.get("content-type") !== "application/json") {
        throw new Error("MQA0126 fake Square refund requires JSON content type");
      }
      if (url.search || url.hash || url.username || url.password) {
        throw new Error("MQA0126 fake Square refund received a non-canonical URL");
      }
      if (!init || typeof init.body !== "string") {
        throw new Error("MQA0126 fake Square refund requires a JSON body");
      }

      const body = JSON.parse(init.body);
      const idempotencyKey = String(body.idempotency_key || "");
      const paymentId = String(body.payment_id || "");
      const reason = String(body.reason || "");
      const amountCents = body.amount_money && body.amount_money.amount;
      const currency = body.amount_money && body.amount_money.currency;
      const keyMatch = /^nq:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
        idempotencyKey,
      );

      if (
        !keyMatch ||
        !/^fake-local-payment-[0-9a-f-]{36}$/i.test(paymentId) ||
        !Number.isSafeInteger(amountCents) ||
        ![2_000, 3_000].includes(amountCents) ||
        currency !== "CAD" ||
        reason !== "Booking cancelled — deposit refund"
      ) {
        throw new Error("MQA0126 fake Square refund received invalid material");
      }

      const refundId = `fake_local_refund_${keyMatch[1].replaceAll("-", "")}`;
      audit({
        kind: "square_refund",
        method,
        path: url.pathname,
        paymentId,
        amountCents,
        currency,
        idempotencyKey,
        refundId,
      });

      return new Response(
        JSON.stringify({
          refund: {
            id: refundId,
            status: "COMPLETED",
            payment_id: paymentId,
            amount_money: { amount: amountCents, currency },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (!allowedLoopbackAuthorities.has(url.host)) {
      audit({
        kind: "blocked_external",
        method,
        origin: url.origin,
        path: url.pathname,
      });
      throw new Error(
        `MQA0126 fake Square transport blocked external egress: ${url.origin}${url.pathname}`,
      );
    }

    return originalFetch(input, init);
  };
}
