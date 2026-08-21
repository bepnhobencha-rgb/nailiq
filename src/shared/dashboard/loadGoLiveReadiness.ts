import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  evaluateGoLiveReadiness,
  type GoLiveReadiness,
  type GoLiveReadinessInput,
} from "@/shared/dashboard/goLiveReadiness";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
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
import { normalizeBrandColor } from "@/shared/lib/brandColor";
import { parseCurrency } from "@/shared/lib/currencyFormat";
import { loadPublicBookingSequenceReadiness } from "@/shared/booking/bookingSequenceReadiness";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolveReadinessStaffAccess } from "@/shared/dashboard/goLiveStaffAccess";

export type LoadGoLiveReadinessResult =
  | {
      ok: true;
      readiness: GoLiveReadiness;
      salonName: string;
      role: "owner" | "admin";
      technicalSnapshotHash: string;
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
  const serviceDb = createServiceRoleClient();

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
    membershipsResult,
    attestationsResult,
    ...latestAttestationResults
  ] = await Promise.all([
    serviceDb
      .from("salons")
      .select(
        "name, address, salon_phone, timezone, opening_hours, booking_closed_dates, booking_lead_minutes, resources_enabled, staff_selection_enabled, profile_complete, email, email_verified, email_links_enabled, phone_otp_enabled, cancellation_policy, default_notification_locale, payment_provider, voice_ai_enabled, feature_flags, guided_setup_integrations_skipped_at, group_together_threshold_minutes, noshow_group_whole_party, brand_color, currency_code, tax_lines",
      )
      .eq("id", ctx.salon.id)
      .maybeSingle(),
    ctx.supabase
      .from("services")
      .select(
        "id, name, description, price_cents, price_type, price_max_cents, duration_minutes, prep_minutes, buffer_minutes, is_addon, addon_timing",
      )
      .eq("salon_id", ctx.salon.id)
      .is("deleted_at" as never, null),
    ctx.supabase
      .from("staff")
      .select("id, name, job_role, user_id")
      .eq("salon_id", ctx.salon.id)
      .eq("status", "active")
      .is("deleted_at" as never, null),
    serviceDb
      .from("salon_members")
      .select("user_id, role")
      .eq("salon_id", ctx.salon.id),
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
    membershipsResult.error ||
    attestationsResult.error ||
    latestAttestationResults.some((result) => result.error)
  ) {
    console.error("[loadGoLiveReadiness]", {
      salon: salonResult.error?.code,
      services: servicesResult.error?.code,
      staff: staffResult.error?.code,
      memberships: membershipsResult.error?.code,
      attestations: attestationsResult.error?.code,
      latestAttestations: latestAttestationResults
        .map((result) => result.error?.code)
        .filter(Boolean),
    });
    return { ok: false, reason: "unavailable" };
  }

  const row = salonResult.data as {
    name?: unknown;
    address?: unknown;
    salon_phone?: unknown;
    timezone?: unknown;
    opening_hours?: unknown;
    booking_closed_dates?: unknown;
    booking_lead_minutes?: unknown;
    resources_enabled?: unknown;
    staff_selection_enabled?: unknown;
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
    guided_setup_integrations_skipped_at?: unknown;
    group_together_threshold_minutes?: unknown;
    noshow_group_whole_party?: unknown;
    brand_color?: unknown;
    currency_code?: unknown;
    tax_lines?: unknown;
  } | null;

  if (!row) return { ok: false, reason: "unavailable" };

  const guidedSetupEnabled = await isReleaseFeatureVisible(
    ctx.salon,
    "guided_admin_setup",
  );
  const multiServiceBookingEnabled = isReleaseFeatureEnabled(
    { feature_flags: row.feature_flags },
    "multi_service_booking",
  );
  // Service-only proof is backed by load_public_booking_sequence_readiness;
  // a tenant flag alone never makes this blocking check pass.
  let multiServiceSequenceReadiness;
  if (multiServiceBookingEnabled) {
    const sequenceReadinessResult = await loadPublicBookingSequenceReadiness(
      ctx.salon.id,
    );
    if (sequenceReadinessResult.ok) {
      multiServiceSequenceReadiness = sequenceReadinessResult.readiness;
    } else if (
      sequenceReadinessResult.code === "not_ready" &&
      sequenceReadinessResult.readiness
    ) {
      multiServiceSequenceReadiness = sequenceReadinessResult.readiness;
    } else {
      return { ok: false, reason: "unavailable" };
    }
  }

  const salonName =
    typeof row.name === "string" && row.name.trim()
      ? row.name.trim()
      : ctx.salon.name || slug;
  const serviceCandidates = (servicesResult.data ?? []).map((service) => {
    const value = service as {
      id?: unknown;
      name?: unknown;
      description?: unknown;
      price_cents?: unknown;
      price_type?: unknown;
      price_max_cents?: unknown;
      duration_minutes?: unknown;
      prep_minutes?: unknown;
      buffer_minutes?: unknown;
      is_addon?: unknown;
      addon_timing?: unknown;
    };
    return {
      id: typeof value.id === "string" ? value.id : "",
      name: typeof value.name === "string" ? value.name : "",
      description:
        typeof value.description === "string" ? value.description : null,
      priceCents:
        typeof value.price_cents === "number" ? value.price_cents : null,
      priceType:
        typeof value.price_type === "string" && value.price_type.trim()
          ? value.price_type.trim()
          : "fixed",
      priceMaxCents:
        typeof value.price_max_cents === "number"
          ? value.price_max_cents
          : null,
      durationMinutes:
        typeof value.duration_minutes === "number"
          ? value.duration_minutes
          : null,
      prepMinutes:
        typeof value.prep_minutes === "number" ? value.prep_minutes : null,
      bufferMinutes:
        typeof value.buffer_minutes === "number" ? value.buffer_minutes : null,
      isAddon: value.is_addon === true,
      addonTiming:
        typeof value.addon_timing === "string"
          ? value.addon_timing
          : "sequential",
    };
  });
  const activeServices = selectReadinessServices(
    serviceCandidates,
    guidedSetupEnabled,
  );
  const staffCandidates = (staffResult.data ?? []).flatMap((staff) => {
    const value = staff as {
      id?: unknown;
      name?: unknown;
      job_role?: unknown;
      user_id?: unknown;
    };
    if (typeof value.id !== "string") return [];
    const userId = typeof value.user_id === "string" ? value.user_id : null;
    return [
      {
        id: value.id,
        name: typeof value.name === "string" ? value.name : "",
        jobRole: typeof value.job_role === "string" ? value.job_role : null,
        userId,
      },
    ];
  });
  const membershipCandidates = (membershipsResult.data ?? []).flatMap((row) => {
    const value = row as { user_id?: unknown; role?: unknown };
    return typeof value.user_id === "string" && typeof value.role === "string"
      ? [{ userId: value.user_id, role: value.role }]
      : [];
  });
  const staffAccess = resolveReadinessStaffAccess(
    staffCandidates,
    membershipCandidates,
  );
  const activeStaff = staffAccess.staff;
  const activeStaffIds = activeStaff.map((staff) => staff.id);
  const staffAccessValid = staffAccess.valid;
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
  const staffShiftResult =
    guidedSetupEnabled && activeStaffIds.length > 0
      ? await ctx.supabase
          .from("staff_shifts")
          .select(
            "staff_id, day_of_week, start_time, end_time, break_start_time, break_end_time",
          )
          .in("staff_id", activeStaffIds)
          .eq("is_active", true)
      : { data: [], error: null };
  if (staffShiftResult.error) {
    console.error("[loadGoLiveReadiness] staff_shifts", {
      code: staffShiftResult.error.code,
    });
    return { ok: false, reason: "unavailable" };
  }
  const comboResult = guidedSetupEnabled
    ? await ctx.supabase
        .from("service_combos")
        .select(
          "id, name, description, service_ids, price_cents, discount_cents, duration_minutes",
        )
        .eq("salon_id", ctx.salon.id)
        .eq("is_active", true)
    : { data: [], error: null };
  if (comboResult.error) {
    console.error("[loadGoLiveReadiness] service_combos", {
      code: comboResult.error.code,
    });
    return { ok: false, reason: "unavailable" };
  }
  const readinessNowIso = new Date().toISOString();
  const promotionResult = guidedSetupEnabled
    ? await ctx.supabase
        .from("promotions" as never)
        .select(
          "id, name, starts_at, ends_at, discount_type, discount_value, applies_to, days_of_week, time_start, time_end" as never,
        )
        .eq("salon_id" as never, ctx.salon.id)
        .eq("active" as never, true)
        .lte("starts_at" as never, readinessNowIso)
        .gte("ends_at" as never, readinessNowIso)
    : { data: [], error: null };
  if (promotionResult.error) {
    console.error("[loadGoLiveReadiness] promotions", {
      code: promotionResult.error.code,
    });
    return { ok: false, reason: "unavailable" };
  }

  const bookingLeadMinutes =
    typeof row.booking_lead_minutes === "number" &&
    Number.isFinite(row.booking_lead_minutes)
      ? row.booking_lead_minutes
      : null;
  const resourcesEnabled =
    typeof row.resources_enabled === "boolean" ? row.resources_enabled : null;
  const staffSelectionEnabled =
    typeof row.staff_selection_enabled === "boolean"
      ? row.staff_selection_enabled
      : null;
  const taxLineSignature = Array.isArray(row.tax_lines)
    ? row.tax_lines.flatMap((taxLine) => {
        if (!taxLine || typeof taxLine !== "object") return [];
        const value = taxLine as {
          name?: unknown;
          rate?: unknown;
          enabled?: unknown;
        };
        if (
          typeof value.name !== "string" ||
          !value.name.trim() ||
          typeof value.rate !== "number" ||
          !Number.isFinite(value.rate) ||
          value.rate < 0 ||
          value.rate > 1 ||
          typeof value.enabled !== "boolean"
        ) {
          return [];
        }
        return [
          {
            name: value.name.trim(),
            rate: value.rate,
            enabled: value.enabled,
          },
        ];
      })
    : [];
  if (
    guidedSetupEnabled &&
    (bookingLeadMinutes === null ||
      bookingLeadMinutes < 0 ||
      resourcesEnabled === null ||
      staffSelectionEnabled === null ||
      !Array.isArray(row.tax_lines) ||
      taxLineSignature.length !== row.tax_lines.length ||
      serviceCandidates.some(
        (service) =>
          !service.isAddon &&
          (service.bufferMinutes === null || service.bufferMinutes < 0),
      ))
  ) {
    return { ok: false, reason: "unavailable" };
  }
  const promotionSignature = (promotionResult.data ?? []).flatMap(
    (promotion) => {
      const value = promotion as {
        id?: unknown;
        name?: unknown;
        starts_at?: unknown;
        ends_at?: unknown;
        discount_type?: unknown;
        discount_value?: unknown;
        applies_to?: unknown;
        days_of_week?: unknown;
        time_start?: unknown;
        time_end?: unknown;
      };
      if (
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        typeof value.starts_at !== "string" ||
        typeof value.ends_at !== "string" ||
        typeof value.discount_type !== "string" ||
        typeof value.discount_value !== "number" ||
        typeof value.applies_to !== "string" ||
        !(
          value.days_of_week === null ||
          (Array.isArray(value.days_of_week) &&
            value.days_of_week.every((day) => typeof day === "number"))
        ) ||
        !(value.time_start === null || typeof value.time_start === "string") ||
        !(value.time_end === null || typeof value.time_end === "string")
      ) {
        return [];
      }
      return [
        {
          promotionId: value.id,
          name: value.name,
          startsAt: value.starts_at,
          endsAt: value.ends_at,
          discountType: value.discount_type,
          discountValue: value.discount_value,
          appliesTo: value.applies_to,
          daysOfWeek: value.days_of_week as number[] | null,
          timeStart: value.time_start,
          timeEnd: value.time_end,
        },
      ];
    },
  );
  if (
    guidedSetupEnabled &&
    promotionSignature.length !== (promotionResult.data ?? []).length
  ) {
    return { ok: false, reason: "unavailable" };
  }
  const addOnSignature = serviceCandidates
    .filter((service) => service.isAddon)
    .map((service) => ({
      serviceId: service.id,
      name: service.name,
      description: service.description,
      priceCents: service.priceCents,
      priceType: service.priceType,
      priceMaxCents: service.priceMaxCents,
      durationMinutes: service.durationMinutes,
      bufferMinutes: service.bufferMinutes ?? 0,
      addonTiming: service.addonTiming,
    }));
  const comboSignature = (comboResult.data ?? []).flatMap((combo) => {
    const value = combo as {
      id?: unknown;
      name?: unknown;
      description?: unknown;
      service_ids?: unknown;
      price_cents?: unknown;
      discount_cents?: unknown;
      duration_minutes?: unknown;
    };
    if (
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      !Array.isArray(value.service_ids) ||
      !value.service_ids.every((id) => typeof id === "string") ||
      typeof value.price_cents !== "number" ||
      typeof value.discount_cents !== "number" ||
      typeof value.duration_minutes !== "number"
    ) {
      return [];
    }
    return [
      {
        comboId: value.id,
        name: value.name,
        description:
          typeof value.description === "string" ? value.description : null,
        serviceIds: value.service_ids as string[],
        priceCents: value.price_cents,
        discountCents: value.discount_cents,
        durationMinutes: value.duration_minutes,
      },
    ];
  });
  if (
    guidedSetupEnabled &&
    comboSignature.length !== (comboResult.data ?? []).length
  ) {
    return { ok: false, reason: "unavailable" };
  }
  const activeServiceIds = new Set(
    activeServices.map((service) => service.id).filter(Boolean),
  );
  const publicServiceSignature = serviceCandidates
    .filter((service) => activeServiceIds.has(service.id))
    .map((service) => ({
      serviceId: service.id,
      name: service.name,
      description: service.description,
      priceCents: service.priceCents,
      priceType: service.priceType,
      priceMaxCents: service.priceMaxCents,
      durationMinutes: service.durationMinutes,
      bufferMinutes: service.bufferMinutes ?? 0,
      totalMinutes:
        (service.durationMinutes ?? 0) + (service.bufferMinutes ?? 0),
    }));
  const publicStaffSignature = activeStaff.map((staff) => ({
    staffId: staff.id,
    name: staff.name,
    jobRole: staff.jobRole,
  }));
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
      `${a.serviceId}:${a.staffId}`.localeCompare(
        `${b.serviceId}:${b.staffId}`,
      ),
    );
  const coveredServiceIds = new Set(
    serviceCapabilitySignature.map((capability) => capability.serviceId),
  );
  const serviceCoverageValid = activeServices.every(
    (service) => Boolean(service.id) && coveredServiceIds.has(service.id),
  );
  const staffShiftSignature = (staffShiftResult.data ?? []).flatMap((shift) => {
    const value = shift as {
      staff_id?: unknown;
      day_of_week?: unknown;
      start_time?: unknown;
      end_time?: unknown;
      break_start_time?: unknown;
      break_end_time?: unknown;
    };
    if (
      typeof value.staff_id !== "string" ||
      !activeStaffIdSet.has(value.staff_id) ||
      typeof value.day_of_week !== "string" ||
      typeof value.start_time !== "string" ||
      typeof value.end_time !== "string" ||
      !(
        value.break_start_time === null ||
        typeof value.break_start_time === "string"
      ) ||
      !(
        value.break_end_time === null ||
        typeof value.break_end_time === "string"
      )
    ) {
      return [];
    }
    return [
      {
        staffId: value.staff_id,
        dayOfWeek: value.day_of_week,
        startTime: value.start_time,
        endTime: value.end_time,
        breakStartTime: value.break_start_time,
        breakEndTime: value.break_end_time,
      },
    ];
  });
  if (
    guidedSetupEnabled &&
    staffShiftSignature.length !== (staffShiftResult.data ?? []).length
  ) {
    return { ok: false, reason: "unavailable" };
  }
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
    salonPhone: typeof row.salon_phone === "string" ? row.salon_phone : null,
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
          optionalIntegrationsSkipped:
            typeof row.guided_setup_integrations_skipped_at === "string",
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
    ...(multiServiceBookingEnabled
      ? {
          multiServiceBookingEnabled: true,
          multiServiceSequenceReadiness,
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
          publicServiceSignature,
          publicStaffSignature,
          publicSalonPresentation: {
            brandColor: normalizeBrandColor(row.brand_color),
            currencyCode: parseCurrency(row.currency_code),
            taxLines: taxLineSignature,
          },
          availabilityConfiguration: {
            bookingLeadMinutes: bookingLeadMinutes ?? 0,
            resourcesEnabled: resourcesEnabled ?? false,
            staffSelectionEnabled: staffSelectionEnabled ?? true,
            staffShiftSignature,
          },
          unsupportedPublicCatalogSignature: {
            addOns: addOnSignature,
            combos: comboSignature,
            promotions: promotionSignature,
          },
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
    ...(multiServiceBookingEnabled
      ? {
          multiServiceSequence: {
            contractVersion:
              multiServiceSequenceReadiness?.contractVersion ?? null,
            scheduleModel: multiServiceSequenceReadiness?.scheduleModel ?? null,
            platformEnabled:
              multiServiceSequenceReadiness?.platformEnabled ?? false,
            salonEnabled: multiServiceSequenceReadiness?.salonEnabled ?? false,
            qaAllowlisted:
              multiServiceSequenceReadiness?.qaAllowlisted ?? false,
            catalogReady: multiServiceSequenceReadiness?.catalogReady ?? false,
            capacityContractReady:
              multiServiceSequenceReadiness?.capacityContractReady ?? false,
            ready: multiServiceSequenceReadiness?.ready ?? false,
            services: activeServices.map((service) => ({
              serviceId: service.id,
              prepMinutes:
                serviceCandidates.find(
                  (candidate) => candidate.id === service.id,
                )?.prepMinutes ?? null,
            })),
          },
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
    technicalSnapshotHash,
    snapshotHash,
  );

  return {
    ok: true,
    salonName,
    role: managerRole,
    technicalSnapshotHash,
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
