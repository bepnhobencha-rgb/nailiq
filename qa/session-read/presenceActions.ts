"use server";
import { cookies } from "next/headers";
import type { PresenceRow } from "@/shared/dashboard/presenceActions";
export async function loadSalonSessions() {
  const mode = (await cookies()).get("qa-initial")?.value;
  if (mode === "error") return { ok: false, error: "server_error" };
  const sessions: PresenceRow[] = mode === "empty" ? [] : [{
    userId: "qa-user", salonId: "qa-salon", email: "qa@example.invalid", memberName: "QA Owner",
    role: "owner", ipAddress: "192.0.2.42", userAgent: null, deviceType: "mobile", browser: "Safari",
    currentPath: "/dashboard/qa-session-salon", batteryLevel: 75, lastSeenAt: new Date().toISOString(),
  }];
  return { ok: true, sessions };
}
