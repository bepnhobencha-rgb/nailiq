# SPEC — Resource Layer (Phase 1)

> Universal, **optional**, **vertical-aware** scheduling resource dimension
> (stations / chairs / beds) for NailIQ. One engine, many faces. Salons that
> don't use it behave **exactly as today** — zero disruption.

## 1. Mục tiêu & người dùng

NailIQ hiện mô hình hoá lịch theo **1 chiều: `staff`** (mỗi thợ = 1 cột, chống
trùng theo `staff_id`). Thực tế cả 3 ngành đều có **chiều thứ 2 độc lập** — *"công
việc diễn ra Ở ĐÂU"*:

| Ngành | "Chỗ làm" | Vấn đề khi gộp vào staff |
|---|---|---|
| 💅 Nail | bàn mani / ghế pedi | oversell ghế pedi dùng chung |
| 💇 Tóc | ghế cắt / bồn gội | thợ rảnh lúc ủ thuốc nhưng ghế vẫn bận |
| 🧖 Spa | giường | thợ luân chuyển giữa các giường (Hi-Lite) |

**Phase 1** thêm chiều `resource` độc lập với `staff`, chống trùng **2 chiều**,
**tùy chọn theo tiệm** và **tương thích ngược tuyệt đối**.

**Người dùng:** chủ tiệm (khai báo resource), tiếp tân (xếp lịch theo giường/ghế),
khách (đặt online — chỉ thấy slot khi *cả thợ lẫn chỗ* trống).

**Ngoài phạm vi Phase 1 (để Phase 2):** "thợ chỉ bận MỘT PHẦN thời gian" (cú wow
nhuộm tóc song song); AI gap-fill cockpit; thiết bị có `capacity > 1`.

## 2. Tính năng cốt lõi (Phase 1 — đã thống nhất)

- [ ] Bảng `salon_resources` (giường/ghế/bàn/bồn… — generic, không hardcode)
- [ ] `bookings.resource_id` **nullable** (optional + tương thích ngược)
- [ ] **Chống trùng 2 chiều**: 1 resource ⊄ 2 booking cùng giờ **VÀ** 1 staff ⊄ 2 chỗ
- [ ] Cờ per-tiệm: `resources_enabled` + `primary_grid_axis` ('staff' | 'resource')
- [ ] **Vertical presets**: nail = off; tóc = ghế+bồn; spa/head_spa = giường on
- [ ] Admin CRUD resource (thêm/sửa/ẩn giường-ghế) + drag thứ tự
- [ ] Lịch: render **cột-theo-resource** khi bật + **toggle** staff↔resource
- [ ] Availability công khai: slot trống = **thợ đủ điều kiện ∩ resource** cùng trống
- [ ] Auto-assign resource trống (rule-based) khi không chỉ định
- [ ] Migrate Hi-Lite: Bed 1-7 → resource thật; bỏ stopgap "bed = staff"
- [ ] Cập nhật Square forward-sync: gán `resource_id` (bed) thay vì `staff_id`

## 3. Baseline tự bake (NailIQ đã có — không làm lại)
Multi-tenant RLS theo `salon_id`; bilingual (nhãn `kind` qua i18n, tên resource do
user nhập); React cache + revalidateTag; conventional commits + PR; CI E2E
receptionist-center bảo vệ.

## 4. Failure modes & mitigations

| Failure mode | Mitigation baked vào kiến trúc |
|---|---|
| **Phá vỡ tiệm đang chạy** | `resource_id` nullable; GIST resource là **partial** (`WHERE resource_id IS NOT NULL`); **mọi logic resource gated sau `resources_enabled`**. Tiệm off = code path y hệt hôm nay |
| Oversell giường (race 2 booking) | GIST exclusion theo `resource_id` (như `bookings_no_overlap` hiện có) + advisory lock trong RPC |
| Thợ kẹt 2 chỗ | giữ nguyên `bookings_no_overlap` theo `staff_id` |
| Hết giường trống nhưng vẫn cho đặt | availability check **(thợ ∩ resource)** trước insert; RPC trả `BookingConflictError` |
| Booking cũ không có resource | nullable → hợp lệ; ở resource-mode hiện ở cột "Chưa xếp chỗ" hoặc auto-assign |
| Grid đổi trục gây rối tiếp tân | toggle rõ + mặc định theo vertical; nhớ lựa chọn per-device |
| Migrate Hi-Lite hỏng data | test trên copy + `BEGIN…ROLLBACK`; script **idempotent**; chuyển `staff_id→resource_id` theo `square_team_member_id` đã link |
| E2E đỏ | salon test mặc định `resources_enabled=false` → regression = giống hệt hôm nay; thêm E2E riêng cho resource-mode |
| Resource tạm ngưng (hỏng giường) | `status='inactive'` → loại khỏi availability, giữ lịch sử |

