# E2E Test Database — thiết lập

E2E hiện **bị skip** trong CI. Đây là chủ ý: nó từng chạy thẳng vào **Supabase production** và để lại 5 tài khoản superadmin cùng một loạt salon fixture nằm cạnh dữ liệu khách thật (xem `docs/audit/E2E-PRODUCTION-CONTAINMENT.md`). Tài liệu này là những gì cần làm để bật lại E2E một cách an toàn.

---

## 0. Cái chặn thật — và nó KHÔNG phải biến môi trường

Workflow đã wire sẵn 4 biến. Điền vào là xong… **nếu** có một database để trỏ tới. Vấn đề nằm ở chỗ đó.

**Thư mục migration KHÔNG dựng lại được schema.**

```
262 file migration — nhưng:
  ❌ salons    — KHÔNG có CREATE TABLE ở bất kỳ đâu
  ❌ bookings  — KHÔNG có CREATE TABLE
  ❌ staff     — KHÔNG có CREATE TABLE
  ❌ services  — KHÔNG có CREATE TABLE
```

Các migration chỉ `ALTER` những bảng **chưa từng được tạo** trong repo. `supabase db push` lên một project trống sẽ chết ngay ở file đầu tiên. Chính `scripts/db-push-guard.js` đã chặn lệnh này từ trước, với đúng lý do đó:

> *"The remote migration tracking table is out of sync with local migration files."*

**Kết luận:** phải lấy schema từ **production**, dưới dạng **schema-only dump** (cấu trúc, **KHÔNG dữ liệu**).

### Quy mô schema cần tái tạo
| | |
|---|---|
| Bảng (`public`) | **81** |
| Cột | **1.064** |
| RLS policy | **101** |
| Function / RPC | **253** |
| Trigger | **24** |
| Index | **265** |
| Extension | **8** |

> Đây là lý do **không** dựng lại schema bằng tay từ `pg_catalog`: sai một RLS policy là test **xanh giả**, và đó còn tệ hơn không có test.

---

## 1. Hai phương án — chọn 1

| | **A. Supabase test project (hosted)** | **B. Supabase local trong CI (Docker)** |
|---|---|---|
| **Chi phí** | **$10/tháng** (org `HUY ARCHITECT`, gói Pro) | **$0** |
| **Cách ly** | Một DB dùng chung giữa các lần chạy CI | **DB mới tinh mỗi lần chạy** |
| **Rác sót lại** | Có thể — cần `sweep` dọn | **Không thể** — container bị xoá sau mỗi run |
| **Tốc độ CI** | Nhanh (DB có sẵn) | Chậm hơn ~1–2 phút (boot Docker) |
| **Chạy local được?** | Cần mạng | Có, offline |
| **Vẫn cần schema dump?** | **Có** | **Có** |

**Em nghiêng về B.** Sự cố vừa rồi xảy ra vì E2E **ghi vào một DB tồn tại lâu dài**. Với B, mỗi lần chạy CI có DB riêng và **bị huỷ ngay sau đó** — rác *không thể* tích tụ, kể cả khi job bị cancel giữa chừng (đúng cái đã gây ra sự cố). Và nó **miễn phí**.

Nhược điểm của B: CI chậm hơn ~1–2 phút, và cần **squash 262 migration thành 1 baseline** để `supabase db reset` chạy được — nhưng **việc squash đó phải làm dù chọn phương án nào**, vì cả hai đều cần schema dump.

> ⚠️ **Em chưa tạo project nào.** Tạo project mới **tốn $10/tháng** → cần anh duyệt trước.

---

## 2. Bước anh phải tự làm (em không làm được)

Em **không có mật khẩu Postgres** của production (`.env.local` chỉ có Supabase URL + các key, không có `DATABASE_URL`), nên **không dump schema được**. Anh lấy được trong 2 phút.

### 2.1 Lấy connection string
Supabase Dashboard → project **NailIQOS** (`fshmobzyjhmtvndobwsy`) → **Settings → Database → Connection string → URI**.

### 2.2 Dump schema — **CHỈ CẤU TRÚC, KHÔNG DỮ LIỆU**

`pg_dump` đã có sẵn trên máy anh.

