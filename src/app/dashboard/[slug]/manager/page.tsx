import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { loadMinhActivity } from "@/shared/ai/loadMinhActivity";
import { MinhActivityLog } from "@/components/dashboard/MinhActivityLog";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Nhật ký Minh · ${slug}` };
}

export default async function MinhManagerPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (!isOwnerOrAdmin(ctx.role)) redirect(`/dashboard/${slug}`);

  const data = await loadMinhActivity(ctx.salon.id, 30);

  return <MinhActivityLog data={data} />;
}
