/**
 * Type-only + constant companion for superadminActions.ts. Lives in a
 * separate module because Next.js requires "use server" files to export
 * ONLY async functions — types and constants need their own home.
 */

export const SUPPORTED_PLAN_OVERRIDES = [
  "free",
  "pro",
  "premium",
] as const;
export type SuperAdminPlanOverride =
  (typeof SUPPORTED_PLAN_OVERRIDES)[number]
  | null;

/**
 * Per-salon feature flag taxonomy (PR #108).
 *
 * The DB column `salons.feature_flags` is freeform jsonb so adding
 * new keys never requires a migration. This list is the source of
 * truth for SuperAdmin UI rendering, grouping, and the labels /
 * descriptions / phase / danger markers.
 *
 * Phase markers:
 *   - `live` — shipped, controllable
 *   - `phase_2` — planned, render with grey "Phase 2" badge
 *   - `phase_3` — planned, render with grey "Phase 3" badge
 */

export const SUPERADMIN_FLAG_GROUPS = [
  "operations",
  "intelligence",
  "customers",
  "analytics",
  "business",
  "limits",
] as const;
export type SuperAdminFlagGroup = (typeof SUPERADMIN_FLAG_GROUPS)[number];

export type SuperAdminFlagPhase = "live" | "phase_2" | "phase_3";

export type SuperAdminFlagDescriptor = {
  key: string;
  group: SuperAdminFlagGroup;
  /** Vietnamese-first label per the spec; the SuperAdmin panel is
   * Huy-only so it doesn't need full i18n. */
  label: string;
  description: string;
  phase: SuperAdminFlagPhase;
  /** Danger flags require an extra confirm before flipping. */
  danger?: boolean;
};