```bash
cd ~/nailiq

pg_dump \
  --schema-only \          # ⬅ BẮT BUỘC: chỉ cấu trúc. KHÔNG có --data-only, KHÔNG có dữ liệu khách.
  --no-owner \
  --no-privileges \
  --schema=public \
  --schema=auth \
  "postgresql://postgres:<MAT_KHAU>@db.fshmobzyjhmtvndobwsy.supabase.co:5432/postgres" \
  > supabase/bootstrap/schema.sql
```

**Kiểm tra trước khi commit** — file này sẽ nằm trong repo **PUBLIC**:

```bash
# Phải trả về 0. Nếu > 0 là có dữ liệu lọt vào -> DỪNG, đừng commit.
grep -c "^COPY \|^INSERT INTO " supabase/bootstrap/schema.sql
```

> 🔒 `--schema-only` đảm bảo **không một dòng dữ liệu khách nào** bị copy. **Tuyệt đối không** dump dữ liệu sang test — 11.226 khách hàng thật và 4.787 booking thật phải ở nguyên production.

### 2.3 Nếu chọn phương án A — tạo test project
Supabase Dashboard → **New project** trong org `HUY ARCHITECT` → tên `nailiq-e2e` → **cùng region với prod** (`us-east-1`) → **$10/tháng**.

Rồi nạp schema:
```bash
psql "postgresql://postgres:<MAT_KHAU_TEST>@db.<TEST_REF>.supabase.co:5432/postgres" \
  -f supabase/bootstrap/schema.sql
```

### 2.4 Đặt secret cho CI
GitHub → repo → **Settings → Secrets and variables → Actions**

| Loại | Tên | Lấy ở đâu |
|---|---|---|
| Secret | `TEST_SUPABASE_URL` | Test project → Settings → API → Project URL |
| Secret | `TEST_SUPABASE_ANON_KEY` | Test project → Settings → API → `anon` key |
| Secret | `TEST_SUPABASE_SERVICE_ROLE_KEY` | Test project → Settings → API → `service_role` key |
| **Variable** | `TEST_SUPABASE_PROJECT_REF` | Ref của test project (20 ký tự, ví dụ `abcdefghijklmnopqrst`) |

> `TEST_SUPABASE_PROJECT_REF` là **variable**, không phải secret — guard dùng nó để **ghim** đúng project. Có service-role key mà **không** ghim ref → workflow **fail cứng** (chủ ý).

### 2.5 Xác minh
```bash
NEXT_PUBLIC_SUPABASE_URL=https://<TEST_REF>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<TEST_SERVICE_ROLE_KEY> \
  npx tsx scripts/verify-test-db.ts
```

Script này kiểm 3 thứ, **theo đúng thứ tự quan trọng**:
1. Đây có **thật sự không phải production** không (guard từ chối nếu là prod)
2. Có **đủ schema** E2E cần không
3. Có **sạch dữ liệu khách thật** không — nếu thấy >50 hàng trong `client_profiles` / `bookings` / `salons` thì báo lỗi ngay: *đó là dữ liệu production bị copy sang*, và nó không bao giờ được phép tồn tại ở đây.

---

## 3. Sau khi xong

Guard đã có sẵn (`e2e/helpers/guardProduction.ts`) và sẽ:
- **Chặn** nếu URL trỏ vào project ref production (`fshmobzyjhmtvndobwsy`)
- **Chặn** nếu host là `nailiq.ca`
- **Chặn** nếu ref không khớp `E2E_EXPECTED_PROJECT_REF`
- **Fail-closed**: cầm service-role key mà không nhận diện được project → **từ chối chạy**, không đoán

Sweep (`scripts/e2e-sweep.ts`) chạy ở step `if: always()`, **sống sót cả khi job bị cancel** — đúng cái đã hỏng lần trước.

**Không cần thêm secret production nào vào CI. Không bao giờ.**

---

## 4. Việc còn lại (đề xuất, chưa làm)

**Squash 262 migration thành 1 baseline.** Sau khi có `supabase/bootstrap/schema.sql`, nên:
- chuyển 262 file cũ vào `supabase/migrations/_archive/`
- đặt baseline thành migration đầu tiên
- gỡ `scripts/db-push-guard.js`

Khi đó `supabase db reset` / `db push` mới hoạt động trở lại, và **phương án B (Supabase local trong CI, $0)** mới khả thi. Đây là việc riêng, cần anh duyệt — nó đụng vào toàn bộ lịch sử migration.
