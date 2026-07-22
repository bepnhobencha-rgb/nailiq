import Link from "next/link";
import { validateInviteToken } from "@/shared/dashboard/inviteTokenActions";
import { JoinPageClient } from "./JoinPageClient";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lời mời tham gia · NailIQ",
  robots: "noindex",
};

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const info = await validateInviteToken(token);

  if (!info.valid) {
    // Render a friendly expired/used screen instead of a generic 404.
    const messages: Record<typeof info.reason, { title: string; body: string }> = {
      not_found: {
        title: "Link không hợp lệ",
        body: "Link mời này không tồn tại. Nhờ chủ tiệm gửi lại link mới nhé.",
      },
      expired: {
        title: "Link đã hết hạn",
        body: "Link mời có hiệu lực 48 giờ. Nhờ chủ tiệm tạo lại QR mới nhé.",
      },
      used: {
        title: "Link đã được dùng",
        body: "Link này đã được sử dụng rồi. Nếu bạn chưa đăng nhập, nhờ chủ tiệm tạo link mới.",
      },
    };
    const msg = messages[info.reason];
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0b0c10] px-4">
        <div className="w-full max-w-sm text-center">
          <div className="mb-4 text-4xl">🔗</div>
          <h1 className="text-xl font-bold text-white">{msg.title}</h1>
          <p className="mt-3 text-sm text-white/50">{msg.body}</p>
          <Link
            href="/login"
            className="mt-6 inline-block rounded-xl bg-[#d4af37] px-6 py-2.5 text-sm font-semibold text-[#0b0c10] hover:bg-[#c9a430]"
          >
            Đến trang đăng nhập
          </Link>
        </div>
      </div>
    );
  }

  return (
    <JoinPageClient
      token={info.token}
      salonName={info.salonName}
      staffName={info.staffName}
      role={info.role}
    />
  );
}
