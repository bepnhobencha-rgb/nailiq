"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { requireActiveSuperAdminSession } from "@/shared/auth/requireActiveSuperAdminSession";
import { writeAuditLog } from "@/shared/superadmin/audit";
import {
  SquareConnectionValidationError,
  validateSquareProductionConnection,
} from "@/shared/integrations/square/connectValidation";
import type {
  LoadSquareConnectionResult,
  SquareConnectActionState,
} from "@/shared/superadmin/squareConnectionTypes";

const STUDIO_SALON_ID = "a7de260d-999e-4462-a11e-2297aa615012";
const STUDIO_APPLICATION_ID = "sq0idp-oQUEDOoXmHMFDs5HqqM-1Q";
const BOOKING_SYNC_DISABLED =
  "Square location is not enabled for Square Bookings; booking sync remains disabled";

const connectSchema = z.object({
  salonId: z.string().uuid(),
  applicationId: z
    .string()
    .trim()
    .regex(/^sq0idp-[A-Za-z0-9_-]{10,}$/),
  accessToken: z.string().trim().min(20).max(512).regex(/^\S+$/),
  confirmOwnership: z.literal("yes"),
});

type IntegrationRow = {
  salon_id: string;
  merchant_id: string;
  location_id: string;
  access_token: string | null;
  application_id: string | null;
  environment: string | null;
  enabled: boolean | null;
  deposit_enabled: boolean | null;
  reverse_create_enabled: boolean | null;
  sync_pull_create: boolean | null;
  sync_pull_update: boolean | null;
  sync_pull_cancel: boolean | null;
  sync_push_create: boolean | null;
  sync_push_update: boolean | null;
  sync_push_cancel: boolean | null;
  last_error: string | null;
  updated_at: string | null;
};

const INTEGRATION_COLUMNS =
  "salon_id,merchant_id,location_id,access_token,application_id,environment,enabled,deposit_enabled,reverse_create_enabled,sync_pull_create,sync_pull_update,sync_pull_cancel,sync_push_create,sync_push_update,sync_push_cancel,last_error,updated_at";

function publicIntegrationSnapshot(row: IntegrationRow | null) {
  if (!row) return null;
  return {
    merchant_id: row.merchant_id,
    location_id: row.location_id,
    application_id: row.application_id,
    environment: row.environment,
    enabled: Boolean(row.enabled),
    credentials_stored: Boolean(row.access_token),
    deposit_enabled: Boolean(row.deposit_enabled),
    sync_pull_create: Boolean(row.sync_pull_create),
    sync_pull_update: Boolean(row.sync_pull_update),
    sync_pull_cancel: Boolean(row.sync_pull_cancel),
    sync_push_create: Boolean(row.sync_push_create),
    sync_push_update: Boolean(row.sync_push_update),
    sync_push_cancel: Boolean(row.sync_push_cancel),
  };
}

export async function loadSquareConnectionStatus(
  salonId: string,
): Promise<LoadSquareConnectionResult> {
  const id = salonId.trim();
  if (!z.string().uuid().safeParse(id).success) {
    return { ok: false, error: "not_found" };
  }

  const access = await requireActiveSuperAdminSession();
  if (!access.ok) return { ok: false, error: "unauthorized" };
  const { role } = access;

  try {
    const admin = createServiceRoleClient();
    const [salonResult, integrationResult] = await Promise.all([
      admin
        .from("salons")
        .select("id,payment_provider" as never)
        .eq("id", id)
        .maybeSingle(),
      admin
        .from("square_integrations")
        .select(INTEGRATION_COLUMNS as never)
        .eq("salon_id", id)
        .maybeSingle(),
    ]);
    if (salonResult.error || integrationResult.error) {
      return { ok: false, error: "server_error" };
    }
    const salon = salonResult.data as
      | { id?: string; payment_provider?: string | null }
      | null;
    if (!salon?.id) return { ok: false, error: "not_found" };
    const row = (integrationResult.data ?? null) as IntegrationRow | null;
    const suggestedApplicationId =
      row?.application_id ?? (id === STUDIO_SALON_ID ? STUDIO_APPLICATION_ID : null);

    return {
      ok: true,
      status: {
        canManage: role === "founder",
        connected: Boolean(
          row?.enabled &&
            row.access_token &&
            row.merchant_id &&
            row.location_id &&
            row.application_id,
        ),
        credentialsStored: Boolean(row?.access_token),
        enabled: Boolean(row?.enabled),
        paymentProvider: salon.payment_provider ?? null,
        merchantId: row?.merchant_id ?? null,
        locationId: row?.location_id ?? null,
        applicationId: suggestedApplicationId,
        environment: row?.environment ?? null,
        bookingSyncReady: Boolean(
          row?.sync_pull_create &&
            row.sync_pull_update &&
            row.sync_pull_cancel,
        ),
        pushWritesEnabled: Boolean(
          row?.sync_push_create ||
            row?.sync_push_update ||
            row?.sync_push_cancel,
        ),
        lastError: row?.last_error ?? null,
        updatedAt: row?.updated_at ?? null,
      },
    };
  } catch {
    return { ok: false, error: "server_error" };
  }
}

