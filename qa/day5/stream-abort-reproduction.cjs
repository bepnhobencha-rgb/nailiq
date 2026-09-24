// Provider-free React runtime diagnostic. No app route, DB, HTTP or credentials.
// Run: node --test qa/day5/stream-abort-reproduction.cjs
// This reproduces a message, not proof of every app log's originating request.
process.env.NODE_ENV = "production";

/* eslint-disable @typescript-eslint/no-require-imports -- Load React only after setting NODE_ENV for this CommonJS production-runtime diagnostic. */
const assert = require("node:assert/strict");
const test = require("node:test");
const { PassThrough } = require("node:stream");
const React = require("react");
const { renderToPipeableStream } = require("react-dom/server");
/* eslint-enable @typescript-eslint/no-require-imports */

function renderScenario(interruptDestination) {
  return new Promise((resolve, reject) => {
    const errors = [];
    let ready = false;
    let complete;
    const pending = new Promise((done) => { complete = done; });
    function SyntheticContent() {
      if (!ready) throw pending;
      return React.createElement("p", null, "Synthetic QA ready");
    }

    const destination = new PassThrough();
    destination.resume();
    const deadline = setTimeout(() => {
      reject(new Error("Diagnostic render did not settle within two seconds"));
      stream.abort();
      destination.destroy();
    }, 2_000);
    const settle = () => {
      clearTimeout(deadline);
      resolve(errors);
    };
    destination.on("finish", () => {
      if (!interruptDestination) settle();
    });
    const stream = renderToPipeableStream(
      React.createElement(
        React.Suspense,
        { fallback: React.createElement("p", null, "Loading") },
        React.createElement(SyntheticContent),
      ),
      {
        onShellReady() {
          stream.pipe(destination);
          if (interruptDestination) {
            setImmediate(() => destination.destroy());
          } else {
            setImmediate(() => {
              ready = true;
              complete();
            });
          }
        },
        onError(error) {
          errors.push(error.message);
          if (interruptDestination) settle();
        },
      },
    );
  });
}

test("React production stream finishes normally without an error", async () => {
  assert.deepEqual(await renderScenario(false), []);
});

test("closing a destination during suspended rendering reproduces the exact warning", async () => {
  assert.deepEqual(await renderScenario(true), ["The destination stream closed early."]);
});