export const SUPERADMIN_PER_SALON_FLAGS: ReadonlyArray<SuperAdminFlagDescriptor> = [
  // ── Group A: Operations ──────────────────────────────────────────
  {
    key: "walkin_queue_enabled",
    group: "operations",
    label: "Hàng chờ walk-in",
    description: "Bật panel walk-in queue trên Front Desk.",
    phase: "live",
  },
  {
    key: "walkin_auto_assign",
    group: "operations",
    label: "Tự động gán thợ rảnh",
    description: "Khách walk-in được gán thẳng khi có thợ rảnh.",
    phase: "live",
  },
  {
    key: "receptionist_center_enabled",
    group: "operations",
    label: "Màn hình Lễ Tân",
    description: "Bật trang /center cho lễ tân.",
    phase: "live",
  },
  {
    key: "rush_hour_mode_enabled",
    group: "operations",
    label: "Chế độ giờ cao điểm",
    description: "Auto-detect rush hour và làm mờ điều khiển phụ.",
    phase: "live",
  },
  {
    key: "soft_hold_enabled",
    group: "operations",
    label: "Giữ chỗ tạm (10 phút)",
    description: "Cho phép giữ chỗ khi khách bước ra ngoài.",
    phase: "live",
  },
  {
    key: "density_mode_enabled",
    group: "operations",
    label: "Chuyển đổi Simple/Balanced/Pro",
    description: "Cho phép owner đổi mật độ giao diện.",
    phase: "live",
  },

  // ── Group B: Intelligence ────────────────────────────────────────
  {
    key: "smart_assignment_enabled",
    group: "intelligence",
    label: "Gợi ý Best Match tự động",
    description: "Bật engine gợi ý thợ phù hợp khi thêm walk-in.",
    phase: "live",
  },
  {
    key: "availability_engine_enabled",
    group: "intelligence",
    label: "Tính realtime rảnh/bận",
    description: "Bật availability engine cho dispatch + form.",
    phase: "live",
  },
  {
    key: "nail_tryon_enabled",
    group: "intelligence",
    label: "Thử mẫu nail bằng AI",
    description: "Bật trải nghiệm scan bàn tay và xem trước mẫu nail cho salon pilot.",
    phase: "phase_3",
  },
  {
    key: "staff_request_tracking",
    group: "intelligence",
    label: "Theo dõi yêu cầu thợ ❤️",
    description: "Hiển thị heart icon khi khách yêu cầu thợ cụ thể.",
    phase: "live",
  },

  // ── Group C: Customers ───────────────────────────────────────────
  {
    key: "customer_wait_page_enabled",
    group: "customers",
    label: "Trang chờ khách /wait/",
    description: "Bật trang công khai theo dõi vị trí cho khách.",
    phase: "live",
  },
  {
    key: "phone_autolookup_enabled",
    group: "customers",
    label: "Tự điền thông tin từ số phone",
    description: "Tra cứu khách quen khi nhập số điện thoại.",
    phase: "live",
  },
  {
    key: "client_profiles_enabled",
    group: "customers",
    label: "Trang hồ sơ khách hàng",
    description: "Bật trang /clients quản lý hồ sơ khách.",
    phase: "live",
  },
  {
    key: "vip_flag_enabled",
    group: "customers",
    label: "Badge VIP khách",
    description: "Hiển thị badge gold cho VIP customers.",
    phase: "live",
  },
  {
    key: "repeat_customer_badge",
    group: "customers",
    label: "Badge khách quen",
    description: "Hiển thị badge khi khách đã từng ghé.",
    phase: "live",
  },

  // ── Group D: Analytics ───────────────────────────────────────────
  {
    key: "reports_enabled",
    group: "analytics",
    label: "Trang Báo cáo & Doanh thu",
    description: "Bật trang /insights cho owner.",
    phase: "live",
  },
  {
    key: "audit_log_enabled",
    group: "analytics",
    label: "Nhật ký thao tác",
    description: "Hiển thị audit log viewer trong settings.",
    phase: "live",
  },
  {
    key: "operational_metrics",
    group: "analytics",
    label: "Thu thập metrics nền",
    description: "Log queue_joined / queue_assigned / rush events.",
    phase: "live",
  },
  {
    key: "client_health_score",
    group: "analytics",
    label: "Điểm sức khỏe khách",
    description: "Tính điểm health cho khách (Phase 2).",
    phase: "phase_2",
  },
  {
    key: "smart_retention_alerts",
    group: "analytics",
    label: "Cảnh báo khách sắp rời",
    description: "Cảnh báo khi khách quen ngừng ghé (Phase 2).",
    phase: "phase_2",
  },
  {
    key: "churn_detection",
    group: "analytics",
    label: "Dự đoán churn AI",
    description: "AI dự đoán khách sắp churn (Phase 3).",
    phase: "phase_3",
  },

  // ── Group E: Business ────────────────────────────────────────────
  {
    key: "loyalty_enabled",
    group: "business",
    label: "Chương trình tích điểm",
    description: "Bật loyalty / điểm thưởng.",
    phase: "live",
  },
  {
    key: "group_booking_enabled",
    group: "business",
    label: "Đặt lịch theo nhóm",
    description: "Cho phép đặt 2+ khách cùng lịch.",
    phase: "live",
  },
  {
    key: "multi_location_enabled",
    group: "business",
    label: "Quản lý nhiều tiệm",
    description: "Bật multi-salon switcher cho owner.",
    phase: "live",
  },
  {
    key: "booking_pause_enabled",
    group: "business",
    label: "Tạm dừng nhận booking",
    description: "Owner có thể tạm dừng nhận đặt lịch.",
    phase: "live",
  },
  {
    key: "referral_qr_enabled",
    group: "business",
    label: "QR giới thiệu khách",
    description: "QR code mời bạn bè (Phase 3).",
    phase: "phase_3",
  },
  {
    key: "sms_campaigns_enabled",
    group: "business",
    label: "SMS marketing",
    description: "Gửi SMS hàng loạt (Phase 3).",
    phase: "phase_3",
  },
  {
    key: "qr_checkin_enabled",
    group: "business",
    label: "Tự check-in bằng QR",
    description: "Khách quét QR để tự check-in (Phase 3).",
    phase: "phase_3",
  },

  // ── Group F: Limits ──────────────────────────────────────────────
  {
    key: "stripe_subscription_enabled",
    group: "limits",
    label: "Thu phí Stripe tiệm này",
    description: "Bật Stripe subscription cho salon cụ thể.",
    phase: "live",
  },
  {
    key: "unlimited_staff",
    group: "limits",
    label: "Không giới hạn nhân viên",
    description: "Vượt cap free-plan 3 nhân viên.",
    phase: "live",
  },
  {
    key: "unlimited_services",
    group: "limits",
    label: "Không giới hạn dịch vụ",
    description: "Vượt cap free-plan 10 dịch vụ.",
    phase: "live",
  },
];

