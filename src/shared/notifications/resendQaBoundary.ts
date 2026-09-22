import type { WebhookEventPayload } from "resend";
import { resolveSupabaseServerUrl } from "@/shared/lib/supabase/serverUrl";

const PRODUCTION_SUPABASE_REF = "fshmobzyjhmtvndobwsy";
const HOSTED_SUPABASE_URL = /^https:\/\/([a-z0-9]{20})\.supabase\.(?:co|in)\/?$/i;

type Environment = Record<string, string | undefined>;

export type ResendQaBoundary =
  | { mode: "normal" }
  | { mode: "invalid" }
  | { mode: "qa"; projectRef: string; recipient: string };

/** A QA endpoint is allowed to write only to its explicitly pinned disposable project. */
export function resolveResendQaBoundary(env: Environment = process.env): ResendQaBoundary {
  const mode = env.NAILIQ_RESEND_QA_WEBHOOK_ONLY?.trim().toLowerCase() ?? "";
  if (mode === "" || mode === "0" || mode === "false") {
    return ["1", "true"].includes(env.NAILIQ_DISPOSABLE_DB?.trim().toLowerCase() ?? "")
      ? { mode: "invalid" }
      : { mode: "normal" };
  }
  if (mode !== "1") return { mode: "invalid" };

  const projectRef = env.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF?.trim().toLowerCase() ?? "";
  const publicUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const internalUrl = resolveSupabaseServerUrl(env)?.trim() ?? "";
  const recipient = env.NAILIQ_QA_RESEND_EMAIL_RECIPIENT?.trim().toLowerCase() ?? "";
  const publicRef = HOSTED_SUPABASE_URL.exec(publicUrl)?.[1]?.toLowerCase();
  if (
    env.VERCEL_ENV !== "preview" ||
    !["1", "true"].includes(env.NAILIQ_DISPOSABLE_DB?.trim().toLowerCase() ?? "") ||
    !projectRef || projectRef === PRODUCTION_SUPABASE_REF ||
    publicRef !== projectRef || internalUrl !== publicUrl ||
    !recipient || recipient.length > 320 || /[\s\u0000-\u001f\u007f]/.test(recipient) ||
    !recipient.includes("@")
  ) return { mode: "invalid" };

  return { mode: "qa", projectRef, recipient };
}

function eventTags(event: WebhookEventPayload): Record<string, unknown> | null {
  if (!("tags" in event.data)) return null;
  const tags: unknown = event.data.tags;
  return tags && typeof tags === "object" && !Array.isArray(tags)
    ? tags as Record<string, unknown>
    : null;
}

/** Called only after signature verification and before parsing or database access. */
export function classifyResendQaEvent(
  event: WebhookEventPayload,
  boundary: ResendQaBoundary,
): "process" | "ignore" | "unavailable" {
  const tags = eventTags(event);
  const qaMarked = tags?.nailiq_env === "qa" || tags?.nailiq_qa_ref !== undefined;
  if (boundary.mode === "normal") return qaMarked ? "ignore" : "process";
  if (!qaMarked || tags?.nailiq_env !== "qa") return "ignore";
  if (boundary.mode === "invalid") return "unavailable";
  if (tags?.nailiq_qa_ref !== boundary.projectRef || !("to" in event.data)) return "ignore";

  const recipients: unknown = event.data.to;
  return Array.isArray(recipients) && recipients.length === 1 &&
    typeof recipients[0] === "string" &&
    recipients[0].trim().toLowerCase() === boundary.recipient
    ? "process"
    : "ignore";
}

/** Null means a requested QA send is not pinned safely and must be suppressed. */
export function resendQaTagsForRecipient(
  recipient: string,
  boundary: ResendQaBoundary,
): Array<{ name: string; value: string }> | null {
  if (boundary.mode === "normal") return [];
  if (boundary.mode !== "qa" || recipient.trim().toLowerCase() !== boundary.recipient) return null;
  return [
    { name: "nailiq_env", value: "qa" },
    { name: "nailiq_qa_ref", value: boundary.projectRef },
  ];
}
