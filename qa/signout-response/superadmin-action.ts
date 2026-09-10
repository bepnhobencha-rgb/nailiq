"use server";
import { redirect } from "next/navigation";
import type { SignOutResult } from "@/shared/auth/signOutResponse";
export async function signOutSuperadminAction(): Promise<SignOutResult> { redirect("/superadmin/login"); }
