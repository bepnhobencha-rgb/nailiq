# Data Processing Agreement (DPA) — TEMPLATE

> ⚠️ **DRAFT TEMPLATE — NOT LEGAL ADVICE.** This is a starting point for a lawyer
> to review and finalize for British Columbia (Canada) + California (US). Do not
> rely on it as-is. Fill every **[bracketed]** item.

This DPA is between **[NailIQ legal entity / operator name]** ("Processor",
"NailIQ") and the **salon/business** that uses NailIQ ("Controller", "Salon").
It supplements the NailIQ Terms of Service.

## 1. Roles
- The **Salon is the data controller** of its clients' personal information.
- **NailIQ is the data processor**, acting on the Salon's instructions to provide
  the booking/operations service.
- For payments (deposits, no-show card-on-file), the **Salon is the merchant of
  record**; the payment processor (Square/Stripe) is an independent controller of
  card data.

## 2. Scope of processing
- **Categories of data:** client name, phone, email, appointment details,
  no-show/deposit consent records, card brand + last4 + payment token (never the
  full PAN), staff/service data.
- **Purpose:** providing bookings, reminders, the receptionist center, no-show
  protection, deposits, and related communications — only as instructed.
- **Duration:** for the term of the subscription; deletion per §6.

## 3. Sub-processors
NailIQ uses: **Supabase** (database/storage, US/CA region), **Vercel** (hosting,
US), **Twilio** (SMS), **Resend** (email), **Square/Stripe** (payments),
**Anthropic** (AI features, where enabled). NailIQ
will give notice of new sub-processors and remains responsible for their
compliance.

## 4. International transfer
Data may be stored/processed in the **United States**. The parties acknowledge
the cross-border transfer; NailIQ applies reasonable safeguards (encryption in
transit + at rest, access controls, RLS).

## 5. Security
NailIQ maintains: TLS in transit, encryption at rest, row-level security
isolating each salon's data, least-privilege access, and audit logging. Card
data is tokenized by the processor (PCI scope minimized; NailIQ does not store
PANs).

## 6. Data subject rights & deletion
NailIQ assists the Salon in responding to access/deletion/correction requests
(PIPEDA, BC PIPA, CCPA/CPRA). On termination or request, salon data is deleted
within **[30] days**, except where retention is legally required.

## 7. Breach notification
NailIQ will notify the Salon **without undue delay (target: [72] hours)** after
becoming aware of a personal-data breach, with the information needed for the
Salon to meet its own notification duties.

## 8. Controller obligations (Salon)
The Salon represents that it has the **lawful basis and consent** to collect its
clients' data and to send them SMS/email (CASL/TCPA), and that its cancellation/
no-show/deposit policy is disclosed to and agreed by its clients.

## 9. Liability / governing law
Per the NailIQ Terms of Service. Governing law: **[British Columbia, Canada]**
(confirm cross-border enforceability with counsel for US salons).

---
**Signatures:** Salon **[name/date]** · NailIQ **[name/date]**
