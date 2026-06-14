# SPEC — Customer Identity Layer (NailIQ)

> Mục tiêu: chấm dứt tình trạng "thông tin khách lung tung" — cùng 1 người ra
> nhiều tên/nhiều bản ghi rời rạc; nhóm làm ô nhiễm danh tính người đặt. Áp dụng
> đồng nhất cho 3 luồng: **Online cá nhân · Online/Desk nhóm · Front Desk**.

## 1. Mục tiêu & người dùng
- **Người dùng cuối**: khách đặt online (cá nhân + nhóm), lễ tân tại quầy.
- **Vấn đề gốc (đã verify trong code, không phải giả định):**
  1. `bookings` nối khách **chỉ qua `client_phone` (text)**, không có FK ổn định.
  2. 🐛 **Group**: `BookingGroupFlow.tsx:814` + `DeskGroupForm.tsx` gán
     `phone = primaryPhone` cho **mọi** thành viên → mọi dòng booking của
     "Guest N" mang số của người đặt → phá vỡ phone-lookup + visit_count
     (bằng chứng prod: số 17788680738 = 112 booking, 1 profile "Alice" visit 31).
  3. **Online cá nhân**: tên tự do ghi vào booking mỗi lần; có nhận diện
     (`get_booking_client_snapshot`) nhưng chưa thành "trải nghiệm wow".
  4. **Front Desk**: có auto-fill theo SỐ (`lookupClientByPhone`) nhưng
     **không có typeahead theo TÊN** → lễ tân không biết khách đã có hồ sơ.

