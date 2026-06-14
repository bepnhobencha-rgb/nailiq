# SPEC — Salon client directory (membership + server-side search)

Branch: `feat/salon-clients-directory` · Surface: Dashboard → Clients (`/dashboard/[slug]/clients`)
Ngày: 2026-06-14

## 1. Mục tiêu
Trang Khách hàng phải hiển thị + **tìm được toàn bộ** khách của salon — gồm cả contact đã import (Hi-Lite: 9,476 từ Square) chứ không chỉ 394 khách có booking. Tuyệt đối **không lộ khách của tiệm này sang tiệm khác**, kể cả khi tiệm thứ 2 nối Square.

## 2. Bối cảnh (verify từ prod)
- `client_profiles` là bảng **global, phone-keyed** (1 SĐT dùng chung mọi salon). 10,943 dòng; 9,476 có `square_customer_id`.
- Chỉ **hilite-anaheim** nối Square → 9,476 đó là của Hi-Lite (hiện không nhập nhằng, nhưng SẼ nhập nhằng nếu salon khác nối Square → KHÔNG được scope bằng `square_customer_id`).
- Loader hiện (`loadClientProfilesAction`) lấy khách = **distinct phone từ bookings** của salon (Hi-Lite = 394); không có tìm server-side/phân trang.

## 3. Thiết kế — cô lập theo salon là cốt lõi

### 3.1 Bảng membership `salon_clients` (nguồn sự thật cho "khách của salon")
```
salon_clients(
  id uuid pk,
  salon_id uuid not null references salons(id) on delete cascade,
  client_profile_id uuid not null references client_profiles(id) on delete cascade,
  source text not null,            -- 'square_import' | 'manual' | 'booking' | ...
  external_ref text,               -- provenance (vd square_customer_id) — KHÔNG dùng để scope
  created_at timestamptz default now(),
  unique(salon_id, client_profile_id)
)
```
- **Scope tuyệt đối bằng `salon_id`** (không bao giờ bằng `square_customer_id`). Tiệm thứ 2 nối Square → import tạo dòng `salon_id = tiệm 2` → không chạm Hi-Lite.
- Index: `(salon_id)`, `(client_profile_id)`.

### 3.2 RLS / chống lộ (theo đúng bài học client_profiles PII leak)
- Bật RLS; **REVOKE anon + authenticated** mọi quyền trực tiếp.
- Mọi đọc đi qua **RPC SECURITY DEFINER** `search_salon_clients(p_salon_id, p_search, p_limit, p_offset)` — gọi bằng **service-role** TỪ loader, SAU khi loader đã `getDashboardWriteClient(slug)` xác thực role (owner/senior/admin/receptionist) + đúng salon. RPC chỉ trả khách của `p_salon_id`. REVOKE RPC khỏi anon/authenticated.
- Không endpoint anon nào chạm `salon_clients` hay trả PII.

### 3.3 Directory = bookings ∪ membership
- Khách của salon = `distinct booking phones` ∪ `salon_clients`. Salon chưa import → membership rỗng → directory = khách booking như cũ (KHÔNG hồi quy tiệm khác).
- De-dup theo **canonical phone** (đã có `toCanonicalPhone`); 1 người = 1 dòng dù trùng định dạng.

### 3.4 Tìm server-side + phân trang
- Loader nhận `{ search?, page, pageSize=25 }`. RPC: lọc `name ILIKE %q%` HOẶC phone canonical chứa q; sort (có booking gần đây lên trước, rồi tên); trả 1 trang + `total`.
- Visit/spend per-salon chỉ tính cho ~25 dòng của trang (rẻ); khách import chưa booking → 0 lượt ghé.
- UI `ClientProfilesPanel`: ô tìm (debounce) + nút phân trang (Trước/Sau + tổng), giữ nguyên thẩm mỹ bản redesign vừa merge (#456).

## 4. Backfill (1 lần, prod)
- Hi-Lite: insert `salon_clients(salon_id=Hi-Lite, client_profile_id, source='square_import', external_ref=square_customer_id)` cho 9,476 profile có `square_customer_id`. Idempotent (`on conflict do nothing`).
- Không đụng salon khác. Chạy qua `apply_migration` (DDL) + 1 backfill script có điều kiện `square_customer_id is not null` (an toàn vì chỉ Hi-Lite có).
- **Đường import Square tương lai**: cập nhật code import để ghi `salon_clients` (source='square_import', salon_id = salon đang nối) — để mô hình bền vững.

## 5. Failure modes & mitigations
| Failure | Mitigation |
|---|---|
| Lộ khách chéo tiệm | Scope cứng bằng `salon_id`; RLS revoke anon; RPC SECURITY DEFINER role-gated; không dùng square_customer_id để scope |
| Tiệm thứ 2 nối Square | Import ghi membership theo salon_id của tiệm 2 → cô lập |
| 9.5k load nặng browser | Tìm + phân trang server-side (pageSize 25) |
| SĐT trùng định dạng → khách đôi | De-dup canonical phone |
| Khách import không có booking | Hiện 0 lượt ghé (loader đã hỗ trợ trạng thái này) |
| Backfill chạy lại | `on conflict (salon_id, client_profile_id) do nothing` |

## 6. Ngoài phạm vi (đề xuất sau)
- Thêm/sửa/gộp khách thủ công trên UI (membership source='manual').
- Membership cho khách-booking của MỌI salon (giờ vẫn derive từ bookings — đủ dùng, không cần ghi).

## 7. Triển khai
1. Migration: `salon_clients` + RLS + grants + RPC `search_salon_clients` (test BEGIN…ROLLBACK trên prod-like).
2. Backfill Hi-Lite 9,476 (idempotent).
3. Loader `loadClientProfiles` → search/paginate qua RPC.
4. UI panel: ô tìm + phân trang.
5. Build + E2E (seed import-profile, assert tìm theo phone/tên ra, assert salon khác KHÔNG thấy) + preview → Huy duyệt → merge.
