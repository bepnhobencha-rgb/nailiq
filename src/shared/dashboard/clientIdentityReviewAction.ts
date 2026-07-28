"use server";

import { revalidatePath } from "next/cache";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwner } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type ClientIdentityProfile = {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  visitCount: number;
  totalSpentCents: number;
};

export type ClientIdentityCandidate = {
  key: string;
  left: ClientIdentityProfile;
  right: ClientIdentityProfile;
  confidence: "high" | "review";
  reasons: Array<"same_email" | "same_phone_tail" | "same_name">;
};

export type ClientIdentityMergeRecord = {
  id: string;
  canonical: ClientIdentityProfile;
  alias: ClientIdentityProfile;
  aliasPhone: string;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
};

export type ClientIdentityMergeEvent = {
  id: string;
  aliasId: string;
  action: "merge" | "revoke";
  canonicalName: string | null;
  aliasName: string | null;
  aliasPhone: string;
  reason: string;
  affectedBookings: number;
  createdAt: string;
};

export type LoadClientIdentityReviewResult =
  | {
      ok: true;
      candidates: ClientIdentityCandidate[];
      activeMerges: ClientIdentityMergeRecord[];
      history: ClientIdentityMergeEvent[];
      canMerge: boolean;
    }
  | { ok: false; reason: "unauthorized" | "unavailable" };

export type ControlClientIdentityMergeResult =
  | { ok: true; affectedBookings: number }
  | {
      ok: false;
      reason:
        | "unauthorized"
        | "invalid_input"
        | "not_found"
        | "conflict"
        | "unavailable";
    };

type DirectoryRow = {
  client_profile_id?: string | null;
  phone?: string | null;
  name?: string | null;
  email?: string | null;
  visit_count?: number | null;
  total_spent_cents?: number | null;
};

type AliasRow = {
  id: string;
  canonical_profile_id: string;
  alias_profile_id: string;
  alias_phone: string;
  active: boolean;
  created_at: string;
  revoked_at: string | null;
};

