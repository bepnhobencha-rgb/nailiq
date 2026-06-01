# Base Release — Customer Onboarding Checklist

> **Mục đích:** Quy trình go-live để đưa một tiệm nail thật lên NailIQ ở phiên bản
> **Base** (customer-ready). Dùng cho từng tiệm mới khi onboard.
>
> **Phạm vi:** Chỉ các surface thuộc **Base** (default ON). Mọi thứ **Beta** giữ OFF
> trừ khi SuperAdmin bật thủ công cho tiệm đó.
>
> **Nguồn chân lý feature:** [`docs/FEATURE_FLAGS.md`](./FEATURE_FLAGS.md) →
> registry `src/shared/features/featureRegistry.ts`.
>
> **Trạng thái:** First draft — chờ duyệt. Chưa commit.

---

## 0. Quy ước

- ✅ = đã xong và verify tận mắt, không chỉ "đã nhập".
- Mỗi tiệm = 1 bản copy checklist này (in ra hoặc copy vào ticket onboarding).
- Slug tiệm (vd `liam-nails`) đặt 1 lần, không đổi sau go-live (ảnh hưởng URL công khai + QR).

---

## 1. Salon setup checklist

Nhập tại **Settings hub** (`/dashboard/[slug]/settings`) + **Setup**
(`/dashboard/[slug]/setup`). Không hardcode — tất cả qua admin UI.

| # | Mục | Nơi nhập | Done |
| --- | --- | --- | --- |
| 1 | **Tên tiệm** (salon name) — hiển thị brand + SEO | Settings | ☐ |
| 2 | **Logo** — upload (qua image pipeline: resize/auto-orient) | Settings | ☐ |
| 3 | **Địa chỉ** (address) — đầy đủ, dùng cho JSON-LD + bản đồ | Setup → Address | ☐ |
| 4 | **Số điện thoại** (phone) — số tiệm thật | Settings | ☐ |
| 5 | **Giờ làm việc** (business hours) — từng ngày trong tuần, có ngày nghỉ | Setup → Hours | ☐ |
| 6 | **Timezone** — đúng múi giờ tiệm (vd America/Vancouver) | Settings | ☐ |
| 7 | **Danh sách thợ** (staff list) — đủ tên thợ đang làm | Setup → Staff | ☐ |
| 8 | **Dịch vụ** (services) — catalog đầy đủ | Setup → Services | ☐ |
| 9 | **Giá** (prices) — đúng giá thật từng dịch vụ | Setup → Services | ☐ |
| 10 | **Thời lượng** (durations) — phút/dịch vụ, ảnh hưởng slot booking | Setup → Services | ☐ |
| 11 | **Chính sách đặt lịch** (booking policy) — buffer, lead time, hủy/no-show | Settings | ☐ |
| 12 | **Ngôn ngữ EN/VI** — toggle hoạt động, nội dung 2 ngôn ngữ đủ | Settings | ☐ |
| 13 | **Tài khoản chủ tiệm** (owner account) — email thật, login được, role OWNER | Setup → Staff / Auth | ☐ |
| 14 | **Tài khoản lễ tân** (receptionist account) — login được, role RECEPTIONIST | Setup → Staff / Auth | ☐ |

**Sanity check sau khi nhập:**
- ☐ Mở trang công khai `/[slug]` — logo, tên, giờ, dịch vụ, giá hiển thị đúng.
- ☐ Mỗi thợ có ít nhất 1 dịch vụ làm được (nếu hệ thống map thợ↔dịch vụ).
- ☐ Owner và receptionist mỗi người login thử 1 lần OK, thấy đúng quyền.

---

## 2. Base features — phải ON

Đây là default ON của registry (Base). Verify từng surface mở được & hoạt động.

| Feature | Surface / Route | Verify | Done |
| --- | --- | --- | --- |
| **Public booking** | `/[slug]` | Khách đặt được 1 lịch test | ☐ |
| **Receptionist center** | `/dashboard/[slug]/center` | Thấy timeline + booking hôm nay | ☐ |
| **Walk-in queue** | Panel trong Center | Thêm 1 walk-in test | ☐ |
| **Calendar / booking list** | Center / calendar views | Lịch hiển thị đúng ngày/giờ | ☐ |
| **Customers** | `/dashboard/[slug]/clients` | Khách vừa book xuất hiện | ☐ |
| **Staff** | `/dashboard/[slug]/setup/staff` | Danh sách thợ + role đúng | ☐ |
| **Services** | `/dashboard/[slug]/setup/services` | Dịch vụ + giá + duration đúng | ☐ |
| **Settings** | `/dashboard/[slug]/settings` | Mọi mục mục 1 lưu được | ☐ |

---

## 3. Features giữ OFF / Beta

Mặc định OFF cho mọi tiệm Base. **Không bật** trừ khi có yêu cầu rõ + SuperAdmin
bật thủ công tại `/superadmin/salons/[salonId]`.

| Feature | Trạng thái | Ghi chú |
| --- | --- | --- |
| **AI voice** (Lily) | OFF / Beta | Cột `salons.voice_ai_enabled` |
| **Group / party booking** | OFF / Beta | `feature_flags.group_booking_enabled` |
| **Loyalty / rewards** | OFF / Beta | `feature_flags.loyalty_enabled` |
| **Reviews** (auto review-request) | OFF / Beta | plan feature `reviews` |
| **Marketing / SMS** | OFF / Beta | registry default |
| **Combos / bundles** | OFF / Beta | registry default |
| **TV mode** (waiting-room display) | OFF / Beta | chưa implement |
| **Advanced reports** | OFF / Beta | `feature_flags.reports_enabled` |

