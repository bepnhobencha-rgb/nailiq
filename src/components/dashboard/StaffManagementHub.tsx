"use client";

import { useState } from "react";
import { addStaffMemberAction } from "@/shared/dashboard/addStaffMemberAction";
import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";

export interface StaffMember {
  id: string;
  user_id: string;
  role: SalonMemberRole;
  created_at: string;
}

interface StaffManagementHubProps {
  salonId: string;
  salonSlug: string;
  currentUserRole: SalonMemberRole;
  staffMembers: StaffMember[];
}

export function StaffManagementHub({
  salonSlug,
  currentUserRole,
  staffMembers,
}: StaffManagementHubProps) {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<SalonMemberRole>("receptionist");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const handleAddStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() && !phone.trim()) {
      setMessage("Email or phone is required");
      return;
    }

    setLoading(true);
    try {
      const result = await addStaffMemberAction({
        salonSlug,
        email: email.trim(),
        phone: phone.trim(),
        role,
      });

      if (result.success) {
        setMessage(
          result.invited
            ? "✅ Invite sent — the staff member will get an email to set their password"
            : "✅ Existing user added to this salon",
        );
        setEmail("");
        setPhone("");
        setRole("receptionist");
      } else {
        setMessage(`❌ ${result.error}`);
      }
    } catch (error) {
      setMessage(`❌ Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Add Staff Form */}
      <div className="border border-gray-200 rounded-lg p-6 bg-white">
        <h2 className="text-xl font-semibold mb-4">Add New Staff Member</h2>
        <form onSubmit={handleAddStaff} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">
                Email (optional)
              </label>
              <input
                type="email"
                placeholder="staff@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Phone (optional)
              </label>
              <input
                type="tel"
                placeholder="+1-778-555-0001"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={loading}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as SalonMemberRole)}
              disabled={loading}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="receptionist">Receptionist (Front-desk only)</option>
              {currentUserRole === "owner" && (
                <option value="admin">Admin (Full access)</option>
              )}
            </select>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400"
            >
              {loading ? "Adding..." : "Add Staff Member"}
            </button>
          </div>

          {message && (
            <div className="text-sm mt-2 p-2 rounded bg-gray-100">
              {message}
            </div>
          )}
        </form>
      </div>

      {/* Staff List */}
      <div className="border border-gray-200 rounded-lg p-6 bg-white">
        <h2 className="text-xl font-semibold mb-4">
          Current Staff ({staffMembers.length})
        </h2>
        {staffMembers.length === 0 ? (
          <p className="text-gray-500">No staff members yet</p>
        ) : (
          <div className="space-y-3">
            {staffMembers.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded"
              >
                <div>
                  <p className="font-medium">{member.user_id}</p>
                  <p className="text-sm text-gray-600">
                    {member.role === "receptionist" ? "Receptionist" : "Admin"} • Added{" "}
                    {new Date(member.created_at).toLocaleDateString()}
                  </p>
                </div>
                <span className={`text-xs px-2 py-1 rounded ${
                  member.role === "admin"
                    ? "bg-blue-100 text-blue-800"
                    : "bg-gray-200 text-gray-800"
                }`}>
                  {member.role === "admin" ? "Admin" : "Receptionist"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
