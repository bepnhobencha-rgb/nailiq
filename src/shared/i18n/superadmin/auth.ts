import type { UserLanguage } from "../user/types";

const en = {
  "loginTitle": "SuperAdmin sign-in",
  "loginSubtitle": "Restricted to NailIQ operators. Salon owners and staff should sign in at the regular login.",
  "passwordUpdatedTitle": "Password updated",
  "passwordUpdatedBody": "Sign in with your new password.",
  "reauthenticationRequired": "Your secure session ended or could not be verified. Sign in again to continue.",
  "email": "Email",
  "password": "Password",
  "signIn": "Sign in",
  "forgotPassword": "Forgot password?",
  "signInFailed": "Sign-in failed.",
  "serverError": "Something went wrong. Try again.",
  "forgotTitle": "Reset SuperAdmin password",
  "forgotSubtitle": "Enter the email associated with your operator account. If it matches an active SuperAdmin, we'll send a recovery link.",
  "invalidLink": "Reset link is invalid or expired. Request a new one.",
  "recoveryUnavailable": "Password recovery is temporarily unavailable. Try again.",
  "forgotSentTitle": "Check your inbox",
  "forgotSentBody": "If the account is eligible, a password-reset link is on its way.",
  "forgotSubmit": "Send reset link",
  "rememberedPassword": "Remembered it?",
  "backToSignIn": "Back to sign in",
  "resetTitle": "Set a new password",
  "resetSubtitle": "Choose a password at least 8 characters long. You'll be signed out and asked to sign in fresh with the new password.",
  "newPassword": "New password",
  "confirmPassword": "Confirm password",
  "resetSubmit": "Set new password",
  "weakPassword": "Password must be 8–72 characters.",
  "mismatch": "Passwords don't match.",
  "noSession": "Reset link is no longer valid. Request a new one.",
  "noRole": "This account is not an active SuperAdmin.",
  "unconfirmed": "We could not confirm whether your password changed. Try signing in with your new password. If it does not work, request a new reset link."
};

type SuperadminAuthMessages = { [Key in keyof typeof en]: string };

const vi: SuperadminAuthMessages = {
  "loginTitle": "Đăng nhập SuperAdmin",
  "loginSubtitle": "Chỉ dành cho người vận hành NailIQ. Chủ salon và nhân viên vui lòng dùng trang đăng nhập thông thường.",
  "passwordUpdatedTitle": "Mật khẩu đã được cập nhật",
  "passwordUpdatedBody": "Đăng nhập bằng mật khẩu mới.",
  "reauthenticationRequired": "Phiên đăng nhập đã kết thúc hoặc chưa thể xác minh. Vui lòng đăng nhập lại để tiếp tục.",
  "email": "Email",
  "password": "Mật khẩu",
  "signIn": "Đăng nhập",
  "forgotPassword": "Quên mật khẩu?",
  "signInFailed": "Đăng nhập không thành công.",
  "serverError": "Có lỗi xảy ra. Vui lòng thử lại.",
  "forgotTitle": "Đặt lại mật khẩu SuperAdmin",
  "forgotSubtitle": "Nhập email của tài khoản vận hành NailIQ. Nếu tài khoản SuperAdmin còn hoạt động, chúng tôi sẽ gửi link khôi phục.",
  "invalidLink": "Link đặt lại không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu link mới.",
  "recoveryUnavailable": "Tạm thời chưa thể khôi phục mật khẩu. Vui lòng thử lại.",
  "forgotSentTitle": "Kiểm tra hộp thư",
  "forgotSentBody": "Nếu tài khoản đủ điều kiện, link đặt lại mật khẩu đang được gửi.",
  "forgotSubmit": "Gửi link đặt lại",
  "rememberedPassword": "Đã nhớ mật khẩu?",
  "backToSignIn": "Quay lại đăng nhập",
  "resetTitle": "Đặt mật khẩu mới",
  "resetSubtitle": "Chọn mật khẩu có ít nhất 8 ký tự. Sau khi đổi mật khẩu, bạn sẽ được đăng xuất và cần đăng nhập lại bằng mật khẩu mới.",
  "newPassword": "Mật khẩu mới",
  "confirmPassword": "Xác nhận mật khẩu",
  "resetSubmit": "Đặt mật khẩu mới",
  "weakPassword": "Mật khẩu phải có 8–72 ký tự.",
  "mismatch": "Mật khẩu không khớp.",
  "noSession": "Link đặt lại không còn hiệu lực. Vui lòng yêu cầu link mới.",
  "noRole": "Tài khoản này không phải SuperAdmin đang hoạt động.",
  "unconfirmed": "Chưa thể xác nhận mật khẩu đã được đổi. Hãy thử đăng nhập bằng mật khẩu mới. Nếu không đăng nhập được, hãy yêu cầu link đặt lại mới."
};

export function getSuperadminAuthMessages(language: UserLanguage): SuperadminAuthMessages {
  return language === "vi" ? vi : en;
}
