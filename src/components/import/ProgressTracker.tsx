"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/shared/lib/supabase/client";
import type { ImportJob, ImportJobStatus } from "@/shared/import/types";
import { IMPORT_STATUS_LABELS, IMPORT_STATUS_STEPS } from "@/shared/import/types";

type Props = {
  jobId: string;
  slug: string;
  onDone?: (job: ImportJob) => void;
};

const STEP_ICONS: Record<ImportJobStatus, string> = {
  pending: "○",
  scraping: "⟳",
  extracting: "⟳",
  building: "⟳",
  done: "✓",
  failed: "✗",
};

export function ProgressTracker({ jobId, slug, onDone }: Props) {
  const [job, setJob] = useState<ImportJob | null>(null);

  useEffect(() => {
    const db = createClient();

    // Initial fetch
    db.from("website_import_jobs")
      .select("*")
      .eq("id", jobId)
      .single()
      .then(({ data }) => {
        if (data) {
          setJob(data as ImportJob);
          if ((data as ImportJob).status === "done" || (data as ImportJob).status === "failed") {
            onDone?.(data as ImportJob);
          }
        }
      });

    // Realtime subscription
    const channel = db
      .channel(`import-job-${jobId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "website_import_jobs",
          filter: `id=eq.${jobId}`,
        },
        (payload) => {
          const updated = payload.new as ImportJob;
          setJob(updated);
          if (updated.status === "done" || updated.status === "failed") {
            onDone?.(updated);
          }
        },
      )
      .subscribe();

    return () => {
      db.removeChannel(channel);
    };
  }, [jobId, onDone]);

  if (!job) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-4 bg-[#27272a] rounded w-48" />
        <div className="h-2 bg-[#27272a] rounded w-full" />
      </div>
    );
  }

  const isFailed = job.status === "failed";
  const isDone = job.status === "done";
  const currentStepIndex = IMPORT_STATUS_STEPS.indexOf(job.status);

  return (
    <div className="space-y-5">
      {/* Progress bar */}
      <div>
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-medium text-white">
            {IMPORT_STATUS_LABELS[job.status]}
          </span>
          <span className="text-sm text-[#a1a1aa]">{job.progress}%</span>
        </div>
        <div className="w-full h-2 bg-[#27272a] rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              isFailed
                ? "bg-red-500"
                : isDone
                  ? "bg-green-500"
                  : "bg-[#D4AF37]"
            }`}
            style={{ width: `${job.progress}%` }}
          />
        </div>
      </div>

      {/* Steps */}
      <ol className="space-y-2">
        {IMPORT_STATUS_STEPS.filter((s) => s !== "pending").map((step, i) => {
          const stepIndex = IMPORT_STATUS_STEPS.indexOf(step);
          const done = currentStepIndex > stepIndex || isDone;
          const active = IMPORT_STATUS_STEPS[currentStepIndex] === step && !isDone;

          return (
            <li
              key={step}
              className={`flex items-center gap-3 text-sm transition-colors ${
                isFailed && active
                  ? "text-red-400"
                  : done
                    ? "text-green-400"
                    : active
                      ? "text-white"
                      : "text-[#52525b]"
              }`}
            >
              <span className={`w-5 text-center ${active && !isFailed ? "animate-spin inline-block" : ""}`}>
                {isFailed && active
                  ? STEP_ICONS.failed
                  : done
                    ? STEP_ICONS.done
                    : active
                      ? STEP_ICONS.scraping
                      : STEP_ICONS.pending}
              </span>
              {IMPORT_STATUS_LABELS[step]}
            </li>
          );
        })}
      </ol>

      {/* Error */}
      {isFailed && job.error_message && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 text-sm text-red-300">
          {job.error_message}
        </div>
      )}

      {/* Done summary */}
      {isDone && job.result && (
        <div className="rounded-lg border border-green-900/50 bg-green-950/30 p-4 space-y-1 text-sm text-green-300">
          <p className="font-semibold text-green-200">Import complete!</p>
          <p>{job.result.servicesImported} service{job.result.servicesImported !== 1 ? "s" : ""} imported</p>
          <p>{job.result.imagesDownloaded} image{job.result.imagesDownloaded !== 1 ? "s" : ""} downloaded</p>
          <a
            href={`/dashboard/${slug}/settings/my-page`}
            className="inline-block mt-2 text-[#D4AF37] hover:underline font-medium"
          >
            Review your page →
          </a>
        </div>
      )}
    </div>
  );
}