type EventRow = {
  id: string;
  alias_id: string;
  action: "merge" | "revoke";
  canonical_profile_id: string;
  alias_profile_id: string;
  alias_phone: string;
  reason: string;
  affected_bookings: number;
  created_at: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DIRECTORY_ROWS = 500;
const MAX_CANDIDATES = 50;

function normalizeEmail(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeName(value: string | null): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function phoneTail(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

function toProfile(row: DirectoryRow): ClientIdentityProfile | null {
  if (
    typeof row.client_profile_id !== "string" ||
    !UUID_RE.test(row.client_profile_id) ||
    typeof row.phone !== "string" ||
    !row.phone.trim()
  ) {
    return null;
  }
  return {
    id: row.client_profile_id,
    name: row.name?.trim() || null,
    phone: row.phone,
    email: row.email?.trim() || null,
    visitCount: Number(row.visit_count ?? 0),
    totalSpentCents: Number(row.total_spent_cents ?? 0),
  };
}

function rankCandidates(
  profiles: ClientIdentityProfile[],
): ClientIdentityCandidate[] {
  const candidates: ClientIdentityCandidate[] = [];
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    const left = profiles[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < profiles.length;
      rightIndex += 1
    ) {
      const right = profiles[rightIndex]!;
      const reasons: ClientIdentityCandidate["reasons"] = [];
      const leftEmail = normalizeEmail(left.email);
      const rightEmail = normalizeEmail(right.email);
      const leftTail = phoneTail(left.phone);
      const rightTail = phoneTail(right.phone);
      const leftName = normalizeName(left.name);
      const rightName = normalizeName(right.name);

      if (leftEmail && leftEmail === rightEmail) reasons.push("same_email");
      if (
        left.phone !== right.phone &&
        leftTail &&
        leftTail === rightTail
      ) {
        reasons.push("same_phone_tail");
      }
      if (
        left.phone !== right.phone &&
        leftName.length >= 3 &&
        leftName === rightName
      ) {
        reasons.push("same_name");
      }
      if (reasons.length === 0) continue;

      const strong =
        reasons.includes("same_email") || reasons.includes("same_phone_tail");
      candidates.push({
        key: [left.id, right.id].sort().join(":"),
        left,
        right,
        confidence: strong ? "high" : "review",
        reasons,
      });
    }
  }
  return candidates
    .sort((a, b) => {
      if (a.confidence !== b.confidence) {
        return a.confidence === "high" ? -1 : 1;
      }
      const aVisits = a.left.visitCount + a.right.visitCount;
      const bVisits = b.left.visitCount + b.right.visitCount;
      return bVisits - aVisits || a.key.localeCompare(b.key);
    })
    .slice(0, MAX_CANDIDATES);
}

function rpcFailureReason(code: unknown): ControlClientIdentityMergeResult {
  if (
    code === "canonical_not_found" ||
    code === "alias_not_found" ||
    code === "active_merge_not_found" ||
    code === "canonical_not_in_salon" ||
    code === "alias_not_in_salon"
  ) {
    return { ok: false, reason: "not_found" };
  }
  if (
    code === "merge_chain_not_allowed" ||
    code === "invalid_args"
  ) {
    return { ok: false, reason: "conflict" };
  }
  if (code === "forbidden") {
    return { ok: false, reason: "unauthorized" };
  }
  if (code === "invalid_reason") {
    return { ok: false, reason: "invalid_input" };
  }
  return { ok: false, reason: "unavailable" };
}

async function ownerContext(slug: string) {
  const ctx = await getDashboardWriteClient(slug);
  if (
    !ctx ||
    ctx.kind !== "member" ||
    !ctx.userId ||
    !isOwner(ctx.role)
  ) {
    return null;
  }
  return ctx;
}

export async function loadClientIdentityReview(
  slug: string,
): Promise<LoadClientIdentityReviewResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || ctx.kind !== "member" || !ctx.userId) {
    return { ok: false, reason: "unauthorized" };
  }
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    return { ok: false, reason: "unauthorized" };
  }

  const admin = createServiceRoleClient();
  const [directoryResult, aliasesResult, eventsResult] = await Promise.all([
    admin.rpc("search_salon_clients", {
      p_salon_id: ctx.salon.id,
      p_search: "",
      p_limit: MAX_DIRECTORY_ROWS,
      p_offset: 0,
    }),
    admin
      .from("salon_client_identity_aliases" as never)
      .select(
        "id, canonical_profile_id, alias_profile_id, alias_phone, active, created_at, revoked_at",
      )
      .eq("salon_id" as never, ctx.salon.id)
      .order("created_at" as never, { ascending: false })
      .limit(100),
    admin
      .from("salon_client_identity_merge_events" as never)
      .select(
        "id, alias_id, action, canonical_profile_id, alias_profile_id, alias_phone, reason, affected_bookings, created_at",
      )
      .eq("salon_id" as never, ctx.salon.id)
      .order("created_at" as never, { ascending: false })
      .limit(50),
  ]);

  if (directoryResult.error || aliasesResult.error || eventsResult.error) {
    console.error("[loadClientIdentityReview]", {
      directory: directoryResult.error?.code,
      aliases: aliasesResult.error?.code,
      events: eventsResult.error?.code,
    });
    return { ok: false, reason: "unavailable" };
  }

  const profiles = ((directoryResult.data ?? []) as DirectoryRow[])
    .map(toProfile)
    .filter((profile): profile is ClientIdentityProfile => profile !== null);
  const aliases = (aliasesResult.data ?? []) as unknown as AliasRow[];
  const events = (eventsResult.data ?? []) as unknown as EventRow[];
  const profileIds = Array.from(
    new Set(
      [...aliases, ...events].flatMap((row) => [
        row.canonical_profile_id,
        row.alias_profile_id,
      ]),
    ),
  );

  const historicalProfiles =
    profileIds.length === 0
      ? { data: [] as unknown[], error: null }
      : await admin
          .from("client_profiles")
          .select(
            "id, phone, name, email, visit_count, total_spent_cents",
          )
          .in("id", profileIds);
  if (historicalProfiles.error) {
    console.error(
      "[loadClientIdentityReview] client_profiles",
      historicalProfiles.error.code,
    );
    return { ok: false, reason: "unavailable" };
  }

  const byId = new Map<string, ClientIdentityProfile>();
  for (const profile of profiles) byId.set(profile.id, profile);
  for (const row of (historicalProfiles.data ?? []) as DirectoryRow[]) {
    const profile = toProfile({
      ...row,
      client_profile_id: (row as { id?: string }).id,
    });
    if (profile) byId.set(profile.id, profile);
  }

  const fallback = (id: string, phone: string): ClientIdentityProfile => ({
    id,
    name: null,
    phone,
    email: null,
    visitCount: 0,
    totalSpentCents: 0,
  });

  return {
    ok: true,
    candidates: rankCandidates(profiles),
    activeMerges: aliases
      .filter((row) => row.active)
      .map((row) => ({
        id: row.id,
        canonical:
          byId.get(row.canonical_profile_id) ??
          fallback(row.canonical_profile_id, ""),
        alias:
          byId.get(row.alias_profile_id) ??
          fallback(row.alias_profile_id, row.alias_phone),
        aliasPhone: row.alias_phone,
        active: row.active,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
      })),
    history: events.map((row) => ({
      id: row.id,
      aliasId: row.alias_id,
      action: row.action,
      canonicalName: byId.get(row.canonical_profile_id)?.name ?? null,
      aliasName: byId.get(row.alias_profile_id)?.name ?? null,
      aliasPhone: row.alias_phone,
      reason: row.reason,
      affectedBookings: Number(row.affected_bookings ?? 0),
      createdAt: row.created_at,
    })),
    canMerge: ctx.role === "owner",
  };
}

