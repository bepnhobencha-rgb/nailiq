# SPEC — Minh Learning Loop (AI Manager tự học & tự điều chỉnh)

> Mục tiêu của Huy: "Minh luôn học hỏi mọi tình huống để tự động mọi việc."
> Tài liệu này vạch cách làm điều đó **an toàn và khả thi**, duyệt 1 lần rồi build dần.

## 1. Nguyên tắc nền (đọc trước)

1. **LLM không tự sửa trí nhớ gốc.** "Học" khả thi = một **vòng phản hồi** (feedback loop) + **kho bài học** (retrieval) + **người duyệt ở mức rủi ro cao**. Đây là cách các hệ AI nghiêm túc đạt "tự động + cải thiện liên tục".
2. **Tự động hoá đáng tin = có rào chắn.** Sự cố A2P/SMS (19/06) chứng minh: một AI tự động mà không gate sẽ đốt tiền + spam khách nhanh hơn. **Giữ người duyệt ở hành động tốn tiền / khó đảo / gửi khách hàng loạt** chính là thứ khiến phần còn lại được phép chạy tự động.
3. **Một sự cố → một bài học được mã hoá**, không phải sửa tay một lần rồi quên.

## 2. Hiện trạng — NailIQ đã có ~70% mảnh ghép (chỉ chưa nối)

| Có sẵn | Tình trạng |
|---|---|
| `ai_actions_log` (mọi hành động Minh, có `outcome`) | ✅ ghi nhận |
| `agentOutcomeTracker` (converted / no_conversion sau 7–60 ngày) | ⚠️ chỉ ĐO, không tác động lại hành vi |
| Webhook Twilio status (`updateNotificationBySid`) | ⚠️ ghi delivered/failed, **không** ai đọc để né kênh hỏng |
| `ai_manager_instructions` (chỉ đạo cho Minh) | ⚠️ chỉ **người** gõ tay, Minh không tự sinh |
| `agentDigest` (tổng kết 21:00) | ✅ tóm tắt, nhưng không đề xuất lesson |

**Khoảng trống:** không có (a) kho bài học máy đọc được trước khi hành động, (b) tín hiệu lỗi/kết quả quay ngược vào hành vi, (c) phân tầng rủi ro.

## 3. Kiến trúc đề xuất — 4 khối

### A. Kho bài học `minh_lessons` (bộ nhớ)
Bảng: `id, salon_id (null = toàn cục), scope (channel/cost/timing/segment…), condition (jsonb), rule (text), source (incident id / agent), confidence, active, created_at`.
- Trước khi hành động, agent **truy vấn lesson khớp context** (vd "salon US + chưa A2P") và áp dụng.
- **Lesson #1 (đã làm dạng code):** US + `sms_a2p_registered=false` → email. Sẽ chuyển thành record trong kho khi bảng có.

### B. Nối tín hiệu phản hồi (đóng vòng)
- **Lỗi gửi:** Twilio 30034/30007 + tỉ lệ fail theo salon/kênh → tự hạ `confidence` kênh đó / tạo lesson "né SMS".
- **Kết quả:** outcome tracker → agent nào/segment nào converted thấp → giảm tần suất hoặc đổi cách.
- **Chi phí:** cộng dồn cost theo kênh → cảnh báo + gate.

### C. Bước tự soi định kỳ (reflection)
Agent `strategist` chạy hằng tuần: đọc outcome + lỗi + cost gần đây → **đề xuất lesson/instruction mới**.
- Low-risk (vd "đổi giờ gửi", "ưu tiên email tiệm X") → tự áp + log.
- High-risk (đổi chính sách tiền, tắt kênh toàn cục) → **đẩy cho Huy duyệt** (thẻ trong dashboard).

### D. Phân tầng hành động (rào chắn — BẮT BUỘC)
| Tầng | Ví dụ | Quyền |
|---|---|---|
| Đọc/phân tích | xem data, soạn nháp | **Tự động** |
| Rẻ + đảo ngược | gửi email, đổi giờ gửi, tag khách | **Tự động + log + undo** |
| Tốn tiền / gửi hàng loạt / khó đảo | gửi SMS US, charge no-show, đổi giá | **Gate cứng hoặc người duyệt** |

### E. Báo cho owner khi cần duyệt (KHÔNG để nằm im)

Một việc "chờ duyệt" chỉ nằm trong dashboard = chết: owner không mở thì không biết, việc kẹt mãi. Mỗi `approval_request` PHẢI chủ động báo owner.

- **Kênh:** Email **luôn gửi** (đáng tin nhất) + chuông/badge in-app. SMS chỉ thêm khi số owner gửi được — **tôn trọng đúng A2P guardrail** (đừng báo owner US qua SMS bị chặn; nếu không, chính thông báo "cần duyệt" cũng biến mất).
- **Một chạm để duyệt:** email kèm nút **Đồng ý / Từ chối** (link token an toàn, hết hạn) → owner duyệt ngay trong mail, khỏi mở dashboard.
- **Phân theo độ gấp:**
  - *Gấp / nhạy thời gian* (vd mời waitlist khi có chỗ) → báo ngay.
  - *Không gấp* (vd đổi nhịp gửi) → gom vào **digest 21:00** một dòng "X việc chờ Huy duyệt".
- **Chống spam:** gom nhiều việc vào 1 thông báo; nhắc lại 1 lần nếu để lâu; **quá hạn không trả lời → mặc định phương án an toàn** (bỏ qua, không tự làm liều).
- **Audit + học tiếp:** ghi mọi lần approve/decline. Owner hay từ chối một loại → Minh hạ đề xuất loại đó (feed vào kho lesson §A).

## 4. Lộ trình (build dần, mỗi bước có giá trị riêng)

- **Bước 0 (xong hôm nay):** Lesson #1 dạng code (A2P guardrail) + stopgap Hi-Lite + ghi `decisions.md`. Chứng minh "1 sự cố → 1 guardrail".
- **Bước 1:** Bảng `minh_lessons` + đọc lesson trong `resolveCustomerChannel`/agents; chuyển lesson #1 vào kho.
- **Bước 2:** Nối tín hiệu lỗi gửi (Twilio status) → tự né kênh hỏng + tạo lesson.
- **Bước 3:** Nối outcome → điều chỉnh tần suất/segment.
- **Bước 4:** Reflection agent đề xuất lesson + hàng đợi duyệt trong dashboard.
- **Xuyên suốt:** phân tầng rủi ro áp cho mọi agent.

## 5. Cần Huy duyệt
- [ ] Đồng ý kiến trúc 4 khối + lộ trình.
- [ ] Mức tự-áp lesson: chỉ low-risk tự áp, high-risk chờ duyệt? (đề xuất: có)
- [ ] Wire guardrail A2P cho **các agent còn lại** (firstvisit/rebook/vip/reminders/review) trong cùng đợt — hay từng đợt nhỏ?

## 6. Không nằm trong phạm vi (nói rõ kỳ vọng)
- Không hứa "AI thay hoàn toàn con người" cho các quyết định tiền bạc/pháp lý — giữ người duyệt ở tầng rủi ro cao là **thiết kế có chủ đích**, không phải thiếu sót.
- Không fine-tune model riêng (chi phí/độ phức tạp lớn) — dùng retrieval + rule + reflection đạt ~90% lợi ích.
