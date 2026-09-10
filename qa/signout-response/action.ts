"use server";
import { redirect } from "next/navigation";
import type { SignOutResult } from "@/shared/auth/signOutResponse";
// Inert fixture: no Auth, credentials, provider or database access.
export async function signOutAction(): Promise<SignOutResult> { redirect("/login"); }
