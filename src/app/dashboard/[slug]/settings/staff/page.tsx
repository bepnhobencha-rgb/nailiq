import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StaffManagementHub } from "@/components/dashboard/StaffManagementHub";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Staff Management · ${slug}`,
    description: "Add, remove, and manage salon staff members.",
  };
}

export default async function StaffManagementPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);

  if (!ctx) {
    redirect("/register");
  }

  // Check if user is admin or owner of this salon
  // ctx.role is already set from salon_members lookup in getDashboardWriteClient
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    redirect(`/dashboard/${slug}`);
  }

  // Fetch staff members
  const { data: staffMembers } = await ctx.supabase
    .from("salon_members")
    .select("id, user_id, role, created_at")
    .eq("salon_id", ctx.salon.id)
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold">Staff Management</h1>
        <p className="text-sm text-gray-600 mt-1">
          Add and manage salon staff members
        </p>
      </div>

      <StaffManagementHub
        salonId={ctx.salon.id}
        salonSlug={slug}
        currentUserRole={ctx.role}
        staffMembers={staffMembers || []}
      />
    </div>
  );
}