**Verify gating:**
- ☐ Khi đăng nhập tiệm Base, các module trên **không** xuất hiện trên nav.
- ☐ Truy cập thẳng route Beta (vd voice) → bị chặn/redirect, không lộ UI.

---

## 4. Manual QA trước launch

Chạy tay trên tiệm thật (hoặc bản staging của tiệm) trước khi bật go-live.

| # | Test case | Kỳ vọng | Done |
| --- | --- | --- | --- |
| 1 | Khách đặt lịch online tại `/[slug]` | Booking tạo thành công, có màn success | ☐ |
| 2 | Lễ tân mở Center | Thấy ngay booking khách vừa đặt (realtime/refresh) | ☐ |
| 3 | Thêm 1 walk-in trong queue | Walk-in hiện, gán được cho thợ rảnh | ☐ |
| 4 | Staff + Service hiển thị công khai | Đúng tên thợ, đúng dịch vụ/giá ở trang khách | ☐ |
| 5 | Feature flags ẩn module Beta | Voice/group/loyalty… không thấy ở tiệm Base | ☐ |
| 6 | Public booking trên mobile | Layout không vỡ, đặt được lịch trên điện thoại | ☐ |
| 7 | Toggle EN/VI | Nội dung đổi ngôn ngữ đúng, không vỡ chữ | ☐ |
| 8 | Owner vs Receptionist quyền | Mỗi role chỉ thấy đúng phần được phép | ☐ |

> Sau QA: xóa booking/walk-in test, hoặc dùng tiệm staging riêng để dữ liệu thật sạch.

---

## 5. Demo script cho chủ tiệm (10 phút)

> Mục tiêu: chủ tiệm tự tay thử ≥1 tính năng và thấy nó tiết kiệm thời gian.
> Chỉ demo **Base** — không demo Beta để tránh hứa thứ chưa bật.
> (Bản đầy đủ 20–25 phút: [`DEMO_SCRIPT.md`](../DEMO_SCRIPT.md).)

**Phút 0–1 — Hỏi trước, đừng pitch**
- "Anh/chị đang quản lý lịch hẹn bằng gì? Sổ tay, Zalo, hay app?"
- "Khách walk-in và khách hẹn trước xử lý ra sao? Có hay quên/double-book không?"

**Phút 1–4 — Trang booking của khách** (`/[slug]` trên điện thoại)
- "Khách mở trang này tự đặt, không cần gọi điện."
- Chọn dịch vụ → thợ → ngày → giờ → nhập tên + SĐT → Xác nhận → màn success.
- Mẹo: "In QR dán quầy, khách quét là vào thẳng."

**Phút 4–7 — Bảng receptionist** (`/dashboard/[slug]/center` trên laptop)
- "Đây là front desk: thấy ngay hôm nay ai đang làm, ai sắp tới."
- Click 1 booking → drawer → Check in / Complete / Cancel.
- Walk-in: **+ Walk-in** → nhập tên → chọn dịch vụ → gán thợ rảnh. "2 giây, khỏi ghi sổ."

**Phút 7–9 — Quản lý cơ bản**
- Services: "Đổi giá, thêm dịch vụ ngay đây."
- Staff: "Thêm/ẩn thợ, đổi giờ làm."
- Settings: "Logo, giờ mở cửa, ngôn ngữ EN/VI — anh/chị tự sửa."

**Phút 9–10 — Chốt**
- "Hôm nay mình mới bật những phần cốt lõi này. Voice AI, nhóm khách, loyalty… để sau khi tiệm quen đã."
- Hỏi: "Phần nào anh/chị thấy đỡ nhất?" → ghi lại để follow up.

---

## 6. Go-live approval checklist

Ký duyệt trước khi công bố URL công khai cho tiệm.

- ☐ Mục 1 (Salon setup) — tất cả 14 mục ✅, đã sanity check tận mắt.
- ☐ Mục 2 (Base features) — 8 surface verify hoạt động.
- ☐ Mục 3 (Beta) — xác nhận tất cả OFF, gating ẩn đúng (nav + route trực tiếp).
- ☐ Mục 4 (Manual QA) — 8 test case pass, dữ liệu test đã dọn.
- ☐ Mục 5 (Demo) — đã demo cho chủ tiệm, chủ tiệm OK đi tiếp.
- ☐ Owner + Receptionist đã đăng nhập được bằng tài khoản thật.
- ☐ Timezone + business hours khớp tiệm thật (kiểm tra lại slot booking đúng giờ).
- ☐ SEO/public page kiểm tra nhanh: title, logo, địa chỉ, JSON-LD không lỗi.
- ☐ URL công khai `/[slug]` mở từ máy ngoài (không login) hoạt động.
- ☐ Có người chịu trách nhiệm support tuần đầu (tên + cách liên hệ).

**Approval**

| Vai trò | Tên | Ngày | Ký/OK |
| --- | --- | --- | --- |
| Người onboard | | | ☐ |
| Chủ tiệm (owner) | | | ☐ |
| Go-live cuối (Huy) | | | ☐ |

---

*First draft — feedback rồi mới commit. Không push/merge.*
