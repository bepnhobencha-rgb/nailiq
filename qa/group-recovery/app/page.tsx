import GroupReplacementAccept from "@/app/booking/replace/_components/GroupReplacementAccept";
import { GroupReplacementOptions } from "@/components/booking/GroupReplacementOptions";
import { loadGroupReplacementPreview } from "../actions";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ mode?: string; lang?: string }> }) {
  const params = await searchParams;
  const language = params.lang === "vi" ? "vi" : "en";
  const token = "a".repeat(64);
  const memberFixture = "00000000-0000-4000-8000-000000000001";
  return <main className="mx-auto max-w-lg bg-nq-bg p-4 text-nq-text">{params.mode === "sender" ? <GroupReplacementOptions token={memberFixture} language={language} /> : <GroupReplacementAccept token={token} language={language} preview={await loadGroupReplacementPreview(token)} />}</main>;
}
