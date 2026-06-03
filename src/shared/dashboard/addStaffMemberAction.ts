"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";
import { randomUUID } from "crypto";

interface AddStaffMemberInput {
  salonId: string;
  email?: string;
  phone?: string;
  role: SalonMemberRole;
}

interface AddStaffMemberResult {
  success: boolean;
  error?: string;
  userId?: string;
}

/**
 * Add a new staff member to a salon.
 *
 * Flow:
 * 1. If email provided: create user in Supabase Auth with email
 * 2. If phone provided: create user in Supabase Auth with phone
 * 3. Create salon_members row with the new user_id + role
 *
 * For now: We'll create a placeholder auth user if needed.
 * In production: Admin sends invite link, staff completes registration.
 */
export async function addStaffMemberAction(
  input: AddStaffMemberInput,
): Promise<AddStaffMemberResult> {
  const { salonId, email, phone, role } = input;

  // Validate input
  if (!salonId) {
    return { success: false, error: "Salon ID required" };
  }

  if (!email && !phone) {
    return { success: false, error: "Email or phone required" };
  }

  if (role !== "admin" && role !== "receptionist") {
    return { success: false, error: "Invalid role" };
  }

  try {
    const admin = createServiceRoleClient();

    // TODO: In production, create actual Supabase Auth user
    // For now: generate a placeholder user_id that will be linked when staff logs in
    const tempUserId = randomUUID();

    // Create salon_members row
    const { data, error } = await admin.from("salon_members").insert({
      salon_id: salonId,
      user_id: tempUserId,
      role,
    });

    if (error) {
      console.error("[addStaffMemberAction] insert error:", error);
      return {
        success: false,
        error: error.message || "Failed to add staff member",
      };
    }

    return {
      success: true,
      userId: tempUserId,
    };
  } catch (err) {
    console.error("[addStaffMemberAction] error:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
