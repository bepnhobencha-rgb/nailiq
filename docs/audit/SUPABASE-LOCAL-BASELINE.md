# NailIQ — Baseline schema cho Supabase local

**Ngày:** 2026-07-14 · **Nguồn:** production `fshmobzyjhmtvndobwsy` (NailIQOS) · **Commit tương ứng:** `c16e275`

> **Cập nhật 2026-07-23:** lịch sử cũ đã được lưu nguyên vẹn tại
> `supabase/migration-history/legacy-2026-07-23/`. `supabase/migrations/` nay
> chứa 266 marker khớp ledger production và một folded baseline có thể dựng
> database trắng. Tài liệu bằng chứng/cutover hiện hành là
> `docs/audit/MIGRATION-HISTORY-RECONCILIATION-2026-07-23.md`.
> Production và repo hiện ở strict 267/267 parity.
> `scripts/db-push-guard.js` đã được thay bằng `scripts/db-push-safe.mjs`;
> mặc định chỉ dry-run và mọi apply thật vẫn approval-gated.

---

## Baseline này KHÔNG phải migration history của production

Nói rõ để không ai nhầm sau này:

- Nó **chỉ** dùng để dựng database **test/local**.
- Nó **không** thay thế, không xoá, không đụng tới **262 migration** hiện có.
- Nó **không** được apply lên production.
- `supabase/migrations/` vẫn là lịch sử (dù đã drift) của production.

---

## Vì sao cần baseline — migration không dựng lại được database

```
262 file migration trong supabase/migrations/ — nhưng:
  ❌ salons    — KHÔNG có CREATE TABLE ở bất kỳ đâu
  ❌ bookings  — KHÔNG có CREATE TABLE
  ❌ staff     — KHÔNG có CREATE TABLE
  ❌ services  — KHÔNG có CREATE TABLE
```

Các bảng cốt lõi được tạo **bằng tay** trên project live từ lâu; migration chỉ `ALTER` chúng. `supabase db push` lên một database trống **chết ngay ở file đầu tiên**. Chính `scripts/db-push-guard.js` đã chặn lệnh này từ trước, với đúng lý do đó:

> *"The remote migration tracking table is out of sync with local migration files."*

---

## Cách tạo baseline (1 lệnh — chỉ Huy chạy được)

Cần **mật khẩu Postgres**, thứ chỉ có trong Supabase Dashboard. CI **không có** và **không được có**.

```bash
cd ~/nailiq
mkdir -p supabase/bootstrap

pg_dump \
  --schema-only \
  --no-owner \
  --no-privileges \
  --schema=public \
  --schema=auth \
  "postgresql://postgres:<MAT_KHAU>@db.fshmobzyjhmtvndobwsy.supabase.co:5432/postgres" \
  > supabase/bootstrap/schema.sql
```

`--schema-only` **không phải tuỳ chọn** — nó là toàn bộ tính chất an toàn. Production có **11.226 khách hàng thật** và **4.787 booking thật**; repo này **PUBLIC**.

---

## Cách xác minh schema-only (bắt buộc, trước khi commit)

```bash
npx tsx scripts/verify-schema-dump.ts
```

Script **fail** nếu thấy:
- `COPY … FROM stdin` (dữ liệu hàng loạt)
- `INSERT INTO` (từng hàng)
- Giá trị **có hình dạng credential thật**: JWT, `sk_live_`, `sk-ant-`, `whsec_`, `re_`, `EAAA`, `IST.`, `AC`+32hex, PEM private key, connection-string có mật khẩu

### Vì sao KHÔNG grep thô — và allowlist gồm những gì

Cách hiển nhiên là grep `password`, `email`, `phone`, `secret`, `token`, `service_role`, `client_profiles`. **Mọi từ đó đều xuất hiện hàng chục lần trong một dump ĐÚNG**, vì chúng là **định danh**:

```sql
encrypted_password  character varying(255)   -- tên CỘT
twilio_auth_token   text                     -- tên CỘT
resend_api_key      text                     -- tên CỘT
CREATE TABLE public.client_profiles (...)    -- tên BẢNG
GRANT ALL ON ... TO service_role;            -- GRANT bắt buộc
CREATE POLICY ... USING (auth.uid() = ...)   -- POLICY bắt buộc
```

Một checker báo động ở **mọi lần chạy sạch** là checker mà người ta **học cách bỏ qua** — và checker bị bỏ qua **tệ hơn không có**, vì nó bán niềm tin giả. Câu hỏi đúng không bao giờ là *"từ đó có xuất hiện không"* mà là **"ở đây có GIÁ TRỊ không"**.