/**
 * Frozen string-literal union of all per-salon flag keys for type
 * safety at the boundary. Generated from the descriptor list above so
 * adding a flag is a one-place edit.
 */
export const SUPERADMIN_FEATURE_FLAG_KEYS =
  SUPERADMIN_PER_SALON_FLAGS.map((d) => d.key) as ReadonlyArray<string>;

export type SuperAdminFeatureFlagKey = string;

export type SuperAdminFeatureFlags = Record<string, boolean>;

export type SuperAdminSalonRow = {
  id: string;
  slug: string;
  name: string;
  /** Owner phone (E.164 digits or empty). UI masks before render. */
  phone: string;
  subscription_plan: string | null;
  plan_override: SuperAdminPlanOverride;
  feature_flags: SuperAdminFeatureFlags;
  is_beta: boolean;
  admin_notes: string | null;
  created_at: string | null;
  /** Voice AI feature gate — toggled per-salon by SuperAdmin. */
  voice_ai_enabled: boolean;
  /** Bookings whose `start_time_utc` falls in the current calendar
   * month (UTC). Excludes status='cancelled' since those represent
   * voided traffic, not real demand. */
  bookings_this_month: number;
};

export type LoadAllSalonsResult =
  | { ok: true; salons: SuperAdminSalonRow[] }
  | {
      ok: false;
      error: "unauthorized" | "server_error";
    };

export type SuperAdminUserMembership = {
  salonId: string;
  salonName: string;
  salonSlug: string;
  role: string;
};

export type SuperAdminUserRow = {
  id: string;
  email: string;
  createdAt: string | null;
  lastSignInAt: string | null;
  memberships: SuperAdminUserMembership[];
};

export type LoadAllUsersResult =
  | { ok: true; users: SuperAdminUserRow[] }
  | { ok: false; error: "unauthorized" | "server_error" };

/**
 * Per-salon detail surface for `/superadmin/salons/[salonId]`.
 *
 * Extends `SuperAdminSalonRow` with the fields a support operator
 * actually needs when triaging a single tenant: configuration
 * (timezone, currency, brand color, theme), recent-activity
 * aggregates, and a counts grid. Computed inline in the loader so
 * the detail page does a single trip per render.
 */
export type SuperAdminSalonDetail = SuperAdminSalonRow & {
  timezone: string | null;
  currency_code: string | null;
  brand_color: string | null;
  theme_mode: "dark" | "light" | null;
  /** Active (non-soft-deleted) staff count. */
  staff_count: number;
  /** Active (non-soft-deleted) services count. */
  services_count: number;
  /** Bookings whose `start_time_utc` falls in the last 7 days,
   * excluding cancelled rows — a quick "are they actually using
   * this?" signal complementing `bookings_this_month`. */
  bookings_last_7d: number;
  /** Most-recent booking `created_at`, or null when the salon has
   * never had a booking. Powers the "last activity" line. */
  last_booking_created_at: string | null;
};

export type LoadSalonDetailResult =
  | { ok: true; salon: SuperAdminSalonDetail }
  | {
      ok: false;
      error: "unauthorized" | "not_found" | "server_error";
    };

