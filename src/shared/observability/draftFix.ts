import Anthropic from "@anthropic-ai/sdk";
import { createTextBackgroundAnthropicClient } from "@/shared/ai/anthropicProviderPolicy";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  assessErrorEvidence,
  evidenceConflictSummary,
} from "@/shared/observability/errorEvidence";

/**
 * Phase 3 — AI-drafted fix. Claude reads the actual offending file (the repo is
 * public, so no token needed to READ) and proposes a concrete fix + root cause,
 * stored on the error row. If a GitHub token is configured (contents + PRs
 * write), it also opens a DRAFT PR with the corrected file — always a draft for
 * a human to review, never auto-merged.
 */

const REPO_OWNER = "bepnhobencha-rgb";
const REPO_NAME = "nailiq";
const BASE_BRANCH = "main";
const FIX_MODEL = "claude-sonnet-4-6"; // better at code than the haiku triage model

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!anthropicClient) anthropicClient = createTextBackgroundAnthropicClient(key);
  return anthropicClient;
}

function textOf(resp: Anthropic.Message): string {
  const b = resp.content.find((x) => x.type === "text");
  return b && b.type === "text" ? b.text : "";
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s < 0 || e < 0) return null;
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}

/** Fetch a repo file's text from the public raw endpoint (no token). */
async function fetchRawFile(path: string): Promise<string | null> {
  try {
    const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BASE_BRANCH}/${path.replace(/^\/+/, "")}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const t = await r.text();
    return t.length > 60_000 ? null : t; // skip huge files (LLM can't safely rewrite)
  } catch {
    return null;
  }
}

/** All source file paths in the repo (cached). Read-only — uses the token for a
 *  higher rate limit when present, else the public unauthenticated endpoint. */
let treeCache: string[] | null = null;
async function fetchRepoTree(): Promise<string[]> {
  if (treeCache) return treeCache;
  try {
    const token = await getToken();
    const r = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${BASE_BRANCH}?recursive=1`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    if (!r.ok) return [];
    const j = (await r.json()) as { tree?: Array<{ path?: string; type?: string }> };
    treeCache = (j.tree ?? [])
      .filter((t) => t.type === "blob" && typeof t.path === "string" && /\.(tsx?|jsx?)$/.test(t.path))
      .map((t) => t.path as string);
    return treeCache;
  } catch {
    return [];
  }
}

/** Match a guessed/partial path to a REAL repo path by basename + longest
 *  trailing-segment overlap (so dynamic `[slug]` segments don't defeat it). */
function resolveRealPath(guess: string, tree: string[]): string | null {
  const g = guess.replace(/^\/+/, "");
  if (!g || tree.length === 0) return null;
  if (tree.includes(g)) return g;
  const gSegs = g.split("/").filter(Boolean);
  const base = gSegs[gSegs.length - 1];
  const gSet = new Set(gSegs);
  let best: string | null = null;
  let bestScore = 0;
  for (const p of tree) {
    const segs = p.split("/");
    if (segs[segs.length - 1] !== base) continue; // basename must match
    let trailing = 0;
    for (let i = 1; i <= Math.min(gSegs.length, segs.length); i++) {
      if (gSegs[gSegs.length - i] === segs[segs.length - i]) trailing++;
      else break;
    }
    const overlap = segs.filter((s) => gSet.has(s)).length;
    const score = trailing * 10 + overlap;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

async function getToken(): Promise<string | null> {
  try {
    const db = createServiceRoleClient();
    const { data } = await db
      .from("platform_settings")
      .select("github_fix_token")
      .eq("id", "platform")
      .maybeSingle();
    const t = (data as { github_fix_token?: string | null } | null)?.github_fix_token?.trim();
    if (t) return t;
  } catch {
    /* fall through */
  }
  return process.env.GITHUB_FIX_TOKEN?.trim() ?? null;
}

async function gh(token: string, path: string, init?: RequestInit) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
}

/** Open a draft PR that replaces one file with the corrected content. */
async function openDraftPr(
  token: string,
  filePath: string,
  newContent: string,
  title: string,
  body: string,
  errorId: string,
): Promise<string | null> {
  try {
    // 1. base sha
    const refRes = await gh(token, `/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${BASE_BRANCH}`);
    if (!refRes.ok) return null;
    const baseSha = ((await refRes.json()) as { object?: { sha?: string } }).object?.sha;
    if (!baseSha) return null;

    // 2. branch
    const branch = `ai-fix/${errorId.slice(0, 8)}`;
    await gh(token, `/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    }); // 422 if it already exists — fine, we reuse it

    // 3. current file sha (to update)
    const fileRes = await gh(
      token,
      `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=${branch}`,
    );
    const fileSha = fileRes.ok ? ((await fileRes.json()) as { sha?: string }).sha : undefined;

    // 4. commit the corrected file
    const put = await gh(
      token,
      `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: `fix(ai): ${title}`.slice(0, 100),
          content: Buffer.from(newContent, "utf8").toString("base64"),
          branch,
          ...(fileSha ? { sha: fileSha } : {}),
        }),
      },
    );
    if (!put.ok) return null;

    // 5. draft PR
    const prRes = await gh(token, `/repos/${REPO_OWNER}/${REPO_NAME}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: `[AI draft] ${title}`.slice(0, 120),
        head: branch,
        base: BASE_BRANCH,
        draft: true,
        body: `${body}\n\n---\n⚠️ AI-drafted from the error monitor — review carefully before merging.`,
      }),
    });
    if (!prRes.ok) return null;
    return ((await prRes.json()) as { html_url?: string }).html_url ?? null;
  } catch (e) {
    console.error("[draftFix/openDraftPr]", e);
    return null;
  }
}

