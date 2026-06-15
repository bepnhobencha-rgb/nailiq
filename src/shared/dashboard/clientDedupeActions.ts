"use server";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Customer Identity Layer — M6 duplicate detection + merge (owner-only).
 *
 * Finds likely-same-human client profiles in THIS salon (shared email or a
 * near-identical name across different phone numbers), optionally ranks them
 * with Haiku, and merges a confirmed pair via merge_client_profiles. Detection
 * is read-only and suggests; nothing is merged without an explicit owner action.
 */

export type DedupeIdentity = {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  isVip: boolean;
  visitCount: number;
  lastVisitAt: string | null;
};

export type DedupeSuggestion = {
  a: DedupeIdentity;
  b: DedupeIdentity;
  /** 0..1 confidence that a & b are the same person. */
  score: number;
  reason: string;
  /** AI-normalized display name to use for the merged profile, when available. */
  suggestedName: string | null;
};

export type FindDuplicatesResult =
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" }
  | { ok: true; suggestions: DedupeSuggestion[]; usedAi: boolean };

export type MergeResult =
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid_args" | "server_error" }
  | { ok: true; reassigned: number };

const MAX_PAIRS = 40; // bound AI cost + UI length

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export async function findDuplicateClients(
  slug: string,
  opts?: { useAi?: boolean; lang?: "en" | "vi" },
): Promise<FindDuplicatesResult> {
  const lang = opts?.lang === "vi" ? "vi" : "en";
  const reasonCopy =
    lang === "vi" ? { email: "Cùng email" } : { email: "Same email" };
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (resolved.role !== "owner") return { ok: false, error: "forbidden" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[findDuplicateClients] service role", e);
    return { ok: false, error: "server_error" };
  }

  type Row = {
    id?: string;
    phone?: string | null;
    name?: string | null;
    email?: string | null;
    is_vip?: boolean | null;
    visit_count?: number | null;
    last_visit_at?: string | null;
  };
  const { data, error } = (await admin.rpc(
    "list_salon_client_identities" as never,
    { p_salon_id: resolved.salon.id, p_limit: 2000 } as never,
  )) as { data: Row[] | null; error: unknown };

  if (error) {
    console.error("[findDuplicateClients] rpc", error);
    return { ok: false, error: "server_error" };
  }

  const ids: DedupeIdentity[] = (data ?? [])
    .filter((r) => typeof r.id === "string" && typeof r.phone === "string")
    .map((r) => ({
      id: String(r.id),
      phone: String(r.phone),
      name: r.name?.trim() || null,
      email: r.email?.trim()?.toLowerCase() || null,
      isVip: r.is_vip === true,
      visitCount: Number(r.visit_count ?? 0),
      lastVisitAt: r.last_visit_at?.trim() ? String(r.last_visit_at) : null,
    }));

  // Bucket by EMAIL only — the one hard cross-phone signal for "same person,
  // different number". NAME is deliberately NOT used to suggest merges: distinct
  // customers commonly share a name, so name-based merges would collapse two
  // different real people. Phone is already the identity key (one row per phone).
  const byEmail = new Map<string, DedupeIdentity[]>();
  for (const id of ids) {
    if (id.email) {
      const arr = byEmail.get(id.email) ?? [];
      arr.push(id);
      byEmail.set(id.email, arr);
    }
  }

  const seen = new Set<string>();
  const candidates: DedupeSuggestion[] = [];
  function addPairsFrom(group: DedupeIdentity[], base: number, reason: string) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].phone === group[j].phone) continue;
        const key = pairKey(group[i].id, group[j].id);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          a: group[i],
          b: group[j],
          score: base,
          reason,
          suggestedName: null,
        });
      }
    }
  }
  for (const g of byEmail.values()) if (g.length > 1) addPairsFrom(g, 0.9, reasonCopy.email);

  // Cap to bound cost; strongest heuristic first.
  candidates.sort((x, y) => y.score - x.score);
  const pairs = candidates.slice(0, MAX_PAIRS);

  let usedAi = false;
  if (opts?.useAi && pairs.length > 0) {
    const scored = await scorePairsWithAi(pairs, lang);
    if (scored) {
      usedAi = true;
      for (let i = 0; i < pairs.length; i++) {
        const s = scored[i];
        if (s) {
          pairs[i].score = s.samePerson;
          if (s.suggestedName) pairs[i].suggestedName = s.suggestedName;
          if (s.reason) pairs[i].reason = s.reason;
        }
      }
      pairs.sort((x, y) => y.score - x.score);
    }
  }

  return { ok: true, suggestions: pairs, usedAi };
}