## 2. Hạ tầng đang có (TÁI DÙNG, không viết lại)
- `src/shared/lib/toCanonicalPhone.ts` + DB trigger `canonical_phone()` (6 bảng).
- RPC `get_booking_client_snapshot(p_phone)` — đọc snapshot 1 số (post PII lockdown PR #352).
- RPC insert: `create_public_booking(...)` (online cá nhân + desk),
  `insert_group_bookings(p_bookings jsonb)` (nhóm).
- `lookupClientByPhoneAction.ts` (desk auto-fill theo số),
  `loadClientProfilesAction.ts` + `ClientProfilesPanel.tsx` (trang Clients).
- `client_profiles`: GLOBAL, khóa `phone` UNIQUE, **không có `salon_id`** (cố ý).

## 3. Kiến trúc đề xuất — "1 nguồn sự thật" cho danh tính khách

### 3.1 Schema (migration)
```
ALTER TABLE bookings
  ADD COLUMN client_profile_id uuid REFERENCES client_profiles(id),
  ADD COLUMN is_party_member  boolean NOT NULL DEFAULT false;
CREATE INDEX bookings_client_profile_id_idx ON bookings(client_profile_id);
```
- `client_profile_id`: liên kết CỨNG, sống sót khi khách đổi số (phone vẫn là
  khóa nghiệp vụ, nhưng FK là danh tính bền). NULL hợp lệ cho party member
  không có số riêng.
- `is_party_member`: thành viên nhóm KHÔNG phải người đặt & không có số riêng →
  không tạo profile, không tính là visit của booker.

### 3.2 Resolver tập trung (SECURITY DEFINER, atomic — thay best-effort browser upsert)
RPC `resolve_client_profile(p_phone, p_name, p_email)` → trả `client_profiles.id`:
- canonicalize phone (trigger lo), upsert theo `onConflict=phone`.
- **KHÔNG ghi đè tên bằng placeholder** ("Guest N"/"Khách N") — giữ tên thật cũ.
- Cập nhật `visit_count`, `last_service_date` ngay trong RPC (hết cảnh upsert
  ở browser bị RLS chặn / best-effort).
- `create_public_booking` & `insert_group_bookings` gọi resolver → stamp
  `client_profile_id` vào booking trong cùng transaction.

### 3.3 Hành vi từng luồng
| Luồng | Thay đổi |
|---|---|
| **Online cá nhân** | Resolve profile theo số → stamp FK. UI: nhập số → "Chào lại, Alice 👋 (lần cuối …)" → autofill, không đẻ tên mới. |
| **Nhóm** | ⛔ Bỏ gán `phone=primaryPhone` cho member. Mỗi member có ô số RIÊNG (optional). Có số → profile + FK riêng. Không số → `is_party_member=true`, phone NULL, tên chỉ ở booking, KHÔNG tính visit booker. Party-link claim sau này gắn FK thật. |
| **Front Desk** | Thêm typeahead TÌM THEO TÊN/SỐ (RPC `search_clients`) → chọn hồ sơ sẵn (badge visit/VIP/last-visit) thay vì gõ lại; "Tạo khách mới" chỉ khi thật mới. Giữ auto-fill theo số. |

### 3.4 Merge / dedupe (dọn mớ cũ)
- Trang/section "Gộp khách trùng": liệt kê cặp nghi trùng (cùng email, tên fuzzy,
  số gần giống) → owner duyệt → `merge_client_profiles(keep_id, drop_id)`:
  repoint `bookings.client_profile_id`, cộng dồn visit/spend/no_show, soft-delete bản thừa.
- AI (tick ở §5) chấm điểm độ giống để xếp hạng gợi ý — chỉ gợi ý, người duyệt.

### 3.5 Backfill (an toàn, có rollback)
- `UPDATE bookings SET client_profile_id = cp.id FROM client_profiles cp
   WHERE bookings.client_phone = cp.phone` (theo lô, idempotent).
- Đánh dấu `is_party_member=true` cho dòng nhóm không phải booker
  (group_id NOT NULL & phone == booker phone & không phải dòng đầu).
- Test trên schema prod-like bằng `BEGIN … ROLLBACK` trước khi apply.

## 4. Failure modes & mitigations
| Failure mode | Mitigation |
|---|---|
| Migration khóa bảng `bookings` lớn → downtime | ADD COLUMN nullable (không rewrite), index `CONCURRENTLY`, backfill theo lô |
| RPC mới phá luồng booking đang chạy (revenue) | Giữ chữ ký cũ tương thích, thêm cột mới optional; deploy preview + smoke 3 luồng trước merge |
| Party member vẫn lọt số booker | Bỏ field ở payload builder + guard trong RPC: member non-booker bỏ qua phone của booker |
| Merge sai người | Chỉ owner, luôn review, soft-delete (khôi phục được), không hard-delete |
| visit_count nhảy sai khi backfill | Backfill chỉ set FK, KHÔNG đụng visit_count; visit vẫn tính từ bookings lúc đọc |
| RLS: anon đọc client_profiles để search | Search qua RPC SECURITY DEFINER giới hạn theo salon, không mở SELECT |

## 5. AI/LLM leverage (cần Huy tick [x])
- [ ] Fuzzy merge scoring — Haiku chấm "2 hồ sơ có phải 1 người?" (~$0.0002/cặp), chỉ gợi ý.
- [ ] Chuẩn hoá tên hiển thị ("alice"/"ALICE"/"Alice T." → "Alice") khi resolve (~$0.0001/lần).

## 6. Tool automation (tự dùng)
- Supabase MCP (migration test BEGIN…ROLLBACK trên prod-like), `git`/`gh` (PR draft),
  Vercel preview share-link cho Huy duyệt trước khi merge.

## 7. Tech stack
Chuẩn NailIQ hiện hữu (Next.js + Supabase RPC SECURITY DEFINER + service-role server actions). Không thêm dependency.

## 8. Module breakdown & thứ tự build
1. **M1 — Schema**: cột `client_profile_id` + `is_party_member` + index (nullable, an toàn).
2. **M2 — Resolver RPC** `resolve_client_profile` + sửa `create_public_booking` & `insert_group_bookings` stamp FK (atomic, thay browser upsert).
3. **M3 — Group fix** (ROI cao nhất): bỏ phone-share ở `BookingGroupFlow.tsx` + `DeskGroupForm.tsx`; thêm ô số/member; `is_party_member`.
4. **M4 — Front Desk picker**: RPC `search_clients` + typeahead trong `DeskBookingForm`.
5. **M5 — Online recognition wow**: card "Chào lại …" (tái dùng snapshot RPC).
6. **M6 — Merge tool**: RPC `merge_client_profiles` + UI owner + (AI scoring nếu tick).
7. **M7 — Backfill**: script lô + đánh dấu party member + verify.

Mỗi module: migration test ROLLBACK → code → smoke 3 luồng → commit. Deploy preview, Huy duyệt trước khi merge prod.

## 9. Deploy target
Prod NailIQ (Supabase `fshmobzyjhmtvndobwsy`, www.nailiq.ca). Gate: preview smoke pass + Huy OK.