export async function connectSquareSalon(
  _previous: SquareConnectActionState,
  formData: FormData,
): Promise<SquareConnectActionState> {
  const parsed = connectSchema.safeParse({
    salonId: formData.get("salonId"),
    applicationId: formData.get("applicationId"),
    accessToken: formData.get("accessToken"),
    confirmOwnership: formData.get("confirmOwnership"),
  });
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  if (
    parsed.data.salonId === STUDIO_SALON_ID &&
    parsed.data.applicationId !== STUDIO_APPLICATION_ID
  ) {
    return { ok: false, error: "invalid_input" };
  }

  const access = await requireActiveSuperAdminSession();
  if (!access.ok) return { ok: false, error: "unauthorized" };
  const { role, user, supabase } = access;
  if (role !== "founder") {
    return { ok: false, error: "founder_required" };
  }

  // Defense in depth: if the founder enrolled TOTP, a direct Server Action
  // request must still be at AAL2. Unenrolled founders remain at AAL1.
  const { data: aal, error: aalError } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError) return { ok: false, error: "server_error" };
  if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
    return { ok: false, error: "mfa_required" };
  }

  const admin = createServiceRoleClient();
  const { data: allowed, error: limitError } = await admin.rpc(
    "rate_limit_hit",
    {
      p_key: `superadmin:square-connect:${user.id}:${parsed.data.salonId}`,
      p_limit: 5,
      p_window_seconds: 900,
    },
  );
  if (limitError) return { ok: false, error: "server_error" };
  if (allowed !== true) return { ok: false, error: "rate_limited" };

  let validated;
  try {
    validated = await validateSquareProductionConnection(
      parsed.data.accessToken,
      parsed.data.applicationId,
    );
  } catch (error) {
    if (error instanceof SquareConnectionValidationError) {
      return { ok: false, error: error.code };
    }
    return { ok: false, error: "square_unavailable" };
  }

  const id = parsed.data.salonId;
  const [
    salonResult,
    existingResult,
    merchantCollisionResult,
    locationCollisionResult,
  ] = await Promise.all([
    admin
      .from("salons")
      .select("id,slug,name,payment_provider" as never)
      .eq("id", id)
      .maybeSingle(),
    admin
      .from("square_integrations")
      .select(INTEGRATION_COLUMNS as never)
      .eq("salon_id", id)
      .maybeSingle(),
    admin
      .from("square_integrations")
      .select("salon_id,merchant_id" as never)
      .eq("merchant_id", validated.merchantId)
      .neq("salon_id", id),
    admin
      .from("square_integrations")
      .select("salon_id,location_id" as never)
      .eq("location_id", validated.locationId)
      .neq("salon_id", id),
  ]);
  if (
    salonResult.error ||
    existingResult.error ||
    merchantCollisionResult.error ||
    locationCollisionResult.error
  ) {
    return { ok: false, error: "server_error" };
  }
  const salon = salonResult.data as
    | {
        id?: string;
        slug?: string | null;
        name?: string | null;
        payment_provider?: string | null;
      }
    | null;
  if (!salon?.id) return { ok: false, error: "invalid_input" };
  if (
    salon.payment_provider &&
    salon.payment_provider !== "square"
  ) {
    return { ok: false, error: "payment_provider_conflict" };
  }
  if (
    (merchantCollisionResult.data ?? []).length > 0 ||
    (locationCollisionResult.data ?? []).length > 0
  ) {
    return { ok: false, error: "account_conflict" };
  }

  const existing = (existingResult.data ?? null) as IntegrationRow | null;
  const sameIdentity = Boolean(
    existing &&
      existing.merchant_id === validated.merchantId &&
      existing.location_id === validated.locationId,
  );
  if (existing && !sameIdentity) {
    const { count, error: cardsError } = await admin
      .from("bookings")
      .select("id" as never, { count: "exact", head: true })
      .eq("salon_id", id)
      .gte("start_time_utc", new Date().toISOString())
      .not("noshow_card_id" as never, "is", null)
      .neq("status", "cancelled");
    if (cardsError) return { ok: false, error: "server_error" };
    if ((count ?? 0) > 0) {
      return { ok: false, error: "saved_card_conflict" };
    }
  }

  const now = new Date().toISOString();
  const integration = {
    salon_id: id,
    merchant_id: validated.merchantId,
    location_id: validated.locationId,
    access_token: parsed.data.accessToken,
    application_id: parsed.data.applicationId,
    environment: "production",
    enabled: true,
    deposit_enabled: sameIdentity ? Boolean(existing?.deposit_enabled) : false,
    reverse_create_enabled: sameIdentity
      ? Boolean(existing?.reverse_create_enabled)
      : false,
    sync_pull_create:
      validated.bookingSyncReady &&
      (sameIdentity ? existing?.sync_pull_create !== false : true),
    sync_pull_update:
      validated.bookingSyncReady &&
      (sameIdentity ? existing?.sync_pull_update !== false : true),
    sync_pull_cancel:
      validated.bookingSyncReady &&
      (sameIdentity ? existing?.sync_pull_cancel !== false : true),
    sync_push_create: sameIdentity
      ? Boolean(existing?.sync_push_create)
      : false,
    sync_push_update: sameIdentity
      ? Boolean(existing?.sync_push_update)
      : false,
    sync_push_cancel: sameIdentity
      ? Boolean(existing?.sync_push_cancel)
      : false,
    last_error: validated.bookingSyncReady ? null : BOOKING_SYNC_DISABLED,
    updated_at: now,
  };

  const audited = await writeAuditLog({
    actorUserId: user.id,
    actorRole: role,
    action: "square_connection_set",
    targetKind: "salon",
    targetId: id,
    beforeJsonb: {
      salon_slug: salon.slug ?? null,
      payment_provider: salon.payment_provider ?? null,
      square: publicIntegrationSnapshot(existing),
    },
    afterJsonb: {
      salon_slug: salon.slug ?? null,
      payment_provider: "square",
      square: publicIntegrationSnapshot(integration as IntegrationRow),
      location_name: validated.locationName,
      business_name: validated.merchantBusinessName,
      currency: validated.currency,
    },
    reason: "Founder connected Square through the credential-safe Superadmin flow",
  });
  if (!audited) return { ok: false, error: "audit_failed" };

  let integrationWritten = false;
  let salonWritten = false;
  try {
    const { error: upsertError } = await admin
      .from("square_integrations")
      .upsert(integration as never, { onConflict: "salon_id" });
    if (upsertError) return { ok: false, error: "server_error" };
    integrationWritten = true;

    const { error: salonUpdateError } = await admin
      .from("salons")
      .update({ payment_provider: "square" } as never)
      .eq("id", id);
    if (salonUpdateError) throw new Error("salon_update_failed");
    salonWritten = true;

    const [verifiedIntegration, verifiedSalon] = await Promise.all([
      admin
        .from("square_integrations")
        .select(
          "salon_id,merchant_id,location_id,application_id,environment,enabled,sync_push_create,sync_push_update,sync_push_cancel" as never,
        )
        .eq("salon_id", id)
        .maybeSingle(),
      admin
        .from("salons")
        .select("id,payment_provider" as never)
        .eq("id", id)
        .maybeSingle(),
    ]);
    const verified = verifiedIntegration.data as
      | {
          merchant_id?: string;
          location_id?: string;
          application_id?: string;
          environment?: string;
          enabled?: boolean;
        }
      | null;
    const verifiedSalonRow = verifiedSalon.data as
      | { payment_provider?: string | null }
      | null;
    if (
      verifiedIntegration.error ||
      verifiedSalon.error ||
      verified?.merchant_id !== validated.merchantId ||
      verified.location_id !== validated.locationId ||
      verified.application_id !== parsed.data.applicationId ||
      verified.environment !== "production" ||
      verified.enabled !== true ||
      verifiedSalonRow?.payment_provider !== "square"
    ) {
      throw new Error("post_write_verification_failed");
    }
  } catch {
    if (salonWritten) {
      await admin
        .from("salons")
        .update({
          payment_provider: salon.payment_provider ?? null,
        } as never)
        .eq("id", id);
    }
    if (integrationWritten) {
      if (existing) {
        await admin
          .from("square_integrations")
          .upsert(existing as never, { onConflict: "salon_id" });
      } else {
        await admin.from("square_integrations").delete().eq("salon_id", id);
      }
    }
    return { ok: false, error: "server_error" };
  }

  revalidatePath(`/superadmin/salons/${id}`);
  revalidatePath(`/dashboard/${salon.slug ?? ""}/no-show-protection`);

  return {
    ok: true,
    connected: {
      businessName: validated.merchantBusinessName,
      locationName: validated.locationName,
      merchantId: validated.merchantId,
      locationId: validated.locationId,
      currency: validated.currency,
      bookingSyncReady: validated.bookingSyncReady,
    },
  };
}
