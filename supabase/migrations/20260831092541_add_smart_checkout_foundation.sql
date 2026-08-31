-- Phase 2 foundation only. This migration records device identity and checkout
-- truth but never calls Square/Stripe and never enables payment dispatch.

CREATE TABLE public.smart_checkout_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('square', 'stripe')),
  device_type text NOT NULL CHECK (device_type IN (
    'square_terminal', 'stripe_terminal', 'tap_to_pay'
  )),
  provider_device_id text NOT NULL CHECK (
    length(trim(provider_device_id)) BETWEEN 1 AND 255
  ),
  provider_location_id text CHECK (
    provider_location_id IS NULL
      OR length(trim(provider_location_id)) BETWEEN 1 AND 255
  ),
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'pending_pairing' CHECK (status IN (
    'pending_pairing', 'ready', 'offline', 'disabled', 'unknown'
  )),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(capabilities) = 'object'
  ),
  is_default boolean NOT NULL DEFAULT false,
  paired_at timestamptz,
  last_seen_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smart_checkout_devices_provider_type_check CHECK (
    (provider = 'square' AND device_type = 'square_terminal')
    OR (provider = 'stripe' AND device_type IN ('stripe_terminal', 'tap_to_pay'))
  ),
  CONSTRAINT smart_checkout_devices_status_time_check CHECK (
    (status = 'disabled') = (disabled_at IS NOT NULL)
  ),
  UNIQUE (salon_id, provider, provider_device_id),
  UNIQUE (id, salon_id, provider)
);

CREATE UNIQUE INDEX smart_checkout_devices_one_default
  ON public.smart_checkout_devices (salon_id, provider)
  WHERE is_default AND disabled_at IS NULL;

CREATE INDEX smart_checkout_devices_salon_status
  ON public.smart_checkout_devices (salon_id, provider, status, updated_at DESC);

ALTER TABLE public.smart_checkout_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_checkout_devices FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.smart_checkout_devices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.smart_checkout_devices TO service_role;

-- Composite key makes the booking tenant part of the foreign-key boundary.
-- The index is redundant with the booking PK for lookup, but prevents a
-- service-layer bug from attaching another salon's booking to a checkout.
CREATE UNIQUE INDEX bookings_id_salon_for_smart_checkout
  ON public.bookings (id, salon_id);

