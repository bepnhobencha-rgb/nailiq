"use client";

import { useState } from "react";
import { UrlInputForm } from "./UrlInputForm";
import { ProgressTracker } from "./ProgressTracker";
import type { ImportJob } from "@/shared/import/types";

type Props = {
  slug: string;
  initialJob?: ImportJob | null;
};

export function ImportFromWebsite({ slug, initialJob }: Props) {
  const resumeable =
    initialJob &&
    initialJob.status !== "done" &&
    initialJob.status !== "failed";

  const [jobId, setJobId] = useState<string | null>(resumeable ? initialJob.id : null);
  const [done, setDone] = useState(initialJob?.status === "done");

  function handleDone(job: ImportJob) {
    if (job.status === "done") setDone(true);
  }

  return (
    <div className="rounded-xl border border-[#3f3f46] bg-[#18181b] p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Import from Website</h2>
        <p className="text-sm text-[#a1a1aa] mt-1">
          Automatically populate your NailIQ page from your existing salon website.
        </p>
      </div>

      {!jobId ? (
        <UrlInputForm slug={slug} onJobCreated={setJobId} />
      ) : (
        <ProgressTracker jobId={jobId} slug={slug} onDone={handleDone} />
      )}

      {done && (
        <button
          onClick={() => { setJobId(null); setDone(false); }}
          className="text-sm text-[#71717a] hover:text-white transition-colors"
        >
          Import another URL
        </button>
      )}
    </div>
  );
}
