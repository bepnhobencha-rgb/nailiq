import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  evaluateGoLiveReadiness,
  type GoLiveReadiness,
} from "@/shared/dashboard/goLiveReadiness";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import {
  deriveGoLiveAttestationState,
  GO_LIVE_ATTESTATION_KEYS,
  type GoLiveAttestationAction,
  type GoLiveAttestationEvent,
  type GoLiveAttestationKey,
  type GoLiveAttestationState,
} from "@/shared/dashboard/goLiveAttestations";
import {
  createGoLiveApprovalSnapshotHash,
  createGoLiveReadinessSnapshotHash,
} from "@/shared/dashboard/goLiveReadinessSnapshot";

export type LoadGoLiveReadinessResult =
  | {
      ok: true;
      readiness: GoLiveReadiness;
      salonName: string;
      role: "owner" | "admin";
      snapshotHash: string;
      attestationState: GoLiveAttestationState;
      attestationEvents: GoLiveAttestationEvent[];
      latestAttestationEvents: GoLiveAttestationEvent[];
      guidedSetupEnabled: boolean;
    }
  | { ok: false; reason: "unauthorized" | "unavailable" };

export async function loadGoLiveReadiness(
  slug: string,
): Promise<LoadGoLiveReadinessResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) {
    return { ok: false, reason: "unauthorized" };
  }
  const managerRole: "owner" | "admin" =
    ctx.role === "owner" ? "owner" : "admin";

  const latestAttestationQueries = GO_LIVE_ATTESTATION_KEYS.map((checkKey) =>
    ctx.supabase
      .from("salon_go_live_attestations" as never)
      .select(
        "id, check_key, action, evidence_note, actor_role, readiness_snapshot_hash, created_at" as never,
      )
      .eq("salon_id" as never, ctx.salon.id)
      .eq("check_key" as never, checkKey)
      .order("created_at" as never, { ascending: false })
      .order("id" as never, { ascending: false })
      .limit(1),
  );
  const [
    salonResult,
    servicesResult,
    staffResult,
    attestationsResult,
    ...latestAttestationResults
  ] = await Promise.all([
    ctx.supabase
      .from("salons")
      .select(
        "name, address, salon_phone, timezone, opening_hours, profile_complete, email, email_verified, email_links_enabled, phone_otp_enabled, cancellation_policy, default_notification_locale, payment_provider, voice_ai_enabled",
      )
      .eq("id", ctx.salon.id)
      .maybeSingle(),
    ctx.supabase
      .from("services")
      .select("id, price_cents, duration_minutes")
      .eq("salon_id", ctx.salon.id)
      .is("deleted_at" as never, null),
    ctx.supabase
      .from("staff")
      .select("id")
      .eq("salon_id", ctx.salon.id)
      .eq("status", "active")
      .is("deleted_at" as never, null),
    ctx.supabase
      .from("salon_go_live_attestations" as never)
      .select(
        "id, check_key, action, evidence_note, actor_role, readiness_snapshot_hash, created_at" as never,
      )
      .eq("salon_id" as never, ctx.salon.id)
      .order("created_at" as never, { ascending: false })
      .order("id" as never, { ascending: false })
      .limit(10),
    ...latestAttestationQueries,
  ]);

  if (
    salonResult.error ||
    servicesResult.error ||
    staffResult.error ||
    attestationsResult.error ||
    latestAttestationResults.some((result) => result.error)
  ) {
    console.error("[loadGoLiveReadiness]", {
      salon: salonResult.error?.code,
      services: servicesResult.error?.code,
      staff: staffResult.error?.code,
      attestations: attestationsResult.error?.code,
      latestAttestations: latestAttestationResults
        .map((result) => result.error?.code)
        .filter(Boolean),
    });
    return { ok: false, reason: "unavailable" };
  }

  const row = salonResult.data as
    | {
        name?: unknown;
        address?: unknown;
        salon_phone?: unknown;
        timezone?: unknown;
        opening_hours?: unknown;
        profile_complete?: unknown;
        email?: unknown;
        email_verified?: unknown;
        email_links_enabled?: unknown;
        phone_otp_enabled?: unknown;
        cancellation_policy?: unknown;
        default_notification_locale?: unknown;
        payment_provider?: unknown;
        voice_ai_enabled?: unknown;
      }
    | null;

  if (!row) return { ok: false, reason: "unavailable" };

  const salonName =
    typeof row.name === "string" && row.name.trim()
      ? row.name.trim()
      : ctx.salon.name || slug;
  const activeServices = (servicesResult.data ?? []).map((service) => {
    const value = service as {
      id?: unknown;
      price_cents?: unknown;
      duration_minutes?: unknown;
    };
    return {
      id: typeof value.id === "string" ? value.id : "",
      priceCents:
        typeof value.price_cents === "number" ? value.price_cents : null,
      durationMinutes:
        typeof value.duration_minutes === "number"
          ? value.duration_minutes
          : null,
    };
  });
  const activeStaffIds = (staffResult.data ?? [])
    .map((staff) => {
      const value = staff as { id?: unknown };
      return typeof value.id === "string" ? value.id : "";
    })
    .filter(Boolean);
  function parseAttestationEvents(data: unknown[]): GoLiveAttestationEvent[] {
    return data
    .map((event): GoLiveAttestationEvent | null => {
      const row = event as {
        id?: unknown;
        check_key?: unknown;
        action?: unknown;
        evidence_note?: unknown;
        actor_role?: unknown;
        readiness_snapshot_hash?: unknown;
        created_at?: unknown;
      };
      if (
        typeof row.id !== "string" ||
        !GO_LIVE_ATTESTATION_KEYS.includes(
          row.check_key as GoLiveAttestationKey,
        ) ||
        (row.action !== "attest" && row.action !== "revoke") ||
        (row.actor_role !== "owner" && row.actor_role !== "admin") ||
        typeof row.evidence_note !== "string" ||
        typeof row.created_at !== "string"
      ) {
        return null;
      }
      return {
        id: row.id,
        checkKey: row.check_key as GoLiveAttestationKey,
        action: row.action as GoLiveAttestationAction,
        evidenceNote: row.evidence_note,
        actorRole: row.actor_role,
        readinessSnapshotHash:
          typeof row.readiness_snapshot_hash === "string"
            ? row.readiness_snapshot_hash
            : null,
        createdAt: row.created_at,
      };
    })
    .filter((event): event is GoLiveAttestationEvent => event !== null);
  }
  const attestationEvents = parseAttestationEvents(
    (attestationsResult.data ?? []) as unknown[],
  );
  const latestAttestationEvents = parseAttestationEvents(
    latestAttestationResults.flatMap(
      (result) => (result.data ?? []) as unknown[],
    ),
  );

  const readinessInput = {
    slug,
    name: typeof row.name === "string" ? row.name : null,
    address: typeof row.address === "string" ? row.address : null,
    salonPhone:
      typeof row.salon_phone === "string" ? row.salon_phone : null,
    timezone: row.timezone,
    openingHours: row.opening_hours,
    profileComplete: row.profile_complete === true,
    email: typeof row.email === "string" ? row.email : null,
    emailVerified: row.email_verified === true,
    emailLinksEnabled: row.email_links_enabled !== false,
    phoneOtpEnabled: row.phone_otp_enabled === true,
    cancellationPolicy: row.cancellation_policy,
    defaultNotificationLocale: row.default_notification_locale,
    paymentProvider: row.payment_provider,
    voiceAiEnabled: row.voice_ai_enabled === true,
    activeServices,
    activeStaffCount: activeStaffIds.length,
  };
  const technicalSnapshotHash = createGoLiveReadinessSnapshotHash({
    ...readinessInput,
    services: activeServices,
    activeStaffIds,
  });
  const snapshotHash = createGoLiveApprovalSnapshotHash(
    technicalSnapshotHash,
    latestAttestationEvents,
  );
  const attestationState = deriveGoLiveAttestationState(
    latestAttestationEvents,
    snapshotHash,
  );

  return {
    ok: true,
    salonName,
    role: managerRole,
    snapshotHash,
    attestationState,
    attestationEvents,
    latestAttestationEvents,
    guidedSetupEnabled: isReleaseFeatureEnabled(
      ctx.salon,
      "guided_admin_setup",
    ),
    readiness: evaluateGoLiveReadiness({
      ...readinessInput,
      humanAttestations: attestationState,
    }),
  };
}
