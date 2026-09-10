export type SignOutResult =
  | { ok: true }
  | { ok: false; error: "server_error" };
