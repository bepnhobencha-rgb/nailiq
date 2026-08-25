import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  evaluateGoLiveReadiness,
  type GoLiveReadiness,
  type GoLiveReadinessInput,
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
import { normalizeBookingClosedDateList } from "@/shared/booking/parseBookingClosedDates";
import { selectReadinessServices } from "@/shared/dashboard/readinessServiceSelection";

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
        "name, address, salon_phone, timezone, opening_hours, booking_closed_dates, profile_complete, email, email_verified, email_links_enabled, phone_otp_enabled, cancellation_policy, default_notification_locale, payment_provider, voice_ai_enabled, feature_flags, group_together_threshold_minutes, noshow_group_whole_party",
      )
      .eq("id", ctx.salon.id)
      .maybeSingle(),
    ctx.supabase
      .from("services")
      .select("id, price_cents, duration_minutes, is_addon")
      .eq("salon_id", ctx.salon.id)
      .is("deleted_at" as never, null),
    ctx.supabase
      .from("staff")
      .select("id, job_role, user_id")
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
        booking_closed_dates?: unknown;
        profile_complete?: unknown;
        email?: unknown;
        email_verified?: unknown;
        email_links_enabled?: unknown;
        phone_otp_enabled?: unknown;
        cancellation_policy?: unknown;
        default_notification_locale?: unknown;
        payment_provider?: unknown;
        voice_ai_enabled?: unknown;
        feature_flags?: unknown;
        group_together_threshold_minutes?: unknown;
        noshow_group_whole_party?: unknown;
      }
    | null;

  if (!row) return { ok: false, reason: "unavailable" };

  const guidedSetupEnabled = isReleaseFeatureEnabled(
    ctx.salon,
    "guided_admin_setup",
  );

  const salonName =
    typeof row.name === "string" && row.name.trim()
      ? row.name.trim()
      : ctx.salon.name || slug;
  const serviceCandidates = (servicesResult.data ?? []).map((service) => {
    const value = service as {
      id?: unknown;
      price_cents?: unknown;
      duration_minutes?: unknown;
      is_addon?: unknown;
    };
    return {
      id: typeof value.id === "string" ? value.id : "",
      priceCents:
        typeof value.price_cents === "number" ? value.price_cents : null,
      durationMinutes:
        typeof value.duration_minutes === "number"
          ? value.duration_minutes
          : null,
      isAddon: value.is_addon === true,
    };
  });
  const activeServices = selectReadinessServices(
    serviceCandidates,
    guidedSetupEnabled,
  );
  const allowedJobRoles = new Set(["owner", "senior", "nail_tech"]);
  const activeStaff = (staffResult.data ?? []).flatMap((staff) => {
    const value = staff as {
      id?: unknown;
      job_role?: unknown;
      user_id?: unknown;
    };
    if (typeof value.id !== "string") return [];
    const userId = typeof value.user_id === "string" ? value.user_id : null;
    return [{
      id: value.id,
      jobRole: typeof value.job_role === "string" ? value.job_role : null,
      userId,
      // Do not infer an authorization state from the normal salon_members
      // RLS view (it exposes only the caller), and do not call a service-role
      // helper from this readiness loader. Linked accounts therefore remain
      // explicitly unverified until a separately approved auth-safe API exists.
      membershipRole: null,
      accessActive: null,
    }];
  });
  const activeStaffIds = activeStaff.map((staff) => staff.id);
  const staffAccessValid =
    activeStaff.every(
      (staff) =>
        staff.jobRole !== null &&
        allowedJobRoles.has(staff.jobRole) &&
        staff.userId === null,
    );
  const capabilityResult =
    guidedSetupEnabled && activeStaffIds.length > 0
      ? await ctx.supabase
          .from("staff_services")
          .select("staff_id, service_id")
          .in("staff_id", activeStaffIds)
      : { data: [], error: null };
  if (capabilityResult.error) {
    console.error("[loadGoLiveReadiness] staff_services", {
      code: capabilityResult.error.code,
    });
    return { ok: false, reason: "unavailable" };
  }
  const activeServiceIds = new Set(
    activeServices.map((service) => service.id).filter(Boolean),
  );
  const activeStaffIdSet = new Set(activeStaffIds);
  const serviceCapabilitySignature = (capabilityResult.data ?? [])
    .flatMap((capability) => {
      const value = capability as { staff_id?: unknown; service_id?: unknown };
      if (
        typeof value.staff_id !== "string" ||
        typeof value.service_id !== "string" ||
        !activeStaffIdSet.has(value.staff_id) ||
        !activeServiceIds.has(value.service_id)
      ) {
        return [];
      }
      return [{ staffId: value.staff_id, serviceId: value.service_id }];
    })
    .sort((a, b) =>
      `${a.serviceId}:${a.staffId}`.localeCompare(`${b.serviceId}:${b.staffId}`),
    );
  const coveredServiceIds = new Set(
    serviceCapabilitySignature.map((capability) => capability.serviceId),
  );
  const serviceCoverageValid = activeServices.every(
    (service) => Boolean(service.id) && coveredServiceIds.has(service.id),
  );
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

  const readinessInput: GoLiveReadinessInput = {
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
    ...(guidedSetupEnabled
      ? {
          bookingClosedDates: row.booking_closed_dates,
          cancellationPolicy: row.cancellation_policy,
          defaultNotificationLocale: row.default_notification_locale,
          paymentProvider: row.payment_provider,
          voiceAiEnabled: row.voice_ai_enabled === true,
          guidedSetupEnabled: true,
          staffAccessValid,
          serviceCoverageValid,
          groupBookingEnabled: isReleaseFeatureEnabled(
            { feature_flags: row.feature_flags },
            "group_booking",
          ),
          groupTogetherThresholdMinutes: row.group_together_threshold_minutes,
          noShowGroupWholeParty: row.noshow_group_whole_party,
        }
      : {}),
    activeServices,
    activeStaffCount: activeStaffIds.length,
  };
  const technicalSnapshotHash = createGoLiveReadinessSnapshotHash({
    // Preserve the exact pre-pilot material for flag-OFF salons. These runtime
    // keys were part of the historical spread and existing owner approvals
    // must not become stale merely because Guided Setup code is present.
    slug: readinessInput.slug,
    name: readinessInput.name,
    address: readinessInput.address,
    salonPhone: readinessInput.salonPhone,
    timezone: readinessInput.timezone,
    openingHours: readinessInput.openingHours,
    ...(guidedSetupEnabled
      ? {
          bookingClosedDates: normalizeBookingClosedDateList(
            readinessInput.bookingClosedDates,
          ),
          cancellationPolicy: readinessInput.cancellationPolicy,
          defaultNotificationLocale: readinessInput.defaultNotificationLocale,
          paymentProvider: readinessInput.paymentProvider,
          voiceAiEnabled: readinessInput.voiceAiEnabled,
        }
      : {}),
    profileComplete: readinessInput.profileComplete,
    email: readinessInput.email,
    emailVerified: readinessInput.emailVerified,
    emailLinksEnabled: readinessInput.emailLinksEnabled,
    phoneOtpEnabled: readinessInput.phoneOtpEnabled,
    activeServices,
    activeStaffCount: activeStaffIds.length,
    // Turning the QA pilot on starts a new approval contract. Omit the false
    // value so existing, flag-off salons retain their exact historical hash.
    ...(guidedSetupEnabled ? { guidedSetupEnabled: true as const } : {}),
    ...(guidedSetupEnabled
      ? {
          staffAccessSignature: activeStaff.map((staff) => ({
            staffId: staff.id,
            jobRole: staff.jobRole,
            userId: staff.userId,
            membershipRole: staff.membershipRole,
            accessActive: staff.accessActive,
          })),
          serviceCapabilitySignature,
          groupBookingEnabled: readinessInput.groupBookingEnabled,
          groupTogetherThresholdMinutes:
            typeof readinessInput.groupTogetherThresholdMinutes === "number"
              ? readinessInput.groupTogetherThresholdMinutes
              : null,
          noShowGroupWholeParty:
            typeof readinessInput.noShowGroupWholeParty === "boolean"
              ? readinessInput.noShowGroupWholeParty
              : null,
        }
      : {}),
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
    guidedSetupEnabled,
    readiness: evaluateGoLiveReadiness({
      ...readinessInput,
      humanAttestations: attestationState,
    }),
  };
}
