// A rejected request can happen before or after the server commits the save.
export const SETTINGS_SAVE_UNCONFIRMED = {
  en: "The save result could not be confirmed. Check your connection, then try again.",
  vi: "Chưa xác nhận được kết quả lưu. Kiểm tra kết nối rồi thử lại.",
} as const;