## 5. Đề xuất AI/LLM (Phase 1 tối thiểu)
- [ ] Auto-assign giường/ghế trống = **rule-based** (theo `display_order` + cân tải), CHƯA cần AI
- [ ] (Phase 3 wow) AI gap-fill "ghế trống → kéo walk-in", gợi ý xếp tối ưu — *để sau*

## 6. Tech stack
NailIQ hiện tại (Next 16 + Supabase Postgres + RLS + GIST `btree_gist`). Không thêm
stack mới.

## 7. Thiết kế dữ liệu (chi tiết)

```sql
-- Generic resource (per salon). KHÔNG hardcode "bed".
create table public.salon_resources (
  id            uuid primary key default gen_random_uuid(),
  salon_id      uuid not null references public.salons(id) on delete cascade,
  name          text not null,                       -- "Bed 1", "Pedi 3", "Backwash A"
  kind          text not null default 'station'      -- station|chair|bed|backwash|room|other
                 check (kind in ('station','chair','bed','backwash','room','other')),
  display_order int  not null default 0,
  status        text not null default 'active' check (status in ('active','inactive')),
  square_team_member_id text,                          -- migrate Square "bed" link here
  deleted_at    timestamptz,
  created_at    timestamptz not null default now()
);
alter table public.salon_resources enable row level security; -- salon-scoped policies

-- Booking gains an OPTIONAL second dimension.
alter table public.bookings add column resource_id uuid references public.salon_resources(id);

-- 1 resource không 2 booking đè giờ (partial → triệu booking non-resource không bị ràng).
alter table public.bookings add constraint bookings_resource_no_overlap
  exclude using gist (
    salon_id   with =,
    resource_id with =,
    tstzrange(start_time_utc, end_time_utc, '[)') with &&
  ) where (resource_id is not null and status not in ('cancelled','no_show'));
-- (staff no-overlap giữ nguyên như hiện tại)

-- Per-salon config (mặc định OFF → tương thích ngược).
alter table public.salons
  add column resources_enabled boolean not null default false,
  add column primary_grid_axis text not null default 'staff'
    check (primary_grid_axis in ('staff','resource'));
```

**Vertical presets** (qua registry `salons.vertical` đã có): onboarding set giá trị
khởi tạo — nail: `enabled=false`; hair: `enabled=true, axis='staff'` + seed ghế/bồn;
head_spa: `enabled=true, axis='resource'` + seed giường. Tiệm override được.

**Quy tắc availability (resource-mode):** slot khả dụng ⇔ tồn tại ≥1 staff đủ điều
kiện (qua `staff_services`) **đang trống** **VÀ** ≥1 resource active đang trống trong
khoảng đó. Auto-assign: resource active trống đầu tiên theo `display_order`.

## 8. Module breakdown & thứ tự build

1. **Schema + migration** — `salon_resources`, `bookings.resource_id`, dual GIST, salon config. Test trên schema cũ (BEGIN…ROLLBACK).
2. **Resource CRUD + presets** — admin UI khai báo giường/ghế + vertical defaults.
3. **Scheduling core** — availability (staff ∩ resource); `create_public_booking` RPC + desk booking + edit nhận `resource_id` + dual-constraint; auto-assign.
4. **Timeline grid** — render cột-theo-resource + toggle; booking block hiện nhãn thợ.
5. **Public booking** — availability resource-aware + assign.
6. **Hi-Lite migration** — Bed 1-7 → `salon_resources`; `bookings.staff_id → resource_id`; `square_team_member_id` chuyển sang resource; bật `resources_enabled + axis='resource'`. Cập nhật `square/sync.ts` gán resource.
7. **Tests + verify** — unit (dual-overlap) + E2E **cả 2 mode** (off = regression, on = mới) + build xanh + verify tận mắt.

## 9. Deploy target
Vercel + Supabase prod (`fshmobzyjhmtvndobwsy`), qua PR (CI E2E receptionist-center
xanh trước khi merge). Migration áp qua MCP/CLI như các migration khác.

---

## Quyết định đã chốt (2026-06-10)
- **(A)** ✅ Duyệt schema + cờ `resources_enabled` / `primary_grid_axis` per-salon.
- **(B)** ✅ Migrate Hi-Lite **ngay trong Phase 1** (Bed 1-7 → resource, gỡ stopgap "bed=staff").
- **(C)** ✅ **Resource-mode: booking BẮT BUỘC có resource khi tạo** (`resources_enabled=true`). Cột vẫn nullable cho tương thích ngược + tiệm off + booking cũ, nhưng app/RPC enforce bắt buộc khi bật. Auto-assign giúp lấp nhanh; hết chỗ → trả conflict (no bed = no service).
