/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node test for the synchronous --require preload. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
/* eslint-enable @typescript-eslint/no-require-imports */

const preload = resolve(__dirname, "stream-request-correlation.cjs");
const safeEnvironment = {
  NAILIQ_DISPOSABLE_DB: "1",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_INTERNAL_URL: "http://127.0.0.1:54321",
  DISABLE_OUTBOUND_SMS: "1", DISABLE_OUTBOUND_EMAIL: "1", DISABLE_OUTBOUND_CALLS: "1",
};

test("preload refuses an unverified environment before installing observation", () => {
  const child = spawnSync(process.execPath, ["--require", preload, "-e", ""], { env: {}, encoding: "utf8" });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /requires isolated local QA/);
});

test("asset diagnostics are omitted but original errors remain visible", () => {
  const child = spawnSync(process.execPath, ["--require", preload, "-e", `
    const http = require("node:http");
    const { EventEmitter } = require("node:events");
    const server = http.createServer((_req, res) => {
      console.error(new Error("The destination stream closed early."));
      res.emit("finish");
      res.emit("close");
    });
    const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
    server.emit("request", { method: "GET", url: "/_next/static/chunk.js?private=never-log-this", socket: { remoteAddress: "127.0.0.1" } }, response);
  `], { env: safeEnvironment, encoding: "utf8", timeout: 5_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr.includes("[qa-stream]"), false);
  assert.equal(child.stderr.includes("never-log-this"), false);
  assert.match(child.stderr, /Error: The destination stream closed early\./);
});

test("response abort and React error share request ID; original error is retained", () => {
  const child = spawnSync(process.execPath, ["--require", preload, "-e", `
    process.env.NODE_ENV = "production";
    const http = require("node:http");
    const React = require("react");
    const { renderToPipeableStream } = require("react-dom/server");
    const pending = new Promise(() => {});
    function Waiting() { throw pending; }
    const server = http.createServer((req, res) => {
      const render = renderToPipeableStream(
        React.createElement(React.Suspense, { fallback: "loading" }, React.createElement(Waiting)),
        {
          onShellReady() { render.pipe(res); res.flushHeaders(); },
          onError(error) { console.error(error); server.close(); },
        }
      );
    });
    server.listen(0, "127.0.0.1", () => {
      http.get({ host: "127.0.0.1", port: server.address().port, path: "/register?private=never-log-this" }, res => {
        res.destroy();
      }).on("error", () => {});
    });
  `], { env: safeEnvironment, cwd: resolve(__dirname, "../.."), encoding: "utf8", timeout: 5_000 });
  assert.equal(child.status, 0, child.stderr);
  const rows = child.stderr.split("\n").filter(line => line.startsWith("[qa-stream] ")).map(line => JSON.parse(line.slice(12)));
  const request = rows.find(row => row.event === "request");
  const close = rows.find(row => row.event === "response-close");
  const error = rows.find(row => row.event === "stream-error");
  assert.ok(request && close && error, child.stderr);
  assert.equal(close.writableFinished, false);
  assert.equal(close.requestId, request.requestId);
  assert.equal(error.requestId, request.requestId);
  assert.equal(error.route, "/register");
  assert.equal(child.stderr.includes("never-log-this"), false);
  assert.match(child.stderr, /Error: The destination stream closed early\./);
});
