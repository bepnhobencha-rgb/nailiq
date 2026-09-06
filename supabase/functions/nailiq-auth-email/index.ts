import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Resend } from "npm:resend@6.12.3";
import { Webhook } from "npm:standardwebhooks@1.0.0";
import {
  handleAuthEmailHook,
  type AuthEmailHookLogEvent,
} from "../_shared/authEmailHook.ts";

const FROM = "NailIQ <noreply@nailiq.ca>";
const AUTH_EMAIL_TAGS = [
  { name: "nailiq_email", value: "auth_account_security" },
  { name: "nailiq_audience", value: "security" },
] as const;

function safeLog(
  event: AuthEmailHookLogEvent,
  context?: Readonly<Record<string, string | number>>,
): void {
  const payload = context ? { event, ...context } : { event };
  if (event.endsWith("_failed") || event.endsWith("_rejected")) {
    console.error(JSON.stringify(payload));
    return;
  }
  console.info(JSON.stringify(payload));
}

Deno.serve(async (request: Request) => {
  const resendApiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  return handleAuthEmailHook(request, {
    from: FROM,
    resendConfigured: Boolean(resendApiKey),
    signingSecret: Deno.env.get("SEND_EMAIL_HOOK_SECRET"),
    supabaseUrl: Deno.env.get("SUPABASE_URL"),
    verifySignedPayload: (body, headers, secret) =>
      new Webhook(secret).verify(body, headers),
    sendEmail: async (message) => {
      if (!resendApiKey) return { error: "provider_not_configured" };
      const { idempotencyKey, ...payload } = message;
      const result = await new Resend(resendApiKey).emails.send(
        { ...payload, tags: [...AUTH_EMAIL_TAGS] },
        { idempotencyKey },
      );
      return { id: result.data?.id, error: result.error };
    },
    log: safeLog,
  });
});
