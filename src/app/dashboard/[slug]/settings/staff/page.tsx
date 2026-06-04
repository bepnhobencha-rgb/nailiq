import { redirect } from "next/navigation";

type Props = { params: Promise<{ slug: string }> };

/**
 * Legacy staff-management route. Staff (login + permissions) and bookable
 * providers are now managed together on the unified Team page at
 * `/dashboard/[slug]/setup/staff`. Permanently redirect here so old links
 * and bookmarks land in the right place.
 */
export default async function LegacyStaffManagementPage({ params }: Props) {
  const { slug } = await params;
  redirect(`/dashboard/${slug}/setup/staff`);
}