export async function draftFix(
  errorId: string,
): Promise<{
  ok: boolean;
  prUrl?: string | null;
  blocked?: "evidence_conflict";
}> {
  try {
    const db = createServiceRoleClient();
    const { data } = await db
      .from("error_logs")
      .select(
        "id, level, message, surface, route, stack, context, ai_summary, ai_suggested_fix",
      )
      .eq("id", errorId)
      .maybeSingle();
    const e = data as {
      level: string;
      message: string;
      surface: string | null;
      route: string | null;
      stack: string | null;
      context: Record<string, unknown> | null;
      ai_summary: string | null;
      ai_suggested_fix: string | null;
    } | null;
    if (!e) return { ok: false };

    const evidence = assessErrorEvidence(e.route, e.context);
    if (evidence.status === "conflict") {
      await db
        .from("error_logs")
        .update({
          fix_proposal: evidenceConflictSummary(evidence),
          fix_file: null,
          fix_pr_url: null,
        } as never)
        .eq("id", errorId);
      return { ok: false, blocked: "evidence_conflict" };
    }

    const client = getClient();
    if (!client) {
      await db
        .from("error_logs")
        .update({ fix_proposal: "AI fix needs ANTHROPIC_API_KEY configured." } as never)
        .eq("id", errorId);
      return { ok: false };
    }

    // 1. Which file? Claude reads the error/stack and names the likely repo path.
    const idResp = await trackAnthropicMessage(
      {
        salonId: null,
        feature: "error_fix_file",
        model: FIX_MODEL,
      },
      () => client.messages.create({
        model: FIX_MODEL,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: `NailIQ is a Next.js 16 + Supabase salon SaaS. Source lives under src/. Given this error, reply ONLY JSON {"file":"<most likely repo-relative source path, e.g. src/shared/booking/submitGroupBooking.ts, or empty if unknown>"}.\n\nmessage: ${e.message}\nstack: ${(e.stack ?? "").slice(0, 1500)}\nsummary: ${e.ai_summary ?? ""}`,
          },
        ],
      }),
    );
    const guessed = String((parseJson(textOf(idResp))?.file ?? "")).trim().replace(/^\/+/, "");
    // Minified prod stacks rarely carry the source path and the LLM guess often
    // misses dynamic segments (dashboard/center → dashboard/[slug]/center), so
    // resolve the guess against the REAL repo tree before fetching.
    const filePath = guessed ? (resolveRealPath(guessed, await fetchRepoTree()) ?? guessed) : "";
    const fileContent = filePath ? await fetchRawFile(filePath) : null;

    // 2. Draft the fix from the REAL file content when we have it.
    // Feed the triage diagnosis (ai_summary / ai_suggested_fix) so this step
    // builds on what the first pass already worked out instead of re-guessing
    // the root cause from scratch — a "Load failed" client error, for example,
    // is a network failure, not a metadata/parse bug, and the triage usually
    // catches that. Code wins on conflict: a stale/wrong triage must not
    // override what the actual file content shows.
    const triageBlock = [
      e.ai_summary ? `triage.diagnosis: ${e.ai_summary}` : "",
      e.ai_suggested_fix ? `triage.suggested_area: ${e.ai_suggested_fix}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const fixResp = await trackAnthropicMessage(
      {
        salonId: null,
        feature: "error_fix_draft",
        model: FIX_MODEL,
      },
      () => client.messages.create({
        model: FIX_MODEL,
        max_tokens: 4000,
        messages: [
          {
            role: "user",
            content: `You are fixing a bug in NailIQ (Next.js 16 + TypeScript). A first-pass triage already diagnosed this error — weigh its diagnosis before proposing a fix, but trust the actual file content over the triage if they conflict. Given the error and ${fileContent ? "the current file content" : "(file not fetchable — propose from the error alone)"}, reply ONLY JSON:
{"root_cause":"one sentence","change_summary":"what to change, plainly","pr_title":"conventional-commit style","pr_body":"short markdown explanation","corrected_file":${fileContent ? '"the FULL corrected file content if the fix is small + safe, else empty string"' : '""'}}

error.message: ${e.message}
error.stack: ${(e.stack ?? "").slice(0, 1500)}
${triageBlock ? `${triageBlock}\n` : ""}file: ${filePath || "(unknown)"}
${fileContent ? `\n--- current ${filePath} ---\n${fileContent}` : ""}`,
          },
        ],
      }),
    );
    const fix = parseJson(textOf(fixResp)) ?? {};
    const rootCause = String(fix.root_cause ?? "").slice(0, 500);
    const changeSummary = String(fix.change_summary ?? "").slice(0, 800);
    const correctedFile = String(fix.corrected_file ?? "");
    const proposal = `${rootCause}${changeSummary ? `\n\nChange: ${changeSummary}` : ""}`;

    await db
      .from("error_logs")
      .update({
        fix_proposal: proposal || "No proposal generated.",
        fix_file: filePath || null,
        remediation_state: "fix_proposed",
      } as never)
      .eq("id", errorId)
      .in("remediation_state" as never, ["detected", "triaged"] as never);

    // 3. Open a DRAFT PR if a token + a confident corrected file exist.
    let prUrl: string | null = null;
    const token = await getToken();
    if (token && filePath && fileContent && correctedFile && correctedFile.length > 50 && correctedFile !== fileContent) {
      prUrl = await openDraftPr(
        token,
        filePath,
        correctedFile,
        String(fix.pr_title ?? `fix: ${e.message.slice(0, 50)}`),
        String(fix.pr_body ?? proposal),
        errorId,
      );
      if (prUrl) {
        await db.from("error_logs").update({ fix_pr_url: prUrl } as never).eq("id", errorId);
      }
    }

    return { ok: true, prUrl };
  } catch (err) {
    console.error("[draftFix]", err);
    return { ok: false };
  }
}
