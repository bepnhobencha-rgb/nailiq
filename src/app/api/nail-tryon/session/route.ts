import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { nailTryOnDeletionPaths } from "@/shared/nailTryOn/deletion";
import { TRYON_COOKIE } from "@/shared/nailTryOn/server";
import { verifySessionCredential } from "@/shared/nailTryOn/sessionCredential";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ sessionId: z.string().uuid() });

type SessionRow = {
  id: string;
  salon_id: string;
  anonymous_token_hash: string;
  source_image_path: string;
  result_image_path: string | null;
};

export async function DELETE(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = createServiceRoleClient();
  const { data: rawSession } = await db
    .from("nail_tryon_sessions" as never)
    .select("id, salon_id, anonymous_token_hash, source_image_path, result_image_path")
    .eq("id", parsed.data.sessionId)
    .maybeSingle();
  const session = rawSession as unknown as SessionRow | null;
  const cookieStore = await cookies();
  const credential = cookieStore.get(TRYON_COOKIE)?.value;

  if (
    !session ||
    !verifySessionCredential(credential, session.id, session.anonymous_token_hash)
  ) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const paths = nailTryOnDeletionPaths({
    salonId: session.salon_id,
    sessionId: session.id,
    sourceImagePath: session.source_image_path,
    resultImagePath: session.result_image_path,
  });
  const deletedAt = new Date().toISOString();

  // Lock the session before touching Storage so an in-flight generation cannot
  // publish a late result. The generation route uses a matching status guard.
  const { error: updateError } = await db
    .from("nail_tryon_sessions" as never)
    .update({
      status: "deleted",
      deleted_at: deletedAt,
      result_image_path: null,
      error_code: null,
      updated_at: deletedAt,
    } as never)
    .eq("id", session.id);
  if (updateError) {
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }

  // Durable backstop first; the hourly cleanup worker retries any Storage
  // failure. This also covers a preview that finishes during this request.
  const { error: queueError } = await db
    .from("nail_tryon_cleanup_queue" as never)
    .upsert(
      paths.map((objectPath) => ({
        tryon_session_id: session.id,
        object_path: objectPath,
      })) as never,
      {
        onConflict: "tryon_session_id,object_path",
        ignoreDuplicates: true,
      },
    );

  const { error: removeError } = await db.storage
    .from("nail-tryon")
    .remove(paths);

  if (!removeError) {
    await db
      .from("nail_tryon_cleanup_queue" as never)
      .update({ processed_at: deletedAt, last_error: null } as never)
      .eq("tryon_session_id", session.id)
      .in("object_path", paths);
  }

  if (removeError && queueError) {
    // Keep the bearer cookie so the customer can retry the deletion request.
    return NextResponse.json({ error: "delete_retry_required" }, { status: 503 });
  }

  const response = NextResponse.json(
    { ok: true, deletion: removeError ? "queued" : "complete" },
    { status: removeError ? 202 : 200 },
  );
  response.cookies.delete(TRYON_COOKIE);
  return response;
}