CREATE TABLE public.smart_checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL,
  request_id uuid NOT NULL,
  cart_version bigint NOT NULL DEFAULT 1 CHECK (cart_version > 0),
  provider text NOT NULL CHECK (provider IN ('square', 'stripe')),
  provider_account_fingerprint text NOT NULL CHECK (
    provider_account_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  provider_location_id text CHECK (
    provider_location_id IS NULL
      OR length(trim(provider_location_id)) BETWEEN 1 AND 255
  ),
  device_id uuid,
  tender_type text NOT NULL CHECK (tender_type IN (
    'terminal', 'tap_to_pay', 'payment_link', 'card_on_file'
  )),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  tip_cents integer NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  deposit_credit_cents integer NOT NULL DEFAULT 0 CHECK (deposit_credit_cents >= 0),
  amount_due_cents integer NOT NULL CHECK (amount_due_cents >= 0),
  collected_cents integer NOT NULL DEFAULT 0 CHECK (collected_cents >= 0),
  refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  material_fingerprint text NOT NULL CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_idempotency_key text NOT NULL CHECK (
    length(trim(provider_idempotency_key)) BETWEEN 1 AND 255
  ),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'ready_for_review', 'awaiting_customer', 'pending_provider',
    'outcome_unknown', 'partially_paid', 'paid', 'failed', 'cancelled'
  )),
  provider_checkout_id text,
  provider_payment_id text,
  provider_status text,
  failure_disposition text CHECK (
    failure_disposition IS NULL
      OR failure_disposition IN ('definite_pre_acceptance', 'terminal', 'ambiguous')
  ),
  error_code text CHECK (
    error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'
  ),
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  provider_requested_at timestamptz,
  next_reconcile_at timestamptz,
  completed_at timestamptz,
  result_json jsonb CHECK (result_json IS NULL OR jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smart_checkout_sessions_amount_check CHECK (
    discount_cents <= subtotal_cents
    AND deposit_credit_cents <= subtotal_cents - discount_cents + tax_cents
    AND amount_due_cents =
      subtotal_cents - discount_cents + tax_cents + tip_cents - deposit_credit_cents
    AND refunded_cents <= collected_cents
    AND collected_cents <= amount_due_cents
  ),
  CONSTRAINT smart_checkout_sessions_approval_check CHECK (
    (approved_by IS NULL AND approved_at IS NULL)
      OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT smart_checkout_sessions_dispatch_check CHECK (
    provider_requested_at IS NULL OR (
      approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND status IN (
        'awaiting_customer', 'pending_provider', 'outcome_unknown',
        'partially_paid', 'paid', 'failed', 'cancelled'
      )
    )
  ),
  CONSTRAINT smart_checkout_sessions_device_check CHECK (
    (tender_type IN ('terminal', 'tap_to_pay')) = (device_id IS NOT NULL)
  ),
  CONSTRAINT smart_checkout_sessions_device_tenant_fkey FOREIGN KEY (
    device_id, salon_id, provider
  ) REFERENCES public.smart_checkout_devices (id, salon_id, provider)
    ON DELETE RESTRICT,
  CONSTRAINT smart_checkout_sessions_booking_tenant_fkey FOREIGN KEY (
    booking_id, salon_id
  ) REFERENCES public.bookings (id, salon_id)
    ON DELETE RESTRICT,
  CONSTRAINT smart_checkout_sessions_paid_check CHECK (
    status <> 'paid' OR (
      collected_cents = amount_due_cents
      AND amount_due_cents > 0
      AND completed_at IS NOT NULL
      AND provider_payment_id IS NOT NULL
      AND result_json IS NOT NULL
    )
  ),
  CONSTRAINT smart_checkout_sessions_provider_ids_check CHECK (
    (provider_checkout_id IS NULL OR length(trim(provider_checkout_id)) BETWEEN 1 AND 255)
    AND (provider_payment_id IS NULL OR length(trim(provider_payment_id)) BETWEEN 1 AND 255)
  ),
  UNIQUE (salon_id, request_id),
  UNIQUE (id, salon_id),
  UNIQUE (provider_idempotency_key)
);

CREATE UNIQUE INDEX smart_checkout_sessions_provider_checkout_once
  ON public.smart_checkout_sessions (
    provider, provider_account_fingerprint, provider_checkout_id
  )
  WHERE provider_checkout_id IS NOT NULL;

CREATE UNIQUE INDEX smart_checkout_sessions_provider_payment_once
  ON public.smart_checkout_sessions (
    provider, provider_account_fingerprint, provider_payment_id
  )
  WHERE provider_payment_id IS NOT NULL;

CREATE INDEX smart_checkout_sessions_booking_history
  ON public.smart_checkout_sessions (salon_id, booking_id, created_at DESC);

CREATE INDEX smart_checkout_sessions_reconcile_due
  ON public.smart_checkout_sessions (next_reconcile_at, created_at)
  WHERE status IN ('pending_provider', 'outcome_unknown');

ALTER TABLE public.smart_checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_checkout_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.smart_checkout_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.smart_checkout_sessions TO service_role;

CREATE TABLE public.smart_checkout_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 200),
  line_kind text NOT NULL CHECK (line_kind IN (
    'service', 'addon', 'discount', 'tax', 'tip', 'deposit_credit'
  )),
  source_id uuid,
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 200),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_amount_cents integer NOT NULL,
  total_amount_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smart_checkout_lines_total_check CHECK (
    total_amount_cents = quantity * unit_amount_cents
  ),
  CONSTRAINT smart_checkout_lines_session_tenant_fkey FOREIGN KEY (
    session_id, salon_id
  ) REFERENCES public.smart_checkout_sessions (id, salon_id)
    ON DELETE RESTRICT,
  UNIQUE (session_id, position)
);

CREATE INDEX smart_checkout_lines_session
  ON public.smart_checkout_lines (session_id, position);

ALTER TABLE public.smart_checkout_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_checkout_lines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.smart_checkout_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.smart_checkout_lines TO service_role;

COMMENT ON TABLE public.smart_checkout_devices IS
  'Service-only registry of paired Square/Stripe checkout devices. No access tokens or raw card data.';
COMMENT ON TABLE public.smart_checkout_sessions IS
  'Authoritative, approval-gated in-person checkout lifecycle. Paid requires an exact provider payment receipt; ambiguous outcomes remain reconcilable.';
COMMENT ON TABLE public.smart_checkout_lines IS
  'Immutable cart snapshot lines for a Smart Checkout session; amounts are server-owned and never trusted from browser totals.';
