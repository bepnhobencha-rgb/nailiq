# Nail Try-On MVP — Product and Technical Specification

**Status:** Draft for implementation  
**Owner:** NailIQ  
**Release:** Beta, opt-in per salon  
**Target:** Mobile web first; desktop review supported  
**Last updated:** 2026-07-20

## 1. Problem

Customers often arrive with a reference design that does not fit their nail
length, shape, skin tone, service duration, or the salon's catalog. NailIQ needs
to let a customer photograph one hand, preview a salon design on the visible
nails, and carry the selected look into booking without claiming that the AI
render is an exact physical result.

## 2. MVP outcome

A customer can:

1. open Try-On from a salon's public booking experience;
2. take or upload one clear dorsal-hand image containing five visible nails;
3. receive an immediate quality verdict and retake guidance;
4. choose a salon-owned design or a simple color;
5. request a 2D preview that preserves the hand, skin, jewelry, pose, and
   background while changing only the nail surfaces;
6. compare original and preview;
7. attach the chosen design and preview to a booking draft;
8. delete the session and its images.

The release is successful when a pilot customer can finish this path on a
current mobile browser without staff assistance.

## 3. Non-goals

- live AR or video tracking;
- medical analysis of hands, skin, or nails;
- guaranteed color matching under salon lighting;
- automatic nail sizing for press-ons;
- changing nail length or shape in the first release;
- public social sharing;
- training a custom model on customer images;
- permanent customer biometric profiles.

## 4. Product principles

- **Honest preview:** label every result “AI preview — actual result may vary.”
- **One primary action per step:** capture → choose → generate → book.
- **Fast failure:** reject unusable images before an AI generation is billed.
- **Customer control:** delete is always visible; consent is explicit.
- **No silent mutation:** generation, failure, expiry, attachment, and deletion
  have explicit states.
- **Salon catalog first:** a preview should lead to a service the salon can sell.

## 5. User flow

### Step A — consent

- Explain that the hand image is processed to create an AI preview.
- Explain retention and deletion.
- Require an affirmative checkbox before camera/upload.
- Do not bundle marketing or public-gallery consent.

### Step B — capture

- Prefer the rear camera on mobile; allow file upload fallback.
- Show a static framing guide: one hand, palm down, fingers separated, nails
  fully visible, neutral light, no motion blur.
- Accept JPEG, PNG, or WebP.
- Client guard: maximum 10 MB and 20 megapixels before upload.
- Normalize orientation and downscale to the pipeline input budget.

### Step C — quality gate

Return a structured verdict:

- `pass`
- `retake_blurry`
- `retake_dark`
- `retake_occluded`
- `retake_wrong_pose`
- `retake_not_one_hand`
- `retake_nails_not_visible`

The gate must not diagnose a medical condition. A failed image is not sent to
the image-editing model.

### Step D — choose a look

- Salon catalog designs appear first.
- A design includes preview image, name, palette, style tags, linked service,
  optional add-on, price hint, and duration hint.
- Simple solid colors are allowed as built-in presets.
- MVP applies one design family across all five visible nails; per-finger
  editing is deferred.

### Step E — generate

- Generation is asynchronous and idempotent.
- Only the private original and selected catalog design are model inputs.
- Prompt contract: edit nail plates only; preserve identity-independent hand
  appearance, skin, pose, jewelry, lighting, and background; do not add fingers;
  do not change hand anatomy; do not add text or logos.
- Default production model: `gpt-image-2`; pin the dated snapshot after the
  evaluation set passes.
- One automatic retry is allowed only for a transient provider error, never for
  a rejected image or policy failure.

### Step F — review and book

- Side-by-side original/preview, with an obvious “Try another” action.
- “Book this look” attaches immutable design metadata to the booking draft.
- The booking carries design ID, design version, linked service/add-on, and
  private preview reference. It does not rely on a mutable catalog row alone.

## 6. Architecture

```text
Mobile browser
  -> signed upload request
  -> private Supabase Storage (original)
  -> server quality gate
  -> generation job (idempotency key)
  -> OpenAI image edit
  -> private Supabase Storage (preview)
  -> signed read URLs
  -> booking draft attachment
```

### Boundaries

- Browser never receives the Supabase service role key or OpenAI API key.
- Browser uploads only to a scoped signed URL/path.
- Server actions validate salon, feature flag, consent, MIME, decoded image
  dimensions, size, ownership token, session state, and rate limit.
- Provider calls run server-side only.
- Public booking users are not required to create a NailIQ account; possession
  of a high-entropy, HttpOnly session token identifies the try-on session.

## 7. Data model

### `nail_designs`

- `id uuid primary key`
- `salon_id uuid not null`
- `name text not null`
- `description text null`
- `source_image_path text not null`
- `service_id uuid null`
- `addon_service_id uuid null`
- `style_tags text[] not null default '{}'`
- `palette jsonb not null default '[]'`
- `version integer not null default 1`
- `is_active boolean not null default true`
- `created_by uuid not null`
- timestamps and soft-delete timestamp

### `nail_tryon_sessions`

- `id uuid primary key`
- `salon_id uuid not null`
- `public_token_hash text not null unique`
- `consent_at timestamptz not null`
- `consent_version text not null`
- `status text not null`
- `quality_code text null`
- `original_path text null`
- `preview_path text null`
- `design_id uuid null`
- `design_version integer null`
- `provider text null`
- `provider_model text null`
- `provider_request_id text null`
- `error_code text null`
- `expires_at timestamptz not null`
- `deleted_at timestamptz null`
- timestamps

