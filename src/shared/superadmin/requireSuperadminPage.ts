import "server-only";
import { notFound } from "next/navigation";
import { requireActiveSuperAdminSession } from "@/shared/auth/requireActiveSuperAdminSession";
import { SUPERADMIN_NAV } from "@/shared/superadmin/nav";

/** Run inside each page, before reading data; layouts alone do not guard actions or sibling rendering. */
export async function requireSuperadminPage(section: string) {
  const access = await requireActiveSuperAdminSession();
  const entry = SUPERADMIN_NAV.find((item) => item.key === section);
  if (!access.ok || !entry?.allowedRoles.includes(access.role)) notFound();
  return access;
}
