import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "@playwright/test";

export const localAuthHttpsOrigin = "https://localhost:3443";

/**
 * Exercise production Secure session cookies in WebKit without weakening them.
 * Only local test traffic is proxied; keys are ephemeral and never artifacts.
 * The mail link's verify request also travels through TLS, then follows the
 * real GoTrue -> application callback -> dashboard redirects with real cookies.
 */
export const test = base.extend<object, { localAuthHttps: void }>({
  localAuthHttps: [
    async ({}, runTest) => {
      const auth = new URL(
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid",
      );
      const app = new URL(
        process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
      );
      for (const url of [auth, app]) {
        if (
          !["localhost", "127.0.0.1"].includes(url.hostname) ||
          url.protocol !== "http:"
        ) {
          throw new Error(
            "HTTPS callback fixture only accepts local HTTP upstreams",
          );
        }
      }
      const directory = await mkdtemp(join(tmpdir(), "nailiq-auth-https-"));
      let server: https.Server | undefined;
      try {
        const key = join(directory, "key.pem");
        const cert = join(directory, "cert.pem");
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            key,
            "-out",
            cert,
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
          ],
          { stdio: "ignore" },
        );
        server = https.createServer(
          { key: await readFile(key), cert: await readFile(cert) },
          (incoming, outgoing) => {
            const requested = new URL(
              incoming.url ?? "/",
              localAuthHttpsOrigin,
            );
            const isVerification = requested.pathname === "/__qa_auth_verify";
            if (isVerification && incoming.method !== "GET") {
              outgoing.writeHead(405).end();
              return;
            }
            const target = new URL(
              isVerification ? "/auth/v1/verify" : requested.pathname,
              isVerification ? auth : app,
            );
            target.search = requested.search;
            const headers = {
              ...incoming.headers,
              host: isVerification
                ? auth.host
                : new URL(localAuthHttpsOrigin).host,
              "x-forwarded-proto": "https",
              "x-forwarded-host": new URL(localAuthHttpsOrigin).host,
            };
            const upstream = http.request(
              target,
              { method: incoming.method, headers },
              (response) => {
                const responseHeaders = { ...response.headers };
                if (responseHeaders.location) {
                  const destination = new URL(responseHeaders.location, target);
                  if (
                    destination.hostname === "localhost" ||
                    destination.hostname === "127.0.0.1"
                  ) {
                    responseHeaders.location =
                      localAuthHttpsOrigin +
                      destination.pathname +
                      destination.search +
                      destination.hash;
                  }
                }
                outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
                response.pipe(outgoing);
              },
            );
            upstream.on("error", () => {
              outgoing.writeHead(502).end("Local upstream unavailable");
            });
            incoming.pipe(upstream);
          },
        );
        await new Promise<void>((resolve, reject) => {
          server!.once("error", reject);
          server!.listen(3443, "localhost", resolve);
        });
        await runTest();
      } finally {
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve())),
          );
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker", auto: true },
  ],
});