export type UpdateSalonFlagsInput = {
  planOverride?: SuperAdminPlanOverride;
  featureFlags?: SuperAdminFeatureFlags;
  /**
   * Keys to REMOVE from `salons.feature_flags` (not set to null/false). Used by
   * the release-features panel's "reset to default" — deleting the key makes
   * the resolver fall back to the registry default. The action whitelists these
   * against the editable release jsonb keys, so an unset can never strip an
   * unrelated flag. Removal runs after the `featureFlags` merge.
   */
  featureFlagsUnset?: string[];
  isBeta?: boolean;
  adminNotes?: string | null;
  voiceAiEnabled?: boolean;
};

export type UpdateSalonFlagsResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "invalid_payload"
        | "not_found"
        | "server_error";
    };

/** Tables exposed to SuperAdmin restore. Bookings + salons are
 * intentionally excluded for now — bookings have no soft-delete write
 * path yet, and salon archive needs its own separate flow. */
export const RESTORABLE_TABLES = [
  "services",
  "staff",
  "client_profiles",
] as const;
export type RestorableTable = (typeof RESTORABLE_TABLES)[number];

export type DeletedRecord = {
  id: string;
  table: RestorableTable;
  /** Human-readable label (service name / staff name / client phone). */
  label: string;
  deleted_at: string;
};

export type LoadDeletedRecordsResult =
  | { ok: true; records: DeletedRecord[] }
  | { ok: false; error: "unauthorized" | "server_error" };

export type RestoreSalonRecordResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "invalid_payload"
        | "not_found"
        | "server_error";
    };

export function isRestorableTable(value: unknown): value is RestorableTable {
  return (
    typeof value === "string" &&
    (RESTORABLE_TABLES as readonly string[]).includes(value)
  );
}

export function normalizeFeatureFlags(input: unknown): SuperAdminFeatureFlags {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: SuperAdminFeatureFlags = {};
  // Read every known key from the descriptor list. Unknown keys
  // present in the row are dropped silently — the SuperAdmin UI
  // is the only authoritative source for what a flag means, so
  // letting stale keys persist doesn't change behavior.
  for (const key of SUPERADMIN_FEATURE_FLAG_KEYS) {
    if (typeof src[key] === "boolean") {
      out[key] = src[key] as boolean;
    }
  }
  // Pass through any extra boolean keys we don't recognize so an
  // unknown-but-truthy flag isn't silently flipped off on save. The
  // jsonb column is freeform and clients may write keys ahead of the
  // SuperAdmin descriptor list catching up.
  for (const k of Object.keys(src)) {
    if (typeof src[k] === "boolean" && !(k in out)) {
      out[k] = src[k] as boolean;
    }
  }
  return out;
}

/* ───────────────────── Platform-wide flags (PR #108) ───────────────────── */

export const PLATFORM_FLAG_KEYS = [
  "demo_otp_enabled",
  "stripe_billing_enabled",
  "sms_enabled",
  "email_enabled",
  "new_salon_registration",
] as const;
export type PlatformFlagKey = (typeof PLATFORM_FLAG_KEYS)[number];

export type PlatformFlagBadge = "danger" | "billing" | "sms" | "email" | "registration";

export type PlatformFlagDescriptor = {
  key: PlatformFlagKey;
  label: string;
  description: string;
  badge: PlatformFlagBadge;
  /** When true, the toggle requires a confirm dialog before flipping. */
  danger?: boolean;
};

export const PLATFORM_FLAG_DESCRIPTORS: ReadonlyArray<PlatformFlagDescriptor> = [
  {
    key: "demo_otp_enabled",
    label: "Cho phép OTP demo (chỉ dùng khi test)",
    description: "DANGER — disable on production. Bypasses real OTP.",
    badge: "danger",
    danger: true,
  },
  {
    key: "stripe_billing_enabled",
    label: "Bật thu phí Stripe toàn hệ thống",
    description: "Enables Stripe checkout / subscription init.",
    badge: "billing",
  },
  {
    key: "sms_enabled",
    label: "Bật gửi SMS (Twilio)",
    description: "Enables SMS transport via Twilio.",
    badge: "sms",
  },
  {
    key: "email_enabled",
    label: "Bật gửi email (Resend)",
    description: "Enables transactional email via Resend.",
    badge: "email",
  },
  {
    key: "new_salon_registration",
    label: "Cho phép đăng ký tiệm mới",
    description: "Disable to freeze /register signup.",
    badge: "registration",
  },
];

