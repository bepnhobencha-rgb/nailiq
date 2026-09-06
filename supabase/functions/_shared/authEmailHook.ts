export const AUTH_EMAIL_ACTIONS = [
  "invite",
  "signup",
  "recovery",
  "magiclink",
  "email_change",
  "reauthentication",
] as const;

export type AuthEmailAction = (typeof AUTH_EMAIL_ACTIONS)[number];

type HookUser = {
  email?: unknown;
  new_email?: unknown;
};

type HookEmailData = {
  token?: unknown;
  token_hash?: unknown;
  token_new?: unknown;
  token_hash_new?: unknown;
  redirect_to?: unknown;
  site_url?: unknown;
  email_action_type?: unknown;
};

type AuthEmailHookPayload = {
  user?: HookUser;
  email_data?: HookEmailData;
};

export type AuthEmailMessage = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

export type AuthEmailHookLogEvent =
  | "auth_email_hook_config_missing"
  | "auth_email_hook_payload_rejected"
  | "auth_email_hook_signature_rejected"
  | "auth_email_hook_delivery_failed"
  | "auth_email_hook_completed";

export type AuthEmailHookDependencies = {
  from: string;
  resendConfigured: boolean;
  signingSecret: string | undefined;
  supabaseUrl: string | undefined;
  verifySignedPayload: (
    body: string,
    headers: Record<string, string>,
    secret: string,
  ) => unknown;
  sendEmail: (
    message: AuthEmailMessage,
  ) => Promise<{ id?: string | null; error?: unknown }>;
  log: (
    event: AuthEmailHookLogEvent,
    context?: Readonly<Record<string, string | number>>,
  ) => void;
};

const MAX_HOOK_BODY_BYTES = 64 * 1024;

const SUBJECTS: Record<AuthEmailAction, string> = {
  invite: "You are invited to NailIQ",
  signup: "Confirm your NailIQ email",
  recovery: "Reset your NailIQ password",
  magiclink: "Your NailIQ sign-in link",
  email_change: "Confirm your new NailIQ email",
  reauthentication: "Your NailIQ verification code",
};

const HEADINGS: Record<AuthEmailAction, string> = {
  invite: "Accept your NailIQ invitation",
  signup: "Confirm your email",
  recovery: "Reset your password",
  magiclink: "Sign in to NailIQ",
  email_change: "Confirm your new email",
  reauthentication: "Verify it is you",
};

