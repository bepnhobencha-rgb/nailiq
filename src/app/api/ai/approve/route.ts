/**
 * One-tap approve/decline route for Minh approval requests.
 *
 * GET /api/ai/approve?token={token}
 *
 * The token is the auth — no login required. It encodes both the request
 * identity and the intent (approve_token → approve, decline_token → decline).
 *
 * Returns an HTML page (no React) with a success/error message in Vietnamese
 * and a link back to the dashboard.
 *
 * Rate limit: token lookup happens inside processDecision; unknown tokens
 * return a safe "not found" page without leaking info.
 */

import { type NextRequest, NextResponse } from "next/server";
import { processDecision } from "@/shared/ai/approvalRequests";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function htmlPage(title: string, body: string, dashHref?: string): NextResponse {
  const backLink = dashHref
    ? `<p style="margin-top:24px"><a href="${dashHref}" style="color:#6b7280;font-size:14px">← Quay về dashboard</a></p>`
    : `<p style="margin-top:24px"><a href="https://nailiq.ca" style="color:#6b7280;font-size:14px">← NailIQ</a></p>`;

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title} — NailIQ</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,Segoe UI,sans-serif;background:#f9fafb;color:#1a1a1a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;border-radius:16px;padding:40px 32px;max-width:420px;width:100%;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    h1{font-size:22px;font-weight:700;margin-bottom:12px}
    p{font-size:15px;line-height:1.65;color:#374151}
    .badge{display:inline-block;padding:4px 12px;border-radius:99px;font-size:13px;font-weight:600;margin-bottom:20px}
    .ok{background:#dcfce7;color:#15803d}
    .warn{background:#fef9c3;color:#854d0e}
    .err{background:#fee2e2;color:#991b1b}
  </style>
</head>
<body>
  <div class="card">
    ${body}
    ${backLink}
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token")?.trim();

  if (!token || token.length < 10) {
    return htmlPage(
      "Liên kết không hợp lệ",
      `<span class="badge err">Lỗi</span>
       <h1>Liên kết không hợp lệ</h1>
       <p>Token không đúng hoặc đã bị xoá. Vui lòng kiểm tra lại email.</p>`,
    );
  }

  // Determine intent from which token column matches
  const db = createServiceRoleClient();
  const { data: tokenRow } = await db
    .from("approval_requests" as never)
    .select("id, approve_token, decline_token, status, salon_id")
    .or(`approve_token.eq.${token},decline_token.eq.${token}` as never)
    .maybeSingle();

  if (!tokenRow) {
    return htmlPage(
      "Không tìm thấy",
      `<span class="badge err">Không tìm thấy</span>
       <h1>Yêu cầu không tồn tại</h1>
       <p>Link này không còn hiệu lực hoặc đã bị xoá.</p>`,
    );
  }

  const row = tokenRow as {
    id: string;
    approve_token: string;
    decline_token: string;
    status: string;
    salon_id: string;
  };

  const decision: "approved" | "declined" =
    row.approve_token === token ? "approved" : "declined";

  // Get salon slug for the dashboard back-link
  const { data: salonRow } = await db
    .from("salons" as never)
    .select("slug")
    .eq("id" as never, row.salon_id)
    .maybeSingle();
  const slug = (salonRow as { slug?: string } | null)?.slug ?? null;
  const dashHref = slug
    ? `https://nailiq.ca/dashboard/${encodeURIComponent(slug)}/approvals`
    : undefined;

  const result = await processDecision(token, decision);

  if (result.alreadyDecided) {
    return htmlPage(
      "Đã xử lý",
      `<span class="badge warn">Đã xử lý</span>
       <h1>Yêu cầu này đã được xử lý rồi.</h1>
       <p>Không cần thao tác thêm.</p>`,
      dashHref,
    );
  }

  if (result.expired) {
    return htmlPage(
      "Hết hạn",
      `<span class="badge warn">Hết hạn</span>
       <h1>Yêu cầu đã hết hạn và bị bỏ qua tự động.</h1>
       <p>Nếu hành động vẫn còn cần thiết, Minh sẽ đề xuất lại trong lần tiếp theo.</p>`,
      dashHref,
    );
  }

  if (!result.ok) {
    return htmlPage(
      "Lỗi",
      `<span class="badge err">Lỗi</span>
       <h1>Không thể xử lý yêu cầu.</h1>
       <p>Vui lòng thử lại hoặc kiểm tra dashboard.</p>`,
      dashHref,
    );
  }

  if (decision === "approved") {
    return htmlPage(
      "Đã đồng ý",
      `<span class="badge ok">✓ Đã đồng ý</span>
       <h1>✓ Đã đồng ý. Minh sẽ thực hiện ngay.</h1>
       <p>Hành động đã được ghi nhận và sẽ được thực thi trong lần chạy tiếp theo.</p>`,
      dashHref,
    );
  }

  // declined
  return htmlPage(
    "Đã từ chối",
    `<span class="badge err">✗ Đã từ chối</span>
     <h1>✗ Đã từ chối. Minh sẽ bỏ qua.</h1>
     <p>Minh ghi nhận quyết định này và sẽ ít đề xuất hành động tương tự hơn.</p>`,
    dashHref,
  );
}