export type PlatformFlag = {
  key: PlatformFlagKey;
  enabled: boolean;
  description: string | null;
  updated_at: string | null;
};

export type LoadPlatformFlagsResult =
  | { ok: true; flags: PlatformFlag[] }
  | { ok: false; error: "unauthorized" | "server_error" };

export type UpdatePlatformFlagResult =
  | { ok: true; key: PlatformFlagKey; enabled: boolean }
  | {
      ok: false;
      error: "unauthorized" | "invalid_payload" | "server_error";
    };

export function isPlatformFlagKey(value: unknown): value is PlatformFlagKey {
  return (
    typeof value === "string" &&
    (PLATFORM_FLAG_KEYS as readonly string[]).includes(value)
  );
}

export function normalizePlanOverride(input: unknown): SuperAdminPlanOverride {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  return (SUPPORTED_PLAN_OVERRIDES as readonly string[]).includes(trimmed)
    ? (trimmed as SuperAdminPlanOverride)
    : null;
}

/** Slug pattern enforced when SuperAdmin adds a new category — keeps
 *  the value URL-safe and recognisable on the wire. */
export const SUPERADMIN_CATEGORY_SLUG_RE = /^[a-z][a-z0-9_]{1,39}$/;

export type SuperAdminCategoryRow = {
  slug: string;
  nameEn: string;
  nameVi: string;
  sortOrder: number;
  deletedAt: string | null;
};

export type LoadAllCategoriesResult =
  | { ok: true; rows: SuperAdminCategoryRow[] }
  | { ok: false; error: string };

export type AddCategoryInput = {
  slug: string;
  nameEn: string;
  nameVi: string;
  /** Defaults to 50 server-side if omitted, so a brand-new entry
   *  lands above "other" (sort_order 99) without crowding the seeded
   *  list. SuperAdmin can adjust on update. */
  sortOrder?: number;
};

export type UpdateCategoryInput = {
  slug: string;
  nameEn?: string;
  nameVi?: string;
  sortOrder?: number;
};

export type CategoryMutationResult = { ok: true } | { ok: false; error: string };

/* ───────────────── SuperAdmin audit-log viewer (Phase 1F) ───────────────── */

/**
 * Known action verbs the viewer renders with explicit labels + color
 * coding. Unknown verbs (e.g. shipped in future code before this list
 * is updated) still render — just in mono font without a colour
 * accent. Keep this list in sync with the writers in
 * `src/shared/superadmin/*.ts`.
 */
export const KNOWN_AUDIT_ACTIONS = [
  "impersonate_enter",
  "impersonate_exit",
  "impersonate_expire",
  "salon_flags_set",
  "record_restore",
  "platform_flag_set",
  "category_add",
  "category_update",
  "category_delete",
] as const;
export type KnownAuditAction = (typeof KNOWN_AUDIT_ACTIONS)[number];

export type AuditLogFilters = {
  /** Filter by action verb(s). Empty = no filter. */
  actions?: readonly string[];
  /** Filter by a single actor user_id (uuid). */
  actorUserId?: string;
  /** Filter by target kind(s). Empty = no filter. */
  targetKinds?: readonly string[];
  /** ISO-8601 lower bound on `created_at` (inclusive). */
  from?: string;
  /** ISO-8601 upper bound on `created_at` (exclusive). */
  to?: string;
};

export type AuditLogRow = {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorRole: string;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  reason: string | null;
  beforeJsonb: Record<string, unknown> | null;
  afterJsonb: Record<string, unknown> | null;
};

export type LoadAuditLogsResult =
  | {
      ok: true;
      rows: AuditLogRow[];
      /** Opaque cursor for fetching the next page; null when end-of-list. */
      nextCursor: string | null;
      /** The cursor of the page *before* the current one; null on first page. */
      prevCursor: string | null;
    }
  | {
      ok: false;
      error: "unauthorized" | "forbidden" | "server_error";
    };
