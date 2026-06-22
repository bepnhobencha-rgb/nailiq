# SPEC — Promotion Engine (NailIQ)

## 1. Mục tiêu
Cho phép owner/admin tạo chương trình khuyến mãi theo thời gian cho từng dịch vụ:
- Giá cố định: Hi Lite Royal $105 → $90 trong 2-3 tháng
- % off: giảm 20% thứ 3-4 (Happy Hour)
- $ off: giảm $15 cho dịch vụ cụ thể
- Tự động apply — khách không cần nhập code

---

## 2. Schema mới: `promotions` + `promotion_services`

```sql
-- Campaign header
CREATE TABLE promotions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id        uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name            text NOT NULL,                          -- "Summer Special"
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  -- Schedule (optional, NULL = all day / all week)
  days_of_week    int[],    -- [0..6] Sun=0; NULL = every day
  time_start      time,     -- Happy Hour từ 10:00
  time_end        time,     -- Happy Hour đến 12:00
  -- Fallback discount (khi service không có rule riêng)
  discount_type   text NOT NULL CHECK (discount_type IN ('fixed_price','percent','amount')),
  discount_value  int  NOT NULL,  -- cents (fixed_price/amount) hoặc % * 100
  applies_to      text NOT NULL DEFAULT 'specific' CHECK (applies_to IN ('all','specific')),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

-- Per-service rule trong campaign
CREATE TABLE promotion_services (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id    uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  service_id      uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  -- Override discount riêng cho service này (NULL = dùng campaign-level)
  discount_type   text CHECK (discount_type IN ('fixed_price','percent','amount')),
  discount_value  int,
  UNIQUE (promotion_id, service_id)
);

-- Indexes
CREATE INDEX ON promotions(salon_id, starts_at, ends_at) WHERE active = true;
CREATE INDEX ON promotion_services(promotion_id);
CREATE INDEX ON promotion_services(service_id);
```

---

## 3. Logic apply promo (server-side)

```typescript
// Lấy promotion active tại thời điểm booking
async function resolvePromoPrice(
  salonId: string,
  serviceId: string,
  basePriceCents: number,
  bookingTimeUtc: Date,
): Promise<{ promoPriceCents: number; promoId: string | null; promoName: string | null }>

// Ưu tiên: promotion_services.discount > promotion.discount
// Chỉ apply 1 promo (cao nhất)
```

Apply tại 3 điểm:
- `loadBookingServices.ts` — hiện giá promo trên booking page
- `submitPublicBooking.ts` — lock promo price vào booking
- `receptionistActions.ts` (addWalkinToQueue / createDeskBooking) — desk cũng auto-apply

---

## 4. Booking table changes

```sql
ALTER TABLE bookings
  ADD COLUMN promo_id uuid REFERENCES promotions(id),
  ADD COLUMN original_price_cents int;  -- giá gốc trước khi giảm
```

---

## 5. Admin UI — `/dashboard/[slug]/setup/promotions`

### Danh sách campaigns
- Card mỗi campaign: tên / ngày / badge "Active · Upcoming · Expired"
- Nút "+ Tạo campaign"

### Form tạo/sửa campaign
```
Tên campaign:     [ Summer Special 2025        ]
Thời gian:        [ 01/06/2025 ] → [ 31/08/2025]
Giảm giá:         ● Giá cố định  ○ % off  ○ $ off

Dịch vụ áp dụng:
  ┌─────────────────────────────────────────┐
  │ ☑ Hi Lite Classic   $85  →  [ $75  ]   │
  │ ☑ Hi Lite Deluxe   $105  →  [ $90  ]   │
  │ ☑ Hi Lite Royal    $125  →  [ $105 ]   │
  │ ☐ Hi Lite VVIP     $145  →  [      ]   │
  └─────────────────────────────────────────┘

Schedule (tuỳ chọn):
  Ngày trong tuần: [Tất cả ▼]  hoặc chọn: M T W T F S S
  Khung giờ:       [ Cả ngày ] hoặc [ 10:00 ] → [ 12:00 ]

[ Lưu campaign ]  [ Huỷ ]
```

---

## 6. Booking page — hiển thị promo

```
Hi Lite Royal
~~$125~~  $90  🏷️ Summer Special
```

- Giá gốc gạch ngang
- Giá promo màu nổi (salon primary color)
- Badge tên campaign
- Không cần code, tự apply

---

## 7. Xác nhận booking — breakdown giá

```
Hi Lite Royal               ~~$125~~
Summer Special discount        –$35
─────────────────────────────────────
Tổng                           $90
```

---

## 8. Module breakdown & thứ tự build

| # | Module | Phụ thuộc |
|---|---|---|
| M1 | Migration: promotions + promotion_services tables | — |
| M2 | Server action: createPromotion / updatePromotion / deletePromotion | M1 |
| M3 | resolvePromoPrice() helper | M1 |
| M4 | Apply promo trong loadBookingServices (public booking page) | M3 |
| M5 | Apply promo trong submitPublicBooking | M3 |
| M6 | Apply promo trong receptionistActions (desk) | M3 |
| M7 | Admin UI — /setup/promotions (list + form) | M2 |
| M8 | BookingFlowServicePanel — hiện ~~giá gốc~~ giá promo | M4 |
| M9 | BookingFlowConfirmPanel — breakdown discount dòng | M5 |
| M10 | Desk UI — hiện promo badge khi tạo booking | M6 |

Estimate: **~8-10 ngày**. M1-M6 (backend) build song song với M7 (admin UI).

---

## 9. Module 11 — Email Capture Incentive ($2 off)

### Logic
- Booking step "Contact Info": thêm optional email field
- Nudge UI: `"📧 Nhập email → nhận $2 off ngay lần này"`
- Server-side khi submit: nếu email được cung cấp **VÀ** `client_profiles.email_discount_claimed_at IS NULL` → apply -$200 cents
- Sau khi claim: set `email_discount_claimed_at = NOW()` → không claim được lần 2

### Schema change
```sql
ALTER TABLE client_profiles
  ADD COLUMN email_discount_claimed_at timestamptz;
```

### Abuse prevention
- 1 phone number = 1 lần (field trên profile, không phải per-email)
- Email không bắt buộc unique (người ta có thể nhập email giả) — phone là anchor
- Minimum price floor: nếu service chỉ $5, không giảm dưới $0

### Stack với campaign promo?
**Có** — email incentive stack được với campaign:
- Hi Lite Royal $105, Summer Special -$15 → $90, email -$2 → **$88**
- `original_price_cents = 10500`, `promo_discount = 1500`, `email_discount = 200`, `final = 8800`

### UI khi confirm booking
```
Hi Lite Royal                   $105
Summer Special                  -$15
Email welcome discount          -$2
──────────────────────────────────
Tổng                            $88
```

---

## 10. Ngoài scope lần này (đề xuất sau)
- [ ] Birthday Magic (auto-voucher gửi email)
- [ ] Referral loop
- [ ] Flash Deal AI (gợi ý slot trống)
- [ ] Groupon-lite (public deal page)
- [ ] Promo code (customer nhập tay) — voucher system đã có nền
