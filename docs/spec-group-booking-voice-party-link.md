# Đặc Tả Kỹ Thuật: Group Booking v2 — Voice AI + Synchronized Finish + Party Link + Wave Booking

**Dự án:** NailIQ  
**Ngày soạn:** 2026-05-27  
**Phiên bản:** 1.0 — Để gửi kỹ thuật viên review  
**Tác giả:** PM / Tech Lead  
**Stack:** Next.js 16.2 · React 19 · TypeScript 5 · Supabase · Tailwind v4 · Framer Motion 12

---

## Mục Lục

1. [Tổng quan](#1-tổng-quan)
2. [Phân tích đối thủ](#2-phân-tích-đối-thủ)
3. [Kiến trúc tổng thể](#3-kiến-trúc-tổng-thể)
4. [Sprint 1B — Voice AI Group Booking](#4-sprint-1b--voice-ai-group-booking)
5. [Sprint 2 — Synchronized Finish Engine](#5-sprint-2--synchronized-finish-engine)
6. [Sprint 3 — Party Link](#6-sprint-3--party-link)
7. [Sprint 4 — Wave Booking](#7-sprint-4--wave-booking)
8. [Quyết định DEFER: Per-Member Anchors](#8-quyết-định-defer-per-member-anchors)
9. [Rủi ro đã phân tích và giải pháp](#9-rủi-ro-đã-phân-tích-và-giải-pháp)
10. [Database changes cần thực hiện](#10-database-changes-cần-thực-hiện)
11. [Files cần thay đổi theo từng sprint](#11-files-cần-thay-đổi-theo-từng-sprint)
12. [Câu hỏi cần PM confirm trước khi build](#12-câu-hỏi-cần-pm-confirm-trước-khi-build)

---

## 1. Tổng Quan

### Hiện trạng (as of 2026-05-27)

Group booking v1 đã được ship trong các migrations `20260512200000` đến `20260527000000`. Tính năng hiện có:

- **Web flow (BookingGroupFlow.tsx):** 5 bước — số người → service/staff per member → ngày + arrival window → AI arrangement (3 lựa chọn: Best / Alternative / Earliest) → confirm.
- **Scheduler (loadGroupSmartSchedule.ts):** AI Arrival-First — tất cả thành viên đến trong cùng 1 khung giờ (sync_start mặc định). Hỗ trợ alternatives: split option, next-available-date, earlier-today.
- **Database:** `bookings.group_id`, `bookings.group_size`, `insert_group_bookings` RPC với GIST constraint. Dynamic capacity: `Math.min(activeStaffCount, 20)`.
- **Voice AI (Lily):** Chỉ xử lý individual booking qua `confirm_booking` tool. Chưa có group booking qua voice.

### Mục tiêu của spec này

Bổ sung 4 capability theo thứ tự sprint:

| Sprint | Tính năng | Độ ưu tiên |
|--------|-----------|------------|
| 1B | Voice AI Group Booking | P0 |
| 2 | Synchronized Finish (sync_finish mode) | P0 |
| 3 | Party Link | P1 |
| 4 | Wave Booking | P2 |
| — | Per-Member Anchors | DEFERRED |

### Tại sao thứ tự này?

Sprint 2 (Synchronized Finish) phải đi trước Sprint 3 (Party Link) vì Party Link cần biết mỗi thành viên đến lúc mấy giờ — thông tin này chỉ có khi scheduler đã tính xong `sync_finish` mode. Voice AI Group Booking (Sprint 1B) có thể làm song song với Sprint 2 vì chúng độc lập về code, nhưng về mặt demo cho khách hàng thì nên demo Sprint 2 + 3 cùng nhau.

---

## 2. Phân Tích Đối Thủ

### Vagaro, Booksy, Fresha — Group Booking hiện tại

Cả ba nền tảng đều có "group booking" nhưng ở mức rất cơ bản:

**Vagaro:**
- Organizer điền đầy đủ thông tin cho toàn nhóm (tên, service, thời gian cho từng người).
- Không có AI scheduling — organizer phải tự biết ai trống giờ nào.
- Không có Party Link — không có cơ chế để member tự xác nhận.
- Tất cả member đều start cùng giờ (sync_start hardcoded).

**Booksy:**
- Tương tự Vagaro. Group booking = tạo nhiều appointment riêng lẻ, liên kết thủ công.
- Không có wave booking khi group > staff.
- Không có voice AI.

**Fresha:**
- Có "multi-appointment" nhưng chỉ cho cùng 1 khách (ví dụ: manicure + pedicure trong 1 booking).
- Không có true group booking cho nhiều người.

### Cơ hội khác biệt của NailIQ

| Tính năng | NailIQ | Vagaro | Booksy | Fresha |
|-----------|--------|--------|--------|--------|
| AI Arrival-First scheduling | ✅ | ❌ | ❌ | ❌ |
| Synchronized Finish | ✅ (Sprint 2) | ❌ | ❌ | ❌ |
| Voice AI Group Booking | ✅ (Sprint 1B) | ❌ | ❌ | ❌ |
| Party Link | ✅ (Sprint 3) | ❌ | ❌ | ❌ |
| Wave Booking | ✅ (Sprint 4) | ❌ | ❌ | ❌ |
| Dynamic capacity (staff-driven) | ✅ | Cố định | Cố định | N/A |

**Kết luận:** NailIQ có cơ hội tạo differentiation thực sự, đặc biệt cho thị trường Canada/Vietnam — nơi "đi làm nail theo nhóm bạn" là social event phổ biến, không chỉ là transaction thuần túy.

---

## 3. Kiến Trúc Tổng Thể

### ASCII Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PUBLIC SURFACES                                  │
├──────────────────────┬──────────────────────┬───────────────────────────┤
│  /[slug]             │  /party/[token]       │  Voice AI (WebRTC)        │
│  BookingGroupFlow    │  PartyLinkClaimPage   │  OpenAI Realtime API      │
│  (React client)      │  (React client)       │  (Lily persona)           │
└────────┬─────────────┴─────────┬────────────┴───────────┬───────────────┘
         │                       │                         │
         │ Server Actions        │ Server Actions          │ POST /api/voice/tool
         ▼                       ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         SERVER LAYER (Next.js App Router)                │
│                                                                          │
│  loadGroupSmartSchedule.ts          partyLinkActions.ts                  │
│  ├── tryAlignedArrangement          ├── createPartyLink                  │
│  ├── tryStaggeredArrangement        ├── claimPartySlot                   │
│  └── [NEW] sync_finish mode         └── getPartyLinkStatus               │
│                                                                          │
│  submitGroupBooking.ts              /api/voice/tool/route.ts             │
│  └── insert_group_bookings RPC      ├── get_available_slots              │
│                                     ├── confirm_booking                  │
│                                     ├── [NEW] get_group_available_slots  │
│                                     └── [NEW] confirm_group_booking      │
│                                                                          │
│  buildSystemPrompt.ts                                                    │
│  └── [NEW] group booking flow instructions                               │
└──────────────────────────────┬──────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         SUPABASE (PostgreSQL)                            │
│                                                                          │
│  bookings                    party_links                                 │
│  ├── group_id (uuid)         ├── id, group_id, salon_id                 │
│  ├── group_size              ├── token (short, unique)                   │
│  └── [NO CHANGE needed]      ├── mode (sync_start | sync_finish)        │
│                              └── expires_at                              │
│                                                                          │
│  RPCs:                       party_link_claims                           │
│  ├── insert_group_bookings   ├── party_link_id, booking_id              │
│  └── public_booking_         ├── member_name, member_phone              │
│      occupancy_for_range     └── reminder_opted_in                      │
└─────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         DASHBOARD (Receptionist Center)                  │
│                                                                          │
│  ReceptionistCenter.tsx                                                  │
│  └── [NEW] Party Card widget — hiển thị attendance status nhóm          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Flow — Group Booking với Synchronized Finish

```
Customer gọi điện / mở web
         │
         ▼
[Input] group size, service per sub-group, ngày, mode (sync_start|sync_finish), target time
         │
         ▼
loadGroupSmartSchedule(params, mode, targetFinishMs?)
         │
         ├── mode = "sync_start":  anchorMs = earliestFit   → end = anchor + duration  (HIỆN TẠI)
         │
         └── mode = "sync_finish": targetFinish F           → start = F - duration     (MỚI)
                    longest service arrives first (earliest start)
                    shortest service arrives last (latest start = F - shortestDuration)
         │
         ▼
GroupArrangement[] → User chọn 1 arrangement
         │
         ▼
submitGroupBooking() → insert_group_bookings RPC (atomic)
         │
         ├── [NEW Sprint 3] createPartyLink(group_id, salon_id, mode)
         │            └── Returns party_link.token
         │
         ▼
Organizer nhận Party Link → Chia sẻ cho members
         │
         ▼
Member mở /party/[token] → Xem slot của mình → Confirm + nhập tên/phone
```

---

## 4. Sprint 1B — Voice AI Group Booking

### 4.1 Bối cảnh và vấn đề

Lily (Voice AI) hiện tại chỉ handle individual booking qua `confirm_booking` tool. Khi một khách gọi điện để đặt cho cả nhóm (ví dụ: "Tôi muốn đặt cho 5 người, 3 pedicure, 2 gel manicure, thứ Bảy lúc 2 giờ chiều"), Lily không có tool phù hợp và sẽ bị lạc hoặc cố gắng tạo 5 individual booking riêng lẻ — dẫn đến trải nghiệm tệ và không đảm bảo group được phân công staff đúng.

### 4.2 Lý do KHÔNG dùng blank slots

Một approach được cân nhắc là Lily đặt "blank slots" (chỗ giữ chỗ không có service) rồi members tự fill sau. Approach này bị reject vì:

1. **DB constraint:** `bookings.service_id` là `NOT NULL`. Migration `20260512200000` không có optional service.
2. **GIST constraint:** `bookings_no_overlap` cần `end_time_utc` để tính overlap, mà `end_time_utc = start_time_utc + service.duration_minutes`. Nếu không có service thì không tính được end time.
3. **Synchronized Finish:** Thuật toán `sync_finish` cần biết duration của mỗi member TRƯỚC KHI tính start time (vì `start = targetFinish - duration`). Nếu service chưa có thì cả logic này đổ vỡ.
4. **Ghost bookings:** Blank slots bị giữ chỗ vô thời hạn nếu member không claim — lãng phí capacity salon.

**Kết luận:** Services phải được thu thập UPFRONT trong cuộc gọi với Lily.

### 4.3 Conversation Flow của Lily (Group Booking)

```
Lily: "Xin chào! Tôi là Lily từ [Salon]. Nhóm bạn muốn làm dịch vụ gì?"

Khách: "Tôi muốn đặt cho 5 người — 3 pedicure, 2 gel manicure"

Lily: "Tuyệt! Vậy là 3 người pedicure và 2 người gel manicure. 
       Nhóm muốn đến ngày nào?"

Khách: "Thứ Bảy tuần này"

Lily: [gọi get_group_available_slots(
         service_assignments=[{service_id: "ped_id", count: 3}, {service_id: "gel_id", count: 2}],
         date: "2026-05-31",
         mode: "sync_start",  // mặc định
         target_time: "14:00"
       )]

Lily: "Nhóm có muốn về cùng nhau không, hay đến cùng nhau là được?"
      // Đây là câu hỏi quan trọng duy nhất về mode

Khách: "Về cùng nhau thì tốt hơn"

Lily: [gọi lại get_group_available_slots(..., mode: "sync_finish", target_time: "16:00")]

Lily: "Có lịch lúc 2 giờ chiều — nhóm sẽ về vào khoảng 4 giờ. 
       Bạn tên gì và số điện thoại?"

Khách: "Mai, 0901234567"

Lily: [gọi confirm_group_booking(
         members_with_services=[{count: 3, service_id: "ped_id"}, {count: 2, service_id: "gel_id"}],
         date: "2026-05-31",
         time_slot: "2:00 PM",
         mode: "sync_finish",
         organizer_name: "Mai",
         organizer_phone: "0901234567"
       )]

Lily: "Đã đặt xong! Tôi sẽ gửi link Party cho bạn qua SMS để chia sẻ 
       với nhóm. Hẹn gặp thứ Bảy!"
```

### 4.4 Hai tool mới cần thêm vào REALTIME_TOOLS

#### Tool 1: `get_group_available_slots`

```typescript
{
  type: "function",
  name: "get_group_available_slots",
  description:
    "Get available time slots for a GROUP booking. " +
    "Call this when a customer wants to book for multiple people with different services. " +
    "ALWAYS call this before mentioning any times. " +
    "Returns best matching time slots considering staff availability for the whole group.",
  parameters: {
    type: "object",
    properties: {
      service_assignments: {
        type: "array",
        description: "Array of {service_id, count} — how many people per service. " +
          "E.g. [{service_id: 'abc', count: 3}, {service_id: 'xyz', count: 2}]",
        items: {
          type: "object",
          properties: {
            service_id: { type: "string" },
            count: { type: "number" },
          },
          required: ["service_id", "count"],
        },
      },
      date: {
        type: "string",
        description: "Date in YYYY-MM-DD format.",
      },
      mode: {
        type: "string",
        enum: ["sync_start", "sync_finish"],
        description:
          "sync_start = arrive together (default). " +
          "sync_finish = finish together (ask 'Nhóm muốn đến cùng nhau hay về cùng nhau?').",
      },
      target_time: {
        type: "string",
        description:
          "Preferred arrival time (sync_start) or finish time (sync_finish) in HH:MM 24h format. " +
          "E.g. '14:00' for 2PM.",
      },
    },
    required: ["service_assignments", "date"],
  },
}
```

**Tại sao dùng `service_assignments` thay vì `members` list?**

Lily không biết tên từng thành viên trong nhóm tại thời điểm scheduling — chỉ biết "3 pedicure, 2 gel manicure". Đây là cách tự nhiên nhất để khách mô tả nhóm. Members sẽ tự xác nhận danh tính qua Party Link sau.

#### Tool 2: `confirm_group_booking`

```typescript
{
  type: "function",
  name: "confirm_group_booking",
  description:
    "Creates a group booking. MUST be called to actually save the booking — verbal confirmation alone does NOT save it. " +
    "Call immediately when organizer agrees to the proposed time. " +
    "The result includes group_id and party_link_url — share the party link with the organizer for SMS.",
  parameters: {
    type: "object",
    properties: {
      members_with_services: {
        type: "array",
        description: "Same format as service_assignments — [{service_id, count}]. " +
          "Use the exact values from the get_group_available_slots call.",
        items: {
          type: "object",
          properties: {
            service_id: { type: "string" },
            count: { type: "number" },
          },
          required: ["service_id", "count"],
        },
      },
      date: {
        type: "string",
        description: "Date in YYYY-MM-DD format.",
      },
      time_slot: {
        type: "string",
        description:
          "Time slot label from get_group_available_slots result, e.g. '2:00 PM'. " +
          "For sync_finish mode, this is the TARGET FINISH time, not the start time.",
      },
      mode: {
        type: "string",
        enum: ["sync_start", "sync_finish"],
        description: "Must match the mode used in get_group_available_slots.",
      },
      organizer_name: {
        type: "string",
        description: "Name of the person calling (the organizer).",
      },
      organizer_phone: {
        type: "string",
        description: "Phone number of the organizer.",
      },
    },
    required: ["members_with_services", "date", "time_slot", "organizer_name", "organizer_phone"],
  },
}
```

### 4.5 Handler logic trong route.ts

```
POST /api/voice/tool
  toolName = "get_group_available_slots"
  → handleGetGroupAvailableSlots(supabase, salonSlug, args)
     1. Parse service_assignments → expand thành members array
        (count=3 pedicure → 3 members với serviceId=ped_id, name="Guest 1/2/3")
     2. Call loadGroupSmartSchedule({shopSlug, date, arrivalPref: {kind:"specific", time: target_time}, members})
        với mode param mới (Sprint 2)
     3. Return: danh sách arrangements dưới dạng time slots cho Lily đọc
        Format: [{time: "2:00 PM", finish_time: "4:00 PM", spread_mins: 0, mode: "sync_start"}]

  toolName = "confirm_group_booking"
  → handleConfirmGroupBooking(supabase, salonSlug, args, sessionId)
     1. Expand service_assignments → GroupBookingMember[]
        - Mỗi member lấy resolved staffId từ loadGroupSmartSchedule
        - name = "Guest 1", "Guest 2", ... (placeholder — sẽ được update bởi Party Link)
        - phone = organizer_phone cho TẤT CẢ members (placeholder)
     2. Call insert_group_bookings RPC (existing, không đổi)
     3. [Sprint 3] Tạo party_link record
     4. [Sprint 3] Stamp source = "voice" trên tất cả booking rows
     5. Return: { success, group_id, party_link_url, booking_ids }
```

### 4.6 Cập nhật buildSystemPrompt.ts

Thêm section cho group booking flow:

```
GROUP BOOKING RULES:
- When customer mentions booking for multiple people or a group, use GROUP tools.
- Group tools: get_group_available_slots → confirm_group_booking.
  Do NOT use get_available_slots + confirm_booking for groups.

- Ask ONE key question about timing: "Nhóm muốn đến cùng nhau hay về cùng nhau?"
  - "Đến cùng nhau" → mode: "sync_start" (everyone starts at same time)
  - "Về cùng nhau" → mode: "sync_finish" (everyone finishes at same time)
  - If customer doesn't understand, default to sync_start.

- Service collection: ask total count per service type, not per person.
  Good: "3 người pedicure, 2 người gel manicure" → [{service_id, count:3}, {service_id, count:2}]
  Bad: asking each person's name then their service (too slow for voice)

- After confirm_group_booking succeeds:
  - Tell organizer: "Đã đặt xong! Tôi sẽ gửi Party Link qua SMS để bạn chia sẻ với nhóm."
  - Read back: date, time, total number of people.
  - Do NOT try to read individual member assignments (too long for voice).
```

### 4.7 Trade-offs của approach này

**Ưu điểm:**
- Conversation ngắn — chỉ cần biết service groups, không cần tên từng người
- Tương thích với Party Link: members tự confirm sau
- Không cần thêm DB schema cho Voice-specific state

**Nhược điểm:**
- Staff assignment cho "Guest 1-5" là tự động (no preference) — không hỏi được preference qua voice vì conversation sẽ quá dài
- Phone cho tất cả members = organizer phone tạm thời — cần Party Link để fix
- Nếu confirm_group_booking fail (slot conflict), Lily phải offer alternative → UX phức tạp hơn

---

## 5. Sprint 2 — Synchronized Finish Engine

### 5.1 Vấn đề với sync_start mặc định

Hiện tại `loadGroupSmartSchedule` chỉ support sync_start: tất cả thành viên bắt đầu cùng lúc (anchorMs). Điều này có vấn đề khi:

- Nhóm muốn **về cùng nhau** (đi ăn tối sau khi làm nail) — người làm pedicure 90 phút và người làm gel 45 phút sẽ KHÔNG về cùng giờ nếu bắt đầu cùng giờ.
- Nhóm có service duration rất khác nhau (Kid Manicure 20 phút vs Full Acrylic Set 90 phút).

### 5.2 Thuật toán Synchronized Finish

**Định nghĩa:**
- `sync_start`: `start_i = T` cho mọi i → `end_i = T + duration_i` (behavior hiện tại)
- `sync_finish`: `end_i = F` (target finish) cho mọi i → `start_i = F - duration_i`

**Ví dụ cụ thể:**

```
Nhóm 3 người, target finish = 16:00
  - Alice: Pedicure (60 min) → bắt đầu lúc 15:00
  - Bob:   Gel Manicure (45 min) → bắt đầu lúc 15:15
  - Carol: Kid Manicure (20 min) → bắt đầu lúc 15:40

sync_start (cũ): tất cả bắt đầu 14:00, Alice về 15:00, Bob về 14:45, Carol về 14:20
sync_finish (mới): đến lúc khác nhau, tất cả về lúc 16:00
```

**Constraint quan trọng với sync_finish:**

1. Staff vẫn phải available trong `[start_i, end_i]` của mỗi member.
2. `start_i = F - duration_i` không có nghĩa là staff tự động free — vẫn phải check `staffIsFree(staffId, startMs, endMs, existing, soft)`.
3. Nếu target finish `F` không feasible (staff bận), cần tìm `F'` gần nhất mà toàn nhóm đều về được.

**Algorithm cho sync_finish:**

```
tryAlignedArrangement_SyncFinish(targetFinishMs, members, ...):
  // Members với service DÀI NHẤT đặt trước — họ có "start window" HẸP NHẤT
  // (phải bắt đầu sớm nhất), nên là constraint cứng nhất.
  order = members.sort(by: totalMinutes, descending)
  
  for member in order:
    startMs = targetFinishMs - member.totalMinutes * 60_000
    endMs = targetFinishMs
    
    // Tìm staff available trong [startMs, endMs]
    for staffId in candidateOrder:
      if isStaffCapableForService(capability, staffId, member.serviceId):
        if staffIsFree(staffId, startMs, endMs, existing, soft):
          assign(member, staffId, startMs, endMs)
          break
    
    if no staff found:
      return null  // targetFinishMs not feasible

  return assignments
```

**Staggered sync_finish** (cho ALTERNATIVE option):

Nếu exact `F` không feasible, thử `F + 15min`, `F + 30min` trong vòng `spreadCapMin` phút. Tương tự staggered cho sync_start nhưng theo hướng ngược (members kết thúc gần nhau thay vì bắt đầu gần nhau).

### 5.3 Thay đổi API của loadGroupSmartSchedule

```typescript
// Thêm vào GroupSmartScheduleParams:
export type GroupSmartScheduleParams = {
  shopSlug: string;
  date: string;
  arrivalPref: GroupArrivalPreference;
  members: GroupSmartScheduleMemberInput[];
  // MỚI:
  mode?: "sync_start" | "sync_finish";  // default: "sync_start"
  targetFinishMs?: number;  // UTC ms; chỉ dùng khi mode = "sync_finish"
};
```

**Lưu ý backward compatibility:** `mode` có default value là `"sync_start"` nên tất cả existing callers (web flow, tests) không bị break.

### 5.4 Thay đổi UI trong BookingGroupFlow.tsx

**Step 1 (Group Size step)** — thêm toggle:

```
┌─────────────────────────────────────────────────────────┐
│  Nhóm muốn...                                            │
│                                                          │
│  ┌──────────────────┐  ┌──────────────────────────────┐  │
│  │  🚀 Đến cùng nhau │  │  🎯 Về cùng nhau             │  │
│  │  (Arrive Together)│  │  (Finish Together)           │  │
│  └──────────────────┘  └──────────────────────────────┘  │
│                                                          │
│  [Chỉ hiện khi "Về cùng nhau" được chọn]                │
│  Nhóm muốn về lúc mấy giờ?                              │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  [Time picker: 2:00 PM]                             │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Placement:** Step 1 (group size) phù hợp hơn là Step 3 (date/time) vì mode ảnh hưởng đến cách user nghĩ về booking ngay từ đầu. Đặt ở Step 3 tạo ra dissonance khi user đã setup service assignments theo cách "sync_start".

**Nếu "Về cùng nhau" được chọn:**
- Step 3 (Date & Arrival Window) cần thêm target finish time input.
- Label thay đổi: "Arrival Window" → "Finish Time" (hoặc bilingual: "Muốn về lúc mấy giờ?").
- Scheduler nhận `mode: "sync_finish"` + `targetFinishMs`.

### 5.5 Thay đổi submitGroupBooking.ts

```typescript
export type GroupBookingParams = {
  shopSlug: string;
  members: GroupBookingMember[];
  idempotencyKey: string;
  clientWebsite?: string;
  // MỚI:
  mode?: "sync_start" | "sync_finish";
  // mode lưu vào bookings table không? → Xem phần DB changes
};
```

Mode cần được pass xuống để:
1. Lưu vào party_links.mode (Sprint 3) — Party Card trên dashboard cần biết để render đúng.
2. Không cần lưu vào `bookings` table vì `start_time_utc`/`end_time_utc` đã encode đầy đủ thông tin.

---

## 6. Sprint 3 — Party Link

### 6.1 Motivation

Sau khi booking được tạo (qua web hoặc voice), organizer nhận được một Party Link. Link này:
- Cho phép members tự xem slot của mình
- Confirm attendance
- Thêm tên và phone để nhận reminder
- Không cho phép đổi service hoặc thời gian (đó là việc của receptionist)

### 6.2 Database Schema

```sql
-- Migration: 20260530000000_party_links.sql

CREATE TABLE public.party_links (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid         NOT NULL REFERENCES bookings(group_id),
  salon_id    uuid         NOT NULL REFERENCES salons(id),
  token       text         NOT NULL UNIQUE,
  mode        text         NOT NULL DEFAULT 'sync_start'
                           CHECK (mode IN ('sync_start', 'sync_finish')),
  expires_at  timestamptz  NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

-- Index cho lookup by token (hotpath — mỗi member click link là 1 lookup)
CREATE INDEX idx_party_links_token ON public.party_links (token);

-- Index cho dashboard query: "show party links for this salon"
CREATE INDEX idx_party_links_salon_id ON public.party_links (salon_id, created_at DESC);

-- Tự động expire sau 7 ngày (cron job hoặc check on read)
-- Không dùng pg_cron để tránh thêm dependency. Check on read đủ rồi.

-- RLS: party_links visible to anon (public URL), 
-- chỉ salon members mới write được.
ALTER TABLE public.party_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_party_links" ON public.party_links
  FOR SELECT TO anon USING (expires_at > now());

CREATE POLICY "salon_member_insert_party_links" ON public.party_links
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.salon_members
      WHERE salon_members.salon_id = party_links.salon_id
        AND salon_members.user_id = auth.uid()
    )
  );

-- ──────────────────────────────────────────────────────────────────

CREATE TABLE public.party_link_claims (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  party_link_id     uuid         NOT NULL REFERENCES party_links(id) ON DELETE CASCADE,
  booking_id        uuid         NOT NULL REFERENCES bookings(id)    ON DELETE CASCADE,
  member_name       text,        -- null cho đến khi member claim
  member_phone      text,        -- null cho đến khi member claim
  reminder_opted_in boolean      NOT NULL DEFAULT false,
  claimed_at        timestamptz,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  
  -- 1 booking chỉ có 1 claim
  UNIQUE (booking_id)
);

-- Index: dashboard query "show all claims for this party link"
CREATE INDEX idx_party_link_claims_party_link_id
  ON public.party_link_claims (party_link_id);

-- RLS: anon có thể đọc claim của booking_id mà họ đang xem
-- (cần để hiện "slot này đã có người claim chưa")
ALTER TABLE public.party_link_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_claims" ON public.party_link_claims
  FOR SELECT TO anon USING (true);  -- public, no PII risk vì chỉ có boolean claimed_at

CREATE POLICY "anon_insert_claim" ON public.party_link_claims
  FOR INSERT TO anon WITH CHECK (true);  -- ai cũng claim được

CREATE POLICY "anon_update_own_claim" ON public.party_link_claims
  FOR UPDATE TO anon USING (claimed_at IS NULL);  -- chỉ update nếu chưa claimed
```

**Tại sao không dùng bookings.group_id làm Party Link token?**

`group_id` là UUID v4 — dài 36 ký tự, xấu khi share qua SMS/Zalo. Token riêng cho phép tạo short code (ví dụ 8 ký tự Base62: `niq-4xK9pQmR`) thân thiện hơn.

**Party Link expires sau bao lâu?**

Đề xuất: `booking.start_time_utc + 24 giờ`. Sau khi nhóm đã đến salon rồi thì link không còn cần thiết. Nếu set cứng 7 ngày thì risk: người dùng share link vào group chat, ai đó click sau khi appointment đã xong và thấy stale data.

**Câu hỏi PM:** Confirm expiry logic — `start_time_utc + 24h` hay `created_at + 7d`?

### 6.3 Token generation

```typescript
// src/shared/booking/partyLinkActions.ts

import { randomBytes } from "crypto";

function generatePartyToken(): string {
  // 6 bytes → 8 Base62 chars → 62^8 ≈ 218 tỷ combinations
  // Collision probability ở 1 triệu tokens: ~0.5% → chấp nhận được
  const bytes = randomBytes(6);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (const byte of bytes) {
    result += chars[byte % 62];
  }
  return result;
}
```

### 6.4 Server Actions (partyLinkActions.ts)

```typescript
// Action 1: Tạo party link sau khi group booking thành công
export async function createPartyLink(params: {
  groupId: string;
  salonId: string;
  bookingIds: string[];  // ordered list — booking[0] = member 0
  mode: "sync_start" | "sync_finish";
  expiresAt: string;    // UTC ISO
}): Promise<{ token: string; url: string } | { error: string }>

// Action 2: Load party link page data (public — no auth required)
export async function loadPartyLinkPage(token: string): Promise<{
  salon: { name: string; slug: string; address: string | null };
  mode: "sync_start" | "sync_finish";
  slots: Array<{
    bookingId: string;
    service: { name: string; duration_minutes: number };
    startDisplay: string;   // salon-local, "Thứ Bảy, 31/05 lúc 2:00 PM"
    endDisplay: string;
    staffName: string;
    claimed: boolean;       // nếu true, show "Đã có người nhận slot này"
    claimId: string | null;
  }>;
  expired: boolean;
} | { error: "not_found" | "expired" }>

// Action 3: Member claim slot
export async function claimPartySlot(params: {
  claimId: string;    // party_link_claims.id (pre-created khi party link tạo)
  memberName: string;
  memberPhone: string;
  reminderOptIn: boolean;
}): Promise<{ success: true } | { error: "already_claimed" | "expired" | "invalid" }>

// Action 4: Organizer/receptionist xem attendance board
export async function getPartyLinkStatus(token: string): Promise<{
  totalMembers: number;
  confirmedCount: number;
  slots: Array<{
    bookingId: string;
    memberName: string | null;
    memberPhone: string | null;
    claimed: boolean;
    reminderOptIn: boolean;
  }>;
}>
```

### 6.5 Trang /party/[token]

**Route:** `src/app/party/[token]/page.tsx` (Server Component)

```
Loading state:
  - Validate token server-side
  - Redirect to /party/expired nếu expires_at < now()
  - Render PartyLinkClaimPage với data

PartyLinkClaimPage (Client Component):
  - Hiển thị salon name + date
  - List các slots (scrollable cards)
  - Mỗi card: service name, time, staff name, "Nhận slot này" button
  - Khi click "Nhận slot này": mở form (name, phone, reminder toggle)
  - Submit → claimPartySlot server action
  - Success state: confetti (canvas-confetti), "Đã xác nhận! Hẹn gặp bạn tại salon."
```

**Lý do Party Link là read-only + confirmation, KHÔNG phải slot-claiming:**

Party Link v1 ban đầu được thiết kế để members tự "chọn" slot cho mình (giống Doodle). Approach này bị reject vì:
- Nếu 2 members cùng click "slot 2PM" → race condition, 1 người thắng, 1 người thua → UX tệ.
- Slots đã được assign bởi scheduler (tối ưu cho salon) — để members tự chọn phá vỡ optimization.
- Organizer đã confirm tất cả slots khi booking — không cần negotiate lại.

Party Link v2 (spec này): Slots đã cố định, members chỉ CONFIRM và thêm contact info.

### 6.6 Dashboard: Party Card

Thêm vào Receptionist Center widget mới hiển thị group attendance:

```
Party Card (trên dashboard, xem theo group):
┌─────────────────────────────────────────────────────────────┐
│  🎉 Nhóm Mai · Thứ Bảy 31/05 · 2:00 PM → 4:00 PM          │
│  Confirmed: 3/5  ●●●○○                                       │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Mai (organizer)     Pedicure     2:00 PM    ✅       │    │
│  │  Chưa xác nhận       Gel Mani     2:15 PM    ○        │    │
│  │  Chưa xác nhận       Pedicure     2:00 PM    ○        │    │
│  │  Chưa xác nhận       Gel Mani     2:15 PM    ○        │    │
│  │  Chưa xác nhận       Kid Mani     3:40 PM    ○        │    │
│  └──────────────────────────────────────────────────────┘    │
│  [Copy Party Link]  [Send Reminder SMS]                       │
└─────────────────────────────────────────────────────────────┘
```

**Party Card chỉ hiện khi:**
- Có group booking trong ngày hôm nay hoặc trong 7 ngày tới
- Party link chưa expired

**Placement trong Receptionist Center:** Theo `docs/DASHBOARD_LAYOUT_RULES.md`, không được thay đổi 3-zone layout. Party Card sẽ được đặt trong zone center hoặc sidebar — cần PM confirm vị trí chính xác.

---

## 7. Sprint 4 — Wave Booking

### 7.1 Problem Statement

Nếu nhóm 12 người muốn đặt nhưng salon chỉ có 8 active staff, hiện tại scheduler trả về `no_slots` vì `staffList.length < resolvedMembers.length`. Thay vì reject, Wave Booking chia nhóm thành 2 "wave" liên tiếp.

### 7.2 Algorithm

```
Inputs: members (12), activeStaff (8), requestedTime T

Wave 1: members[0..7] → start tại T
Wave 2: members[8..11] → start tại T + max(wave1_member_durations) + WAVE_BUFFER_MIN

WAVE_BUFFER_MIN: 15 phút (đề xuất) — đủ để staff dọn dẹp giữa 2 wave

Party Link: 1 link duy nhất cho toàn bộ 12 người
  - Hiển thị: "Nhóm bạn có 2 đợt vào salon"
  - Wave 1 members (8 người) thấy thời gian của họ
  - Wave 2 members (4 người) thấy thời gian của họ (muộn hơn)
  - Members TỰ CHỌN wave nếu muốn (hoặc system phân công theo thứ tự add)
```

### 7.3 Voice AI Announcement

Khi Lily detect wave booking sẽ xảy ra:

```
"Salon có [N] nhân viên vào thứ Bảy. Tôi đã đặt [N] người lúc 2 giờ 
và [M] người lúc 3 giờ — cả nhóm vẫn gặp nhau tại salon. Bạn thấy 
ổn không?"
```

Nếu khách không OK → Lily suggest ngày khác hoặc giảm nhóm.

### 7.4 Complexity và Risk

Wave Booking thêm đáng kể complexity:
- `bookings.wave_number` column mới? Hay dùng start_time_utc để infer wave?
- Party Link cần render 2 wave sections riêng biệt.
- Conflict check cho Wave 2 phải account for Wave 1 slots (currently in-flight, not yet in DB).
- Members tự chọn wave: race condition potential khi 2 người cùng pick Wave 1.

**Khuyến nghị:** Ship Sprint 3 (Party Link) trước, thu thập feedback từ beta salons, rồi mới build Wave Booking. Độ phức tạp không tương xứng với sprint size.

---

## 8. Quyết Định DEFER: Per-Member Anchors

### 8.1 Tính năng đã được cân nhắc

Per-Member Anchor = mỗi thành viên trong nhóm có thể set anchor time riêng:
- "Alice phải đến lúc 2PM cố định (có appointment khác trước đó)"
- "Bob và Carol flexible, arrange quanh Alice"

### 8.2 Tại sao DEFER

**Cascade recalculation:** Nếu Alice's anchor thay đổi, hệ thống phải recalculate toàn bộ assignments cho tất cả flexible members. Khi có nhiều anchor conflicts, có thể không có feasible solution — cần giải thích rõ ràng cho user lý do.

**NP-hard edge cases:** Với N members và M anchors, bài toán trở thành Constraint Satisfaction Problem (CSP). Với N > 5 và anchor conflicts, không có polynomial solution. Greedy approach (như `tryAlignedArrangement` hiện tại) sẽ không tìm ra optimal solution.

**90% use case đã được cover:** `sync_start` (đến cùng) và `sync_finish` (về cùng) đã xử lý phần lớn yêu cầu thực tế. Per-member anchor là edge case của "group chặt chẽ về logistics" — rare trong thị trường nail salon.

**Quyết định:** DEFER đến Phase 3 sau khi Wave Booking đã được validate với real users.

---

## 9. Rủi Ro Đã Phân Tích Và Giải Pháp

### 9.1 Race Condition trên Party Link Claims

**Rủi ro:** 2 người cùng click "Nhận slot 2PM" của Alice trong cùng 1 giây.

**Giải pháp:**
- `party_link_claims` có `UNIQUE (booking_id)` — duplicate insert sẽ fail với `23505`.
- Server action `claimPartySlot` handle `23505` → return `{ error: "already_claimed" }`.
- UI hiển thị: "Slot này vừa được nhận bởi người khác. Vui lòng chọn slot khác."
- Không cần optimistic locking phức tạp vì Party Link v2 không cho members chọn slot — họ chỉ confirm slot đã được assign sẵn cho mình.

**Cập nhật:** Vì Party Link v2 là confirmation-only (không phải slot-claiming), race condition thực ra không xảy ra — mỗi member có slot riêng của mình. Race condition chỉ xảy ra nếu 2 người khác nhau cố claim CÙNG booking_id, điều này chỉ có thể xảy ra nếu Lily hoặc organizer share cùng 1 booking_id với 2 người. UNIQUE constraint đủ.

### 9.2 Ghost Bookings từ Voice AI

**Rủi ro trước đây (blank slots):** Lily tạo 5 "placeholder" bookings, chỉ 2 members confirm → 3 ghost bookings chiếm chỗ của khách khác.

**Giải pháp (đã chọn — services upfront):** Lily thu thập service assignments TRƯỚC khi tạo booking. Không có blank slots. Tất cả 5 bookings đều có `service_id` hợp lệ ngay từ lúc insert. Ghost booking scenario không thể xảy ra trong model này.

**Residual risk:** Organizer đặt 5 chỗ nhưng chỉ 3 người đến → 2 no-show. Đây là vấn đề nghiệp vụ bình thường (same as individual bookings), không phải technical risk. Salon có thể enable no-show policy.

### 9.3 Staff Capability Mismatch trong Voice AI

**Rủi ro:** Lily assigns "Guest 1" làm Pedicure cho nhân viên Linda, nhưng Linda không làm Pedicure (chỉ làm Manicure).

**Giải pháp hiện có:** `loadGroupSmartSchedule` đã filter qua `isStaffCapableForService(capability, staffId, serviceId)` từ `staff_services` table. Voice AI group tool reuse logic này — không cần thêm check mới.

### 9.4 Timezone Issues với sync_finish

**Rủi ro:** `start_i = targetFinishMs - duration_i` có thể rơi vào ngày hôm trước (ví dụ: midnight crossing nếu target finish = 00:30 AM).

**Giải pháp:** Validate rằng `start_i >= salon_opening_time` cho mọi i trước khi accept arrangement. `windowForArrival` trong scheduler đã check `dayHours.open` — cần extend check này cho sync_finish mode.

Cụ thể: sau khi tính `start_i = targetFinishMs - duration_i`, check:
```
salonLocalStartMinutes(start_i) >= openMin  // không trước giờ mở cửa
salonLocalStartMinutes(start_i) <= closeMin - duration_i  // không tràn qua giờ đóng
```

### 9.5 Party Link Token Collision

**Rủi ro:** 2 party links có cùng token (6-byte random → 62^8 combinations).

**Mitigated by:** `UNIQUE` constraint trên `party_links.token`. Nếu collision xảy ra, INSERT fail → retry với token mới (retry loop trong `createPartyLink`). Với 218 tỷ combinations, collision chỉ xảy ra khi có ~10M active party links — không realistic.

### 9.6 Wave Booking: Conflict Check cho Wave 2

**Rủi ro:** Wave 1 chưa được committed vào DB, Wave 2 calculation không thấy Wave 1 slots → double-booking.

**Giải pháp (khi implement Sprint 4):** Pass Wave 1 assignments như `softReservations` vào Wave 2 calculation — đây chính xác là cơ chế `soft` Map đã tồn tại trong `tryAlignedArrangement`. Không cần thay đổi GIST constraint.

---

## 10. Database Changes Cần Thực Hiện

### Sprint 2 — Không cần migration mới

`sync_finish` mode không yêu cầu DB schema change. `start_time_utc` và `end_time_utc` trong `bookings` đã encode đầy đủ thông tin — sync mode là implementation detail của scheduler, không cần persist.

**Optional:** Thêm `sync_mode text CHECK (sync_mode IN ('sync_start', 'sync_finish')) DEFAULT 'sync_start'` vào `bookings` để analytics sau này. Tuy nhiên, có thể infer từ `group_id` + `start_time_utc` patterns. Defer quyết định này.

### Sprint 3 — Migration mới

```
File: supabase/migrations/20260530000000_party_links.sql
```

Bao gồm:
- `CREATE TABLE party_links` (schema xem mục 6.2)
- `CREATE TABLE party_link_claims` (schema xem mục 6.2)
- Indexes
- RLS policies

Cần apply lên prod qua Supabase MCP (không phải `db push`) theo quy trình hiện tại của dự án.

### Sprint 3 — Cập nhật insert_group_bookings RPC

Hiện tại RPC không tạo party_link. Hai options:

**Option A:** Tạo party_link TRONG RPC (atomic với booking insert)
- Ưu: Không thể có group booking mà thiếu party link.
- Nhược: RPC phức tạp hơn, khó test, party link logic bị coupling với booking logic.

**Option B:** Tạo party_link SAU KHI booking thành công (separate server action)
- Ưu: Separation of concerns, dễ test, có thể retry riêng lẻ.
- Nhược: Có khoảng thời gian ngắn giữa booking created và party link created — nếu server crash ở giữa thì booking tồn tại nhưng không có party link.

**Khuyến nghị Option B** vì:
1. Khoảng thời gian window rất nhỏ (milliseconds).
2. Có thể fix bằng background job: "tìm group_id không có party_link → tạo mới".
3. Party link là nice-to-have, không phải core booking correctness.

**Câu hỏi PM:** Confirm Option A vs B?

### Sprint 4 — Wave Booking (nếu build)

```
-- Thêm column để track wave number (optional, có thể infer từ start_time):
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS wave_number SMALLINT DEFAULT 1;
```

---

## 11. Files Cần Thay Đổi Theo Từng Sprint

### Sprint 1B — Voice AI Group Booking

| File | Loại thay đổi | Mô tả |
|------|--------------|-------|
| `src/shared/voiceai/realtimeTools.ts` | Thêm | 2 tools mới: `get_group_available_slots`, `confirm_group_booking` |
| `src/app/api/voice/tool/route.ts` | Thêm handler | `handleGetGroupAvailableSlots`, `handleConfirmGroupBooking` |
| `src/shared/voiceai/buildSystemPrompt.ts` | Edit | Thêm GROUP BOOKING RULES section (khoảng 20 dòng) |

**Dependency:** Sprint 1B phụ thuộc Sprint 2 (cần `mode` parameter trong `loadGroupSmartSchedule`). Nếu làm song song, có thể mock sync_finish trong 1B rồi wire thực sau khi Sprint 2 done.

### Sprint 2 — Synchronized Finish Engine

| File | Loại thay đổi | Mô tả |
|------|--------------|-------|
| `src/shared/booking/loadGroupSmartSchedule.ts` | Edit | Thêm `mode` + `targetFinishMs` params; thêm `tryAlignedArrangement_SyncFinish`; update `findArrangementsInWindow` |
| `src/components/booking/BookingGroupFlow.tsx` | Edit | Thêm sync mode toggle vào Step 1; thêm target finish time input vào Step 3 |
| `src/shared/booking/submitGroupBooking.ts` | Edit | Thêm `mode` param, pass xuống |
| `src/app/api/voice/tool/route.ts` | Edit | Pass `mode` vào `loadGroupSmartSchedule` trong group slot handler |
| `src/shared/i18n/booking/en.ts` + `vi.ts` | Edit | Thêm copy cho sync mode toggle |

### Sprint 3 — Party Link

| File | Loại thay đổi | Mô tả |
|------|--------------|-------|
| `supabase/migrations/20260530000000_party_links.sql` | Tạo mới | Schema party_links + party_link_claims |
| `src/shared/booking/partyLinkActions.ts` | Tạo mới | 4 server actions (createPartyLink, loadPartyLinkPage, claimPartySlot, getPartyLinkStatus) |
| `src/app/party/[token]/page.tsx` | Tạo mới | Server Component — validate token, render |
| `src/components/booking/PartyLinkClaimPage.tsx` | Tạo mới | Client Component — claim UI |
| `src/app/party/expired/page.tsx` | Tạo mới | Expired link page |
| `src/shared/booking/submitGroupBooking.ts` | Edit | Gọi `createPartyLink` sau khi insert thành công |
| `src/app/api/voice/tool/route.ts` | Edit | Return `party_link_url` trong `confirm_group_booking` response |
| `src/components/receptionist/[ReceptionistCenter component]` | Edit | Thêm Party Card widget |
| `src/lib/database.types.ts` | Tạo lại | Regenerate sau khi migrate |

### Sprint 4 — Wave Booking

| File | Loại thay đổi | Mô tả |
|------|--------------|-------|
| `src/shared/booking/loadGroupSmartSchedule.ts` | Edit | Detect wave scenario; tính Wave 2 start = Wave 1 max_end + WAVE_BUFFER_MIN |
| `src/shared/voiceai/buildSystemPrompt.ts` | Edit | Thêm wave announcement script cho Lily |
| `src/app/party/[token]/page.tsx` | Edit | Render 2 wave sections |
| `src/components/booking/PartyLinkClaimPage.tsx` | Edit | Show wave labels |
| `supabase/migrations/[new].sql` | Tạo mới | `wave_number` column (optional) |

---

## 12. Câu Hỏi Cần PM Confirm Trước Khi Build

### Câu hỏi ưu tiên cao (blockers)

**Q1. Party Link expiry logic:**
- Option A: `expires_at = booking.start_time_utc + 24 giờ` (link hết hạn sau khi nhóm đã vào salon)
- Option B: `expires_at = created_at + 7 ngày` (link sống lâu hơn)
- Preference? Có use case nào cần link sau khi appointment đã xong không?

**Q2. Party Link — Option A vs B (atomic vs separate):**
- Tạo party_link TRONG `insert_group_bookings` RPC (atomic), hay SAU KHI booking thành công (separate server action)?
- Nếu chọn separate: OK với scenario "booking exists nhưng không có party link" (cực kỳ hiếm)?

**Q3. sync_finish — target time là "finish" hay "latest arrival"?**
- Phân biệt: "Nhóm muốn về lúc 4PM" = tất cả members' `end_time_utc <= 16:00`.
- Hay: "Người cuối cùng bắt đầu không trễ hơn 3:30PM" = khái niệm khác.
- Confirm: sync_finish = target finish time, tất cả members xong việc đúng giờ đó?

**Q4. Party Link placement trên Dashboard:**
- Party Card đặt ở zone nào trong receptionist center? (Center zone / Right sidebar / Bottom?)
- Có replace widget hiện tại hay add thêm?
- Tham chiếu: `docs/DASHBOARD_LAYOUT_RULES.md` — cần PM confirm vì không được tự ý move layout.

### Câu hỏi ưu tiên trung bình

**Q5. Voice AI — khi group booking fail, Lily nói gì?**
- Scenario: Organizer confirm group, nhưng khi `confirm_group_booking` chạy thì slot đã bị người khác lấy mất.
- Lily offer alternative? Hay chỉ apologize và suggest gọi lại?
- Có nên Lily tự động call `get_group_available_slots` lại với time window rộng hơn?

**Q6. Wave Booking — members tự chọn wave hay system assign?**
- Nếu system assign: theo thứ tự nào? (Thứ tự add vào nhóm? Service duration?)
- Nếu tự chọn: race condition khi nhiều người chọn Wave 1 cùng lúc?

**Q7. Party Link — cần tính năng gì cho organizer?**
- Organizer có thể xem link và thấy ai đã confirm chưa (đây đang trong spec).
- Organizer có thể gửi reminder SMS cho members chưa confirm? (Cần SMS integration)
- Organizer có thể cancel 1 member ra khỏi nhóm? (Out of scope Sprint 3?)

**Q8. Party Link — localization:**
- Page `/party/[token]` hiện bằng tiếng gì? Vi hay En mặc định?
- Có toggle ngôn ngữ không?
- Thị trường Canada: cần En + Fr? Hay En + Vi là đủ?

### Câu hỏi ưu tiên thấp (có thể quyết định sau)

**Q9. Wave Booking — tên gọi trong UI:**
- "Đợt 1" / "Đợt 2" (Vietnamese)
- "Wave 1" / "Wave 2" (English)
- Hay dùng thời gian: "2:00 PM Group" / "3:00 PM Group"?

**Q10. Analytics — có cần track sync_mode?**
- Lưu `sync_mode` vào `bookings` table để sau này biết bao nhiêu % là sync_finish?
- Hoặc đủ để infer từ `group_id` clustering?

**Q11. Booking notifications cho group:**
- Khi Party Link gửi, có kèm SMS confirmation cho organizer không?
- Khi member claim Party Link, có gửi SMS cho organizer không? ("Mai vừa xác nhận slot của mình")
- Thị trường Canada: SMS via Twilio hay email là chính?

---

## Phụ Lục A: TypeScript Types Mới Cần Thêm

```typescript
// src/shared/types/partyLink.ts (file mới)

export type PartyLinkMode = "sync_start" | "sync_finish";

export type PartyLinkSlot = {
  bookingId: string;
  serviceName: string;
  serviceDurationMinutes: number;
  startDisplay: string;   // salon-local, e.g. "Thứ Bảy 31/05 lúc 2:00 PM"
  endDisplay: string;
  staffName: string;
  claimed: boolean;
  claimId: string;        // pre-created, để member update sau
};

export type PartyLinkPageData = {
  token: string;
  salonName: string;
  salonSlug: string;
  salonAddress: string | null;
  mode: PartyLinkMode;
  groupDate: string;        // YYYY-MM-DD salon-local
  groupStartDisplay: string;
  groupEndDisplay: string;
  slots: PartyLinkSlot[];
  expired: boolean;
};

// Extension cho GroupSmartScheduleParams (mục 5.3)
// src/shared/booking/loadGroupSmartSchedule.ts
export type GroupSyncMode = "sync_start" | "sync_finish";
```

---

## Phụ Lục B: Checklist Trước Khi Ship Từng Sprint

### Sprint 1B
- [ ] `npm run typecheck` pass
- [ ] `npm run build` pass
- [ ] Manual test: gọi Lily và đặt group 2 người (1 pedicure + 1 gel)
- [ ] Manual test: gọi Lily xác nhận "về cùng nhau" → sync_finish được pass đúng
- [ ] E2E: thêm test vào `e2e/voice-ai/` (nếu chưa có)
- [ ] Apply migration lên prod (Sprint 1B không cần migration mới — skip)

### Sprint 2
- [ ] Unit test cho `tryAlignedArrangement` sync_finish mode
- [ ] Unit test: midnight crossing bị reject
- [ ] Unit test: target finish trước giờ mở cửa bị reject
- [ ] Manual test web flow: toggle "Về cùng nhau" → Step 3 hiện target finish input
- [ ] Verify backward compat: existing web group bookings không bị break
- [ ] `npm run test:e2e -- e2e/group-booking/`

### Sprint 3
- [ ] Apply migration `20260530000000_party_links.sql` lên prod trước khi deploy code
- [ ] Verify RLS: anon có thể đọc party_links nhưng không tạo được
- [ ] Verify token collision retry logic
- [ ] Manual test: tạo group booking → Party Link được tạo → mở link → claim slot
- [ ] Manual test expired link → redirect đúng
- [ ] Dashboard Party Card render đúng
- [ ] `npm run typecheck && npm run build`
- [ ] Regenerate `src/lib/database.types.ts` sau migrate

---

*Document này được soạn để gửi kỹ thuật viên review. Mọi quyết định thiết kế đều có thể thay đổi dựa trên feedback. Các câu hỏi trong mục 12 cần PM xác nhận trước khi bắt đầu build.*