Allowed states:

```text
created -> uploaded -> quality_passed -> generating -> ready -> attached
                   \-> rejected
                              generating -> failed
any non-deleted state -> deleted
any expired state -> expired
```

### Booking attachment

Use a dedicated `booking_nail_looks` table rather than expanding the booking
row with provider-specific fields. Store design/version and paths plus a compact
snapshot of name, palette, service, and disclaimer version.

## 8. Storage and privacy

- New private bucket: `nail-tryon`; never reuse public salon gallery storage.
- Paths are server-generated:
  `salon/{salon_id}/session/{session_id}/{original|preview}.{ext}`.
- No public URLs. Reads use short-lived signed URLs.
- Anonymous clients have no direct bucket policy. All access is mediated by
  server-side membership/session checks.
- Default retention: unattached sessions 24 hours; attached previews 30 days
  after the appointment unless the customer deletes sooner.
- Deletion removes objects first, then tombstones the database row. A scheduled
  retry handles partial deletion failures.
- Logs and analytics never contain image bytes, signed URLs, phone numbers, or
  public tokens.
- Customer images are not used for model training by NailIQ.

## 9. Security and abuse controls

- MIME allowlist plus magic-byte decoding; do not trust filename extensions.
- Strip EXIF metadata before provider upload/storage normalization.
- Pixel and byte limits protect image decoders.
- Per-IP, per-session, and per-salon generation limits.
- One active generation per session; database uniqueness/idempotency prevents
  double billing.
- Moderation/policy failures return a neutral customer message and are not
  automatically retried.
- Salon design mutations require authenticated membership and an allowed role.
- RLS enabled on every new public-schema table; owner/member and public-session
  access paths are separate.
- `SECURITY DEFINER` is not used to bypass missing RLS policies.

## 10. Reliability and cost controls

- Queue generation work so a web request is not held open for model latency.
- Record stable error codes, latency, model, and estimated cost per generation.
- Circuit breaker disables generation while keeping catalog browsing/booking
  available.
- Provider abstraction permits a fallback without changing stored data.
- Cache only exact idempotent retries, never reuse a preview across customers.

## 11. Metrics

Funnel events contain IDs and outcomes, not images:

- try-on opened;
- consent accepted;
- capture uploaded;
- quality passed/failed by code;
- design selected;
- generation requested/ready/failed;
- preview attached;
- booking completed with try-on;
- session deleted/expired.

Pilot targets:

- >= 70% quality pass within two capture attempts;
- >= 95% generation success excluding policy/customer-input rejection;
- p50 generation <= 15 seconds and p95 <= 35 seconds;
- zero cross-salon or cross-session image access;
- measurable booking conversion, reported separately from ordinary booking.

## 12. Acceptance criteria

- Feature is OFF by default and can be enabled per salon.
- Unsupported verticals and disabled salons cannot access the route or actions.
- Camera permission denial has a usable upload fallback.
- Invalid, oversized, malformed, or mislabeled files are rejected server-side.
- A failed quality gate cannot incur an image-generation call.
- Refresh/resubmit cannot create duplicate provider jobs.
- Original and preview remain private and inaccessible across sessions/salons.
- Customer can delete both files and the UI confirms completion.
- Preview is visibly labeled as AI-generated and non-guaranteed.
- Booking records the exact selected design version and linked service.
- EN and VI copy have parity.
- Unit, integration, RLS, E2E, accessibility, and mobile viewport tests pass.

## 13. Delivery plan

1. **PR0 — approved specification:** this document, risk register, evaluation
   contract, and implementation slices. No runtime behavior.
2. **PR1 — secure foundation:** Beta feature flag, schema, RLS, private bucket,
   retention job, generated types, and database tests. No customer UI.
3. **PR2 — catalog:** salon design CRUD, membership/role checks, signed images,
   service linkage, and owner UI.
4. **PR3 — capture:** public session token, consent, camera/upload fallback,
   normalization, quality gate, and mobile E2E.
5. **PR4 — generation:** provider adapter, idempotent job, `gpt-image-2` edit,
   retry/circuit breaker, observability, and golden-image evals.
6. **PR5 — booking integration:** compare, attach look, service/add-on mapping,
   deletion, expiry, EN/VI, accessibility, and full funnel E2E.
7. **Pilot:** one internal salon, then 3–5 salons, with cost and quality review
   before changing the default.

## 14. Release gates

- privacy/threat-model review complete;
- RLS and signed URL isolation tests green;
- 50-image evaluation set reviewed by a human against preservation criteria;
- cost ceiling configured per salon;
- deletion and expiry verified against Storage and database;
- support runbook and rollback switch documented;
- no automatic rollout beyond explicitly enabled pilot salons.

## 15. Open decisions before PR1

- Final consent and retention wording for Canada-first deployment.
- Roles allowed to publish salon designs.
- Pilot salon generation quota and plan entitlement.
- Whether previews attached to completed bookings should retain for 30 or 90
  days; default recommendation is 30.

## 16. Verified platform decision

The current OpenAI model catalog identifies GPT Image 2 as the default,
state-of-the-art image generation/editing model. It accepts image input and
returns image output through the image-edit endpoint. NailIQ will keep this
behind a provider adapter and pin a dated snapshot only after evaluation, rather
than scattering a model name through UI or database logic.