`pg_dump` chỉ phát ra giá trị theo **3 hình dạng**, nên đó là thứ ta tìm:
1. `COPY … FROM stdin` — định dạng dữ liệu hàng loạt (đây chính là thứ `--schema-only` bỏ đi)
2. `INSERT INTO …` — định dạng từng hàng
3. Một literal trong `DEFAULT` / `CHECK` / thân function **chính nó LÀ** secret (ai đó hardcode key vào schema từ lâu)

(1) và (2) là **cấu trúc, không mơ hồ**. (3) bắt bằng **hình dạng** credential, **không** bằng từ tiếng Anh.

**20 unit test** khoá cả hai chiều (`src/shared/lib/__tests__/verifySchemaDump.spec.ts`): dump sạch có `encrypted_password` / `service_role` / `client_profiles` **phải pass**; dump có COPY/INSERT/JWT/Stripe-key/PEM **phải fail**. Có cả test rằng nó **không in giá trị secret ra log** khi tố cáo secret — vì output này rơi vào CI log.

---

## Cách cập nhật baseline sau này

Khi schema production đổi (thêm bảng/policy/function):
1. Chạy lại `pg_dump` ở trên.
2. Chạy lại `npx tsx scripts/verify-schema-dump.ts`.
3. Cập nhật số liệu `PRODUCTION` trong `scripts/check-schema-parity.ts`.
4. Commit.

CI sẽ tự bắt nếu baseline thiếu: `check-schema-parity.ts` so số bảng/cột/policy/function/trigger/index với production và **fail nếu hụt >10%**, đồng thời kiểm **RLS có được bật** trên các bảng lõi hay không — vì một database có bảng mà **không có policy** sẽ khiến test tenant-isolation **xanh giả**.

---

## Schema production (đo 2026-07-14)

| Đối tượng | Số lượng |
|---|---|
| Bảng (`public`) | **81** |
| Cột | **1.064** |
| RLS policy | **101** |
| Function | **253** |
| Trigger | **24** |
| Index | **265** |
| Extension | **8** |

---

## Kế hoạch xử lý 262 migration (đã hoàn tất 2026-07-23)

Kế hoạch lịch sử đã được thực hiện theo phương án folded baseline:

1. Dùng `supabase/bootstrap/schema.sql` (đã có, đã verify) làm baseline.
2. Chuyển 262 file cũ sang `supabase/migrations/_archive/` — **giữ lại**, không xoá.
3. Đặt baseline thành migration đầu tiên (`00000000000000_baseline.sql`).
4. `supabase migration repair` trên **project test**, **không** trên production.
5. Chỉ khi test xanh mới cân nhắc đồng bộ bảng `schema_migrations` của production.
6. Thay guard cũ bằng wrapper bắt buộc deploy-ready audit + dry-run trước apply.

**Không** rewrite Git history. **Không** sửa `schema_migrations` của production trong bước 1–4.

---

## ✅ ĐÃ CHỨNG MINH (2026-07-14)

Baseline này **đã dựng lại được database từ số 0** — cả trên Postgres 17 trắng lẫn trên Supabase Local trong CI.

| Đo trên chính CI | Kết quả |
|---|---|
| Bảng | **81 / 81** |
| Cột | **1.064 / 1.064** |
| RLS policy | **101 / 101** |
| Function (app, không tính extension) | **65 / 65** |
| Trigger | **24 / 24** |
| Index | **265 / 265** |
| GRANT: `anon` | **75 / 75 bảng** |
| GRANT: `authenticated` | **75 / 75 bảng** |
| GRANT: `service_role` | **81 / 81 bảng** |
| RLS bật trên mọi bảng lõi | ✅ |

**6 bảng `anon` KHÔNG được đọc** — `client_ai_summaries`, `otp_send_log`, `payment_disputes`, `rate_limits`, `salon_clients`, `scheduled_notifications` — được tái tạo **chính xác**. Khoảng trống đó **chính là lớp bảo vệ PII**, và nó sống sót nguyên vẹn sang database test.

### File trong `supabase/bootstrap/`
| File | Vai trò |
|---|---|
| `schema.sql` | `pg_dump --schema-only` của `public`. **KHÔNG BAO GIỜ sửa tay** — sửa là nó thôi khớp production, trong im lặng |
| `prelude.sql` | Tạo thứ dump **giả định đã có**: role, extension, và (chỉ khi vắng) `auth.uid()` + `auth.users` stub |
| `reference-data.sql` | 13 danh mục dịch vụ + 5 platform flag. **Không PII.** `services.category` có FK vào đây |

Apply bằng **một script duy nhất** dùng chung cho CI và máy: `scripts/apply-baseline.sh` — nên hai bên **không thể lệch nhau**.

Kết quả chạy đầy đủ: [`E2E-FIRST-FULL-RUN.md`](./E2E-FIRST-FULL-RUN.md)
