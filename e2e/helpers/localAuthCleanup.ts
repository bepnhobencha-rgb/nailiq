import { request } from "@playwright/test";

type CleanupStep = () => Promise<unknown>;

// A finally block can replace the assertion that brought us here. Keep every
// failure, in execution order, and still attempt each independent cleanup.
export async function withLocalAuthCleanup(
  body: CleanupStep,
  ...cleanup: CleanupStep[]
) {
  const errors: unknown[] = [];
  for (const step of [body, ...cleanup]) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      errors
        .map((error, index) =>
          `${index + 1}. ${error instanceof Error ? error.message : String(error)}`,
        )
        .join("\n"),
    );
  }
}

// Cleanup must outlive the tested page/context. Its own API context also avoids
// borrowing Auth cookies and is always disposed, even when Mailpit fails.
export async function removeLocalAuthMail(
  email: string,
  mailbox = "http://127.0.0.1:54324",
) {
  const url = new URL(mailbox);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname)
  ) {
    throw new Error("Auth mail cleanup requires disposable loopback Mailpit");
  }
  const client = await request.newContext({
    baseURL: url.origin,
    maxRedirects: 0,
  });
  await withLocalAuthCleanup(async () => {
    const list = await client.get("/api/v1/messages");
    if (!list.ok()) throw new Error(`Mailpit list failed: HTTP ${list.status()}`);
    const body = (await list.json()) as {
      messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
    };
    const ids = body.messages
      .filter((message) => message.To.some((to) => to.Address === email))
      .map((message) => message.ID);
    if (!ids.length) return;
    const response = await client.delete("/api/v1/messages", {
      data: { IDs: ids },
    });
    if (!response.ok()) {
      throw new Error(`Mailpit delete failed: HTTP ${response.status()}`);
    }
  }, () => client.dispose());
}
