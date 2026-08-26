import assert from "node:assert/strict";
import test from "node:test";
import { createLoopbackOnlyFetch } from "./local-only-fetch.mjs";

test("allows the exact loopback origin and forces redirect:error", async () => {
  const calls = [];
  let allowed = 0;
  const guardedFetch = createLoopbackOnlyFetch("http://127.0.0.1:54321", {
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      return new Response("ok", { status: 200 });
    },
    onAllowed: () => { allowed += 1; },
  });

  const response = await guardedFetch("http://127.0.0.1:54321/rest/v1/example", {
    redirect: "follow",
    headers: { authorization: "Bearer fake-local-only" },
  });

  assert.equal(await response.text(), "ok");
  assert.equal(allowed, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, "error");
});

test("rejects an external origin before counting or invoking fetch", async () => {
  let calls = 0;
  let allowed = 0;
  const guardedFetch = createLoopbackOnlyFetch("http://127.0.0.1:54321", {
    fetchImpl: async () => {
      calls += 1;
      return new Response("unexpected");
    },
    onAllowed: () => { allowed += 1; },
  });

  await assert.rejects(
    guardedFetch("https://hosted.example.test/rest/v1/private"),
    /blocked a non-loopback request/u,
  );
  assert.equal(calls, 0);
  assert.equal(allowed, 0);
});

test("rejects userinfo even when URL origin otherwise matches", async () => {
  const guardedFetch = createLoopbackOnlyFetch("http://127.0.0.1:54321", {
    fetchImpl: async () => new Response("unexpected"),
  });

  await assert.rejects(
    guardedFetch("http://user:secret@127.0.0.1:54321/rest/v1/private"),
    /blocked a non-loopback request/u,
  );
});