export async function mergeClientIdentity(
  slug: string,
  input: {
    canonicalProfileId: string;
    aliasProfileId: string;
    reason: string;
  },
): Promise<ControlClientIdentityMergeResult> {
  const canonicalProfileId = input?.canonicalProfileId?.trim();
  const aliasProfileId = input?.aliasProfileId?.trim();
  const reason = input?.reason?.trim();
  if (
    !UUID_RE.test(canonicalProfileId ?? "") ||
    !UUID_RE.test(aliasProfileId ?? "") ||
    canonicalProfileId === aliasProfileId ||
    !reason ||
    reason.length < 10 ||
    reason.length > 500
  ) {
    return { ok: false, reason: "invalid_input" };
  }

  const ctx = await ownerContext(slug);
  if (!ctx) return { ok: false, reason: "unauthorized" };

  const { data, error } = await createServiceRoleClient().rpc(
    "merge_salon_client_identity" as never,
    {
      p_salon_id: ctx.salon.id,
      p_canonical_profile_id: canonicalProfileId,
      p_alias_profile_id: aliasProfileId,
      p_reason: reason,
      p_actor_user_id: ctx.userId,
    } as never,
  );
  if (error) {
    console.error("[mergeClientIdentity]", error.code);
    return { ok: false, reason: "unavailable" };
  }
  const result = (data ?? {}) as {
    success?: boolean;
    code?: string;
    affected_bookings?: number;
  };
  if (!result.success) return rpcFailureReason(result.code);

  revalidatePath(`/dashboard/${encodeURIComponent(slug)}/clients`);
  return {
    ok: true,
    affectedBookings: Number(result.affected_bookings ?? 0),
  };
}

export async function revokeClientIdentityMerge(
  slug: string,
  input: { aliasId: string; reason: string },
): Promise<ControlClientIdentityMergeResult> {
  const aliasId = input?.aliasId?.trim();
  const reason = input?.reason?.trim();
  if (
    !UUID_RE.test(aliasId ?? "") ||
    !reason ||
    reason.length < 10 ||
    reason.length > 500
  ) {
    return { ok: false, reason: "invalid_input" };
  }

  const ctx = await ownerContext(slug);
  if (!ctx) return { ok: false, reason: "unauthorized" };

  const { data, error } = await createServiceRoleClient().rpc(
    "revoke_salon_client_identity_merge" as never,
    {
      p_salon_id: ctx.salon.id,
      p_alias_id: aliasId,
      p_reason: reason,
      p_actor_user_id: ctx.userId,
    } as never,
  );
  if (error) {
    console.error("[revokeClientIdentityMerge]", error.code);
    return { ok: false, reason: "unavailable" };
  }
  const result = (data ?? {}) as {
    success?: boolean;
    code?: string;
    affected_bookings?: number;
  };
  if (!result.success) return rpcFailureReason(result.code);

  revalidatePath(`/dashboard/${encodeURIComponent(slug)}/clients`);
  return {
    ok: true,
    affectedBookings: Number(result.affected_bookings ?? 0),
  };
}
