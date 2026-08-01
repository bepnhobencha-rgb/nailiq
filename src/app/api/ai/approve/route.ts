/**
 * Approval links are deliberately two-step:
 * GET renders a read-only confirmation page; POST records the decision.
 * This prevents email scanners and browser prefetching from taking action.
 */

import { type NextRequest, NextResponse } from "next/server";
import { processDecision } from "@/shared/ai/approvalRequests";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TokenRow = {
  id: string;
  approve_token: string;
  decline_token: string;
  status: string;
  salon_id: string;
  summary: string;
};

const SECURITY_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function htmlPage(
  title: string,
  body: string,
  dashHref?: string,
  status = 200,
): NextResponse {
  const backHref = dashHref ?? "https://nailiq.ca";
  const backLabel = dashHref ? "Quay về dashboard" : "NailIQ";
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="robots" content="noindex,nofollow"/>
  <title>${esc(title)} — NailIQ</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,Segoe UI,sans-serif;background:#f9fafb;color:#1a1a1a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border-radius:16px;padding:40px 32px;max-width:460px;width:100%;box-shadow:0 1px 4px rgba(0,0,0,.08)}h1{font-size:22px;font-weight:700;margin-bottom:12px}p{font-size:15px;line-height:1.65;color:#374151}.summary{margin:20px 0;padding:16px;border-radius:12px;background:#f3f4f6}.badge{display:inline-block;padding:4px 12px;border-radius:99px;font-size:13px;font-weight:600;margin-bottom:20px}.ok{background:#dcfce7;color:#15803d}.warn{background:#fef9c3;color:#854d0e}.err{background:#fee2e2;color:#991b1b}.confirm{width:100%;border:0;border-radius:10px;padding:13px 18px;color:#fff;font-size:15px;font-weight:700;cursor:pointer}.approve{background:#15803d}.decline{background:#b91c1c}a{color:#6b7280;font-size:14px}
  </style>
</head>
<body><main class="card">${body}<p style="margin-top:24px"><a href="${esc(backHref)}">← ${backLabel}</a></p></main></body>
</html>`;

  return new NextResponse(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...SECURITY_HEADERS,
    },
  });
}

async function findToken(token: string): Promise<{
  row: TokenRow;
  decision: "approved" | "declined";
  dashHref?: string;
} | null> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("approval_requests" as never)
    .select("id, approve_token, decline_token, status, salon_id, summary")
    .or(`approve_token.eq.${token},decline_token.eq.${token}` as never)
    .maybeSingle();

  if (!data) return null;
  const row = data as TokenRow;
  const { data: salon } = await db
    .from("salons" as never)
    .select("slug")
    .eq("id" as never, row.salon_id)
    .maybeSingle();
  const slug = (salon as { slug?: string } | null)?.slug;

  return {
    row,
    decision: row.approve_token === token ? "approved" : "declined",
    dashHref: slug
      ? `https://nailiq.ca/dashboard/${encodeURIComponent(slug)}/approvals`
      : undefined,
  };
}

function invalidToken(): NextResponse {
  return htmlPage(
    "Liên kết không hợp lệ",
    `<span class="badge err">Lỗi</span><h1>Liên kết không hợp lệ</h1><p>Liên kết không đúng, đã hết hiệu lực hoặc đã bị xoá.</p>`,
    undefined,
    400,
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token")?.trim();
  if (!token || token.length < 10) return invalidToken();

  const match = await findToken(token);
  if (!match) return invalidToken();

  if (match.row.status !== "pending") {
    return htmlPage(
      "Đã xử lý",
      `<span class="badge warn">Đã xử lý</span><h1>Yêu cầu này không còn chờ quyết định.</h1><p>Không có hành động nào được thực hiện khi bạn mở liên kết này.</p>`,
      match.dashHref,
    );
  }

  const approving = match.decision === "approved";
  return htmlPage(
    approving ? "Xác nhận đồng ý" : "Xác nhận từ chối",
    `<span class="badge ${approving ? "ok" : "err"}">Cần xác nhận</span>
     <h1>${approving ? "Đưa hành động vào hàng đợi?" : "Từ chối đề xuất này?"}</h1>
     <p>Mở liên kết này chưa làm thay đổi dữ liệu. Hãy kiểm tra đề xuất trước khi xác nhận.</p>
     <p class="summary">${esc(match.row.summary)}</p>
     <form method="post" action="/api/ai/approve">
       <input type="hidden" name="token" value="${esc(token)}"/>
       <button class="confirm ${approving ? "approve" : "decline"}" type="submit">
         ${approving ? "Xác nhận đồng ý" : "Xác nhận từ chối"}
       </button>
     </form>`,
    match.dashHref,
  );
}

function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === req.nextUrl.origin;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isSameOrigin(req)) {
    return htmlPage(
      "Yêu cầu bị chặn",
      `<span class="badge err">Bị chặn</span><h1>Không thể xác minh nguồn yêu cầu.</h1><p>Hãy mở lại liên kết NailIQ và xác nhận trên trang đó.</p>`,
      undefined,
      403,
    );
  }

  const form = await req.formData();
  const rawToken = form.get("token");
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (token.length < 10) return invalidToken();

  const match = await findToken(token);
  if (!match) return invalidToken();

  const result = await processDecision(token, match.decision);
  if (result.alreadyDecided) {
    return htmlPage(
      "Đã xử lý",
      `<span class="badge warn">Đã xử lý</span><h1>Yêu cầu này đã được xử lý rồi.</h1><p>Không cần thao tác thêm.</p>`,
      match.dashHref,
    );
  }
  if (result.expired) {
    return htmlPage(
      "Hết hạn",
      `<span class="badge warn">Hết hạn</span><h1>Yêu cầu đã hết hạn.</h1><p>Không có hành động nào được thực hiện.</p>`,
      match.dashHref,
    );
  }
  if (!result.ok) {
    return htmlPage(
      "Lỗi",
      `<span class="badge err">Lỗi</span><h1>Không thể xử lý yêu cầu.</h1><p>Vui lòng thử lại hoặc kiểm tra dashboard.</p>`,
      match.dashHref,
      500,
    );
  }

  if (match.decision === "declined") {
    return htmlPage(
      "Đã từ chối",
      `<span class="badge err">Đã từ chối</span><h1>Đề xuất đã bị từ chối.</h1><p>AI sẽ ghi nhận quyết định này.</p>`,
      match.dashHref,
    );
  }
  if (!result.execution?.ok) {
    return htmlPage(
      "Đã đồng ý — chưa thể xếp hàng",
      `<span class="badge warn">Đã ghi nhận</span><h1>Chưa thể xếp hàng thực thi.</h1><p>Không có hành động nào được thực hiện; lỗi sẽ được hiển thị để xử lý an toàn.</p>`,
      match.dashHref,
    );
  }
  if (result.execution.status === "waiting_input") {
    return htmlPage(
      "Đã đồng ý — cần thêm thông tin",
      `<span class="badge ok">Đã đồng ý</span><h1>Đề xuất đã được duyệt.</h1><p>Chưa có tin nhắn nào được gửi. NailIQ cần thêm thông tin và kiểm tra consent trước khi thực thi.</p>`,
      match.dashHref,
    );
  }
  return htmlPage(
    "Đã xếp hàng",
    `<span class="badge ok">Đã đồng ý</span><h1>Hành động đã được xếp hàng an toàn.</h1><p>NailIQ sẽ theo dõi trạng thái và không chạy trùng yêu cầu.</p>`,
    match.dashHref,
  );
}
