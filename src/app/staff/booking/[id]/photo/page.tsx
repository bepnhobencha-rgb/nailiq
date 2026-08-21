// Staff Photo Capture page — /staff/booking/[id]/photo
// Server component wrapper + client PhotoCaptureForm
// Mobile-first; accessed via direct link from booking completion flow.

import { redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { loadSalonMemberOperationalProfile } from "@/shared/dashboard/salonOwnerAdminSettings";
import { hasFeature } from "@/lib/feature-gating";
import PhotoCaptureForm from "./_components/PhotoCaptureForm";

type Props = { params: Promise<{ id: string }> };

export default async function StaffPhotoPage({ params }: Props) {
  const { id: bookingId } = await params;

  const supabase = await createClient();

  // Auth check
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  // Fetch booking
  const { data: booking } = await supabase
    .from("bookings")
    .select(
      "id, status, salon_id, client_name, client_phone, services!bookings_service_id_fkey(name), staff(name)",
    )
    .eq("id", bookingId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!booking) {
    return (
      <div className="min-h-dvh bg-[#0b0c10] flex items-center justify-center p-6">
        <p className="text-[#a1a1aa] text-sm">Booking not found.</p>
      </div>
    );
  }

  // Verify caller is a member of this salon
  const { data: membership } = await supabase
    .from("salon_members")
    .select("id, role")
    .eq("salon_id", booking.salon_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership) {
    redirect("/login");
  }

  const operational = await loadSalonMemberOperationalProfile(
    supabase,
    String(booking.salon_id),
  );
  const salon = operational.ok
    ? (operational.salon as {
        subscription_plan?: string | null;
        plan_override?: string | null;
        feature_flags?: unknown;
        name?: string | null;
        slug?: string | null;
      })
    : null;

  const canUsePhotoConfirmation = salon
    ? hasFeature(
        salon as Parameters<typeof hasFeature>[0],
        "photo_confirmation",
      )
    : false;

  // Resolve joined relations (Supabase returns as object or array)
  type ServiceRef = { name: string } | null;
  type StaffRef = { name: string } | null;
  const serviceName =
    (Array.isArray(booking.services)
      ? (booking.services[0] as ServiceRef)?.name
      : (booking.services as ServiceRef)?.name) ?? "Service";
  const staffName =
    (Array.isArray(booking.staff)
      ? (booking.staff[0] as StaffRef)?.name
      : (booking.staff as StaffRef)?.name) ?? undefined;

  if (!canUsePhotoConfirmation) {
    return (
      <div className="min-h-dvh bg-[#0b0c10] flex flex-col items-center justify-center p-6 gap-6">
        {/* Upgrade CTA for Free tier */}
        <div
          className="w-full max-w-sm rounded-2xl border p-8 text-center"
          style={{
            background: "#111214",
            borderColor: "rgba(212,175,55,0.18)",
          }}
        >
          <div className="mb-4 text-3xl">📸</div>
          <h2 className="text-lg font-semibold text-white mb-2">
            Photo Confirmation
          </h2>
          <p className="text-sm text-[#a1a1aa] mb-6">
            Send beautiful nail photos to clients after every appointment.
            Available on Pro and higher plans.
          </p>
          <a
            href={`/dashboard/${salon?.slug ?? ""}/settings/billing`}
            className="block w-full rounded-full py-3 text-sm font-semibold text-center"
            style={{
              background: "#d4af37",
              color: "#0b0c10",
            }}
          >
            Upgrade to Pro
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[#0b0c10]">
      <PhotoCaptureForm
        bookingId={bookingId}
        clientName={booking.client_name}
        clientPhone={booking.client_phone ?? undefined}
        serviceName={serviceName}
        staffName={staffName}
        bookingStatus={booking.status}
      />
    </div>
  );
}
