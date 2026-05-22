# Brief: Queue "Simple Mode" — chế độ hàng chờ gọn cho tiệm nhỏ

**Người yêu cầu:** Huy
**Ngày:** 20/05/2026
**Mục tiêu:** Cho salon nhỏ (1-3 thợ) bật chế độ hiển thị hàng chờ **"Gọn"** — ẩn bớt field nâng cao trên QueueEntryCard để tiếp tân không bị rối. Default giữ **"Đầy đủ"** (KHÔNG đổi behavior hiện tại của các salon đang dùng).

---

## 0. ĐỌC TRƯỚC (bắt buộc)
- `CLAUDE.md`
- `docs/ARCHITECTURE_LOCK.md`, `docs/DESIGN_SYSTEM.md`, `docs/COLOR_TOKENS.md`

## 1. Constraints (DO NOT)
- **KHÔNG tạo primitive UI mới** — extend `QueueEntryCard` qua props (đã có sẵn `showWaitTime`, `showVipIndicator` làm tiền lệ)
- **KHÔNG tạo color/spacing ngoài tokens**
- **Default = 'full'** để mọi salon hiện tại KHÔNG bị đổi UX
- Mutation qua **server action** (không REST route), verify `salon_members`
- TypeScript strict, không `any`
- typecheck + build pass, commit riêng, mở **PR draft**

## 2. Phạm vi (chỉ làm đúng những cái này)

### 2.1 Schema
- Migration mới trong `supabase/migrations/`: thêm cột `queue_display_mode text NOT NULL DEFAULT 'full'` vào bảng `salons`. Giá trị: `'simple' | 'full'`.
- Cập nhật `src/lib/database.types.ts` cho khớp.

### 2.2 QueueEntryCard (`src/components/receptionist/QueueEntryCard.tsx`)
- Thêm prop `displayMode?: "simple" | "full"` (default `"full"`).
- Khi `displayMode === "simple"` → ẨN các field nâng cao:
  - Priority badge (high/medium/low)
  - Staff dispatch line (`requestedStaffName` + `requestedStaffReadyAtIso` — dòng "Ready ~3:25 PM")
  - "❤️ Khách yêu cầu thợ này" line
  - Request tags
  - Party size badge
- **VẪN GIỮ** (vì cốt lõi): position #, customer name, **VIP crown 👑**, **wait hero number + màu**, service name, **soft-hold countdown**, action buttons (Gán/Huỷ).
- Tip: tái dùng cơ chế conditional render hiện có; chỉ thêm điều kiện `displayMode !== "simple"` cho các block cần ẩn.

### 2.3 WalkinQueueSidebar (`src/components/receptionist/WalkinQueueSidebar.tsx`)
- Nhận `queueDisplayMode` (từ salon) và truyền `displayMode={...}` xuống `<QueueEntryCard>` (giống cách đang truyền `showWaitTime`, `showVipIndicator`).

### 2.4 Loader (`src/shared/dashboard/loadReceptionistCenterData.ts`)
- Select thêm `queue_display_mode` từ salon → đưa vào data trả về cho Receptionist Center.

### 2.5 Settings UI
- Thêm 1 control trong Settings (đặt gần **Walk-in Auto-assign** — `WalkinAutoAssignSettings.tsx` là chỗ hợp lý nhất, cùng nhóm "hàng chờ").
- UI: segmented/toggle 2 lựa chọn — **"Gọn"** / **"Đầy đủ"**, kèm 1 dòng mô tả ngắn ("Gọn: ẩn bớt chi tiết, hợp tiệm nhỏ").
- Mutation: server action cập nhật `salons.queue_display_mode`, verify caller là member của salon.

### 2.6 (Optional, nếu rẻ) TVModeView
- `TVModeView.tsx` cũng respect `displayMode` nếu dễ. Nếu phức tạp → bỏ qua, ghi TODO.

## 3. Acceptance Criteria
- Settings có toggle **Gọn / Đầy đủ**, default **Đầy đủ**.
- Salon chọn **"Gọn"** → QueueEntryCard chỉ hiện: position, name, VIP crown, wait hero (màu), service, soft-hold (nếu có), action buttons. KHÔNG hiện priority/staff-ready/❤️/tags/party.
- Salon **"Đầy đủ"** → y như hiện tại.
- Salon hiện có (chưa set) → mặc định **'full'**, không đổi gì.
- `npm run typecheck` + `npm run build` pass.
- (Nếu có e2e cho receptionist-center) thêm/giữ 1 test nhỏ cho simple mode.

## 4. Out of scope
- KHÔNG đụng logic auto-assign / urgency / soft-hold (chỉ ẩn/hiện UI).
- KHÔNG thêm per-field toggle riêng lẻ (chỉ 2 preset Gọn/Đầy đủ cho đơn giản).
- KHÔNG refactor ReceptionistCenter lớn.

## 5. Quy trình
1. Branch: `feat/queue-simple-mode`
2. Migration → types → card prop → sidebar → loader → settings UI → (TV optional)
3. `npm run typecheck && npm run build`
4. Commit conventional: `feat(queue): add simple display mode for small salons`
5. Apply migration lên prod qua Supabase MCP (theo PM workflow trong CLAUDE.md)
6. Mở PR draft → Huy review

---

*Brief tạo 20/05/2026. Feature nhỏ, 1 PR. Mục tiêu: gọn hơn cho tiệm nhỏ, giữ nguyên cho tiệm đang dùng.*