function hookError(status: number, code: string): Response {
  return Response.json(
    { error: { http_code: status, message: code } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

function hookSuccess(): Response {
  return Response.json(
    {},
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function emailValue(value: unknown): string {
  const email = stringValue(value).toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) && email.length <= 254 ? email : "";
}

function actionValue(value: unknown): AuthEmailAction | null {
  const action = stringValue(value);
  return AUTH_EMAIL_ACTIONS.includes(action as AuthEmailAction)
    ? (action as AuthEmailAction)
    : null;
}

export function normalizeAuthEmailHookSecret(value: string | undefined): string {
  return stringValue(value).replace(/^v1,/, "").replace(/^whsec_/, "");
}

function safeSupabaseOrigin(value: string | undefined): string | null {
  try {
    const parsed = new URL(stringValue(value));
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== "/" && parsed.pathname !== "") ||
      parsed.search ||
      parsed.hash ||
      !parsed.hostname.endsWith(".supabase.co")
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return replacements[character] ?? character;
  });
}

function verifyUrl(input: {
  action: AuthEmailAction;
  redirectTo: string;
  supabaseOrigin: string;
  tokenHash: string;
}): string {
  const url = new URL("/auth/v1/verify", input.supabaseOrigin);
  url.searchParams.set("token", input.tokenHash);
  url.searchParams.set("type", input.action);
  if (input.redirectTo) url.searchParams.set("redirect_to", input.redirectTo);
  return url.toString();
}

async function messageIdempotencyKey(input: {
  action: AuthEmailAction;
  delivery: "current" | "primary" | "new";
  tokenHash: string;
}): Promise<string> {
  const material = new TextEncoder().encode(
    `${input.action}:${input.delivery}:${input.tokenHash}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return `nailiq-auth-${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function renderMessage(input: {
  action: AuthEmailAction;
  delivery: "current" | "primary" | "new";
  from: string;
  recipient: string;
  token: string;
  tokenHash: string;
  url: string;
}): Promise<AuthEmailMessage> {
  const heading = HEADINGS[input.action];
  const safeHeading = escapeHtml(heading);
  const safeUrl = escapeHtml(input.url);
  const safeToken = escapeHtml(input.token);
  const tokenBlock = safeToken
    ? `<p style="margin:20px 0 0;color:#555;font-size:14px">Verification code / Mã xác minh: <strong style="letter-spacing:1px">${safeToken}</strong></p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f6f6f4;font-family:Arial,sans-serif;color:#171717"><div style="max-width:560px;margin:32px auto;padding:0 16px"><div style="background:#111;border-radius:14px;padding:28px"><div style="color:#d9b93e;font-size:14px;font-weight:700;letter-spacing:.08em">NAILIQ</div><h1 style="color:#fff;font-size:26px;line-height:1.25;margin:14px 0 12px">${safeHeading}</h1><p style="color:#d4d4d4;line-height:1.6;margin:0 0 22px">Use the button below to continue securely.<br>Dùng nút bên dưới để tiếp tục an toàn.</p><a href="${safeUrl}" style="display:inline-block;background:#dfbd32;color:#111;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:999px">Continue / Tiếp tục</a>${tokenBlock}<p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0">If you did not request this, you can ignore this email.<br>Nếu bạn không yêu cầu, hãy bỏ qua email này.</p></div></div></body></html>`;
  const text = [
    heading,
    "",
    "Continue securely / Tiếp tục an toàn:",
    input.url,
    input.token ? `Verification code / Mã xác minh: ${input.token}` : "",
    "",
    "If you did not request this, ignore this email.",
    "Nếu bạn không yêu cầu, hãy bỏ qua email này.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    from: input.from,
    to: [input.recipient],
    subject: SUBJECTS[input.action],
    html,
    text,
    idempotencyKey: await messageIdempotencyKey({
      action: input.action,
      delivery: input.delivery,
      tokenHash: input.tokenHash,
    }),
  };
}

async function messagesForPayload(input: {
  from: string;
  payload: AuthEmailHookPayload;
  supabaseOrigin: string;
}): Promise<{ action: AuthEmailAction; messages: AuthEmailMessage[] } | null> {
  const action = actionValue(input.payload.email_data?.email_action_type);
  const data = input.payload.email_data;
  if (!action || !data) return null;

  const redirectTo =
    stringValue(data.redirect_to) || stringValue(data.site_url);
  const email = emailValue(input.payload.user?.email);
  const newEmail = emailValue(input.payload.user?.new_email);
  const token = stringValue(data.token);
  const tokenHash = stringValue(data.token_hash);
  const tokenNew = stringValue(data.token_new);
  const tokenHashNew = stringValue(data.token_hash_new);

  if (action === "email_change") {
    if (!newEmail || !tokenHash) return null;
    const messages: AuthEmailMessage[] = [];

    if (email && token && tokenHashNew) {
      messages.push(
        await renderMessage({
          action,
          delivery: "current",
          from: input.from,
          recipient: email,
          token,
          tokenHash: tokenHashNew,
          url: verifyUrl({
            action,
            redirectTo,
            supabaseOrigin: input.supabaseOrigin,
            tokenHash: tokenHashNew,
          }),
        }),
      );
    }

    const newRecipientToken = tokenNew || token;
    if (!newRecipientToken) return null;
    messages.push(
      await renderMessage({
        action,
        delivery: "new",
        from: input.from,
        recipient: newEmail,
        token: newRecipientToken,
        tokenHash,
        url: verifyUrl({
          action,
          redirectTo,
          supabaseOrigin: input.supabaseOrigin,
          tokenHash,
        }),
      }),
    );
    return { action, messages };
  }

  if (!email || !tokenHash) return null;
  return {
    action,
    messages: [
      await renderMessage({
        action,
        delivery: "primary",
        from: input.from,
        recipient: email,
        token,
        tokenHash,
        url: verifyUrl({
          action,
          redirectTo,
          supabaseOrigin: input.supabaseOrigin,
          tokenHash,
        }),
      }),
    ],
  };
}

export async function handleAuthEmailHook(
  request: Request,
  dependencies: AuthEmailHookDependencies,
): Promise<Response> {
  if (request.method !== "POST") {
    return hookError(405, "method_not_allowed");
  }

  const signingSecret = normalizeAuthEmailHookSecret(
    dependencies.signingSecret,
  );
  const supabaseOrigin = safeSupabaseOrigin(dependencies.supabaseUrl);
  if (!dependencies.resendConfigured || !signingSecret || !supabaseOrigin) {
    dependencies.log("auth_email_hook_config_missing");
    return hookError(500, "hook_not_configured");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HOOK_BODY_BYTES) {
    dependencies.log("auth_email_hook_payload_rejected", { reason: "too_large" });
    return hookError(413, "payload_too_large");
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    dependencies.log("auth_email_hook_payload_rejected", {
      reason: "unreadable",
    });
    return hookError(400, "invalid_payload");
  }
  if (new TextEncoder().encode(body).byteLength > MAX_HOOK_BODY_BYTES) {
    dependencies.log("auth_email_hook_payload_rejected", { reason: "too_large" });
    return hookError(413, "payload_too_large");
  }

  let payload: AuthEmailHookPayload;
  try {
    const verified = dependencies.verifySignedPayload(
      body,
      Object.fromEntries(request.headers.entries()),
      signingSecret,
    );
    if (!verified || typeof verified !== "object" || Array.isArray(verified)) {
      dependencies.log("auth_email_hook_payload_rejected", {
        reason: "invalid_shape",
      });
      return hookError(400, "invalid_signed_payload");
    }
    payload = verified as AuthEmailHookPayload;
  } catch {
    dependencies.log("auth_email_hook_signature_rejected");
    return hookError(401, "invalid_webhook_signature");
  }

  const resolved = await messagesForPayload({
    from: dependencies.from,
    payload,
    supabaseOrigin,
  });
  if (!resolved) {
    dependencies.log("auth_email_hook_payload_rejected", {
      reason: "invalid_fields",
    });
    return hookError(400, "invalid_signed_payload");
  }

  for (let index = 0; index < resolved.messages.length; index += 1) {
    try {
      const result = await dependencies.sendEmail(resolved.messages[index]);
      if (result.error || !result.id) {
        dependencies.log("auth_email_hook_delivery_failed", {
          action: resolved.action,
          delivery: index + 1,
        });
        return hookError(502, "email_delivery_failed");
      }
    } catch {
      dependencies.log("auth_email_hook_delivery_failed", {
        action: resolved.action,
        delivery: index + 1,
      });
      return hookError(502, "email_delivery_failed");
    }
  }

  dependencies.log("auth_email_hook_completed", {
    action: resolved.action,
    deliveries: resolved.messages.length,
  });
  return hookSuccess();
}
