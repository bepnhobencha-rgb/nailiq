import type { RegressionTest } from "@/hooks/useVoiceDebug.legacy";

export const BUILT_IN_TESTS: RegressionTest[] = [
  // ── Slot lookup tests ────────────────────────────────────────────────────
  {
    id: "slot-today-en",
    name: "EN: Ask for slots today",
    input: "Hi, I'd like to book a manicure for today. What times are available?",
    expectedToolName: "get_available_slots",
    timeoutMs: 15000,
  },
  {
    id: "slot-tomorrow-en",
    name: "EN: Ask for slots tomorrow",
    input: "Can I get a pedicure appointment tomorrow?",
    expectedToolName: "get_available_slots",
    timeoutMs: 15000,
  },
  {
    id: "slot-today-vi",
    name: "VI: Hỏi slot hôm nay",
    input: "Chào, tôi muốn đặt lịch làm móng tay hôm nay. Có lịch trống không?",
    expectedToolName: "get_available_slots",
    timeoutMs: 15000,
  },
  {
    id: "slot-tomorrow-vi",
    name: "VI: Hỏi slot ngày mai",
    input: "Ngày mai tôi muốn đặt làm gel nail, còn chỗ không?",
    expectedToolName: "get_available_slots",
    timeoutMs: 15000,
  },
  {
    id: "slot-specific-staff-en",
    name: "EN: Request specific staff",
    input: "I want a manicure with the first available staff member tomorrow afternoon.",
    expectedToolName: "get_available_slots",
    timeoutMs: 15000,
  },

  // ── Booking confirmation tests ────────────────────────────────────────────
  {
    id: "confirm-explicit-en",
    name: "EN: Explicit booking confirmation",
    input: "Yes, please confirm my booking. My name is Sarah and my number is 604-555-1234.",
    expectedToolName: "confirm_booking",
    timeoutMs: 20000,
  },
  {
    id: "confirm-explicit-vi",
    name: "VI: Xác nhận đặt lịch rõ ràng",
    input: "Đồng ý, cho tôi đặt lịch. Tên tôi là Lan, số điện thoại 604-555-9999.",
    expectedToolName: "confirm_booking",
    timeoutMs: 20000,
  },

  // ── Safety tests (should NOT trigger tool calls) ──────────────────────────
  {
    id: "no-tool-greeting-en",
    name: "EN: Greeting should not trigger tool",
    input: "Hello!",
    expectedToolName: undefined, // no tool should fire
    timeoutMs: 5000,             // short timeout since we expect no tool call
  },
  {
    id: "no-tool-hours-en",
    name: "EN: Hours question should not trigger slot tool",
    input: "What are your opening hours?",
    expectedToolName: undefined,
    timeoutMs: 5000,
  },
];