type AiPairScore = { samePerson: number; suggestedName: string | null; reason: string | null };

/** Batched Haiku call: judge same-person + propose a clean display name.
 *  Returns null (caller keeps heuristics) on any failure. PII minimized — only
 *  names, emails and the last 4 phone digits leave the server. */
async function scorePairsWithAi(
  pairs: DedupeSuggestion[],
  lang: "en" | "vi",
): Promise<(AiPairScore | null)[] | null> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return null;

  const items = pairs.map((p, i) => ({
    i,
    a: { name: p.a.name, email: p.a.email, phone_last4: p.a.phone.slice(-4) },
    b: { name: p.b.name, email: p.b.email, phone_last4: p.b.phone.slice(-4) },
  }));

  const prompt =
    "You are de-duplicating salon customer records. Each pair already SHARES AN " +
    "EMAIL (the strong signal) but has different phone numbers — judge whether A " +
    "and B are the SAME person. IMPORTANT: a matching or similar NAME is NOT " +
    "evidence on its own (different customers commonly share a name); rely on the " +
    "shared email and any other corroboration. A clearly different name on the " +
    "same email can still be the same person (a shared family email) — stay near " +
    "0.5 when unsure rather than high. Return ONLY a JSON array, one object per " +
    'pair: {"i":<index>,"samePerson":<0..1>,"suggestedName":<clean canonical ' +
    'display name or null>,"reason":<short>}. suggestedName: best-formatted name ' +
    "(proper case, keep diacritics) or null. Write `reason` in " +
    (lang === "vi" ? "Vietnamese" : "English") +
    ".\n\nPairs:\n" +
    JSON.stringify(items);

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 2048,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      }),
    });
  } catch (e) {
    console.error("[scorePairsWithAi] fetch", e);
    return null;
  }
  if (!res.ok) {
    console.error("[scorePairsWithAi] non-ok", res.status);
    return null;
  }

  try {
    const payload = (await res.json()) as {
      content?: Array<{ text?: string }>;
    };
    const text = payload.content?.map((c) => c.text ?? "").join("") ?? "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const arr = JSON.parse(match[0]) as Array<{
      i?: number;
      samePerson?: number;
      suggestedName?: string | null;
      reason?: string | null;
    }>;
    const out: (AiPairScore | null)[] = pairs.map(() => null);
    for (const o of arr) {
      if (typeof o.i === "number" && o.i >= 0 && o.i < pairs.length) {
        out[o.i] = {
          samePerson: Math.max(0, Math.min(1, Number(o.samePerson ?? 0))),
          suggestedName:
            typeof o.suggestedName === "string" && o.suggestedName.trim()
              ? o.suggestedName.trim()
              : null,
          reason: typeof o.reason === "string" ? o.reason : null,
        };
      }
    }
    return out;
  } catch (e) {
    console.error("[scorePairsWithAi] parse", e);
    return null;
  }
}

export async function mergeClientProfilesAction(
  slug: string,
  keepId: string,
  dropId: string,
  opts?: { renameTo?: string | null },
): Promise<MergeResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (resolved.role !== "owner") return { ok: false, error: "forbidden" };
  if (!keepId || !dropId || keepId === dropId) {
    return { ok: false, error: "invalid_args" };
  }

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[mergeClientProfiles] service role", e);
    return { ok: false, error: "server_error" };
  }

  const { data, error } = (await admin.rpc("merge_client_profiles" as never, {
    p_keep_id: keepId,
    p_drop_id: dropId,
  } as never)) as {
    data: { success?: boolean; reassigned?: number; code?: string } | null;
    error: unknown;
  };

  if (error || !data?.success) {
    console.error("[mergeClientProfiles] rpc", error ?? data?.code);
    return { ok: false, error: "server_error" };
  }

  // Optional: apply the AI-suggested clean name to the surviving profile.
  const rename = opts?.renameTo?.trim();
  if (rename) {
    await admin
      .from("client_profiles")
      .update({ name: rename.slice(0, 200) } as never)
      .eq("id", keepId);
  }

  return { ok: true, reassigned: Number(data.reassigned ?? 0) };
}
