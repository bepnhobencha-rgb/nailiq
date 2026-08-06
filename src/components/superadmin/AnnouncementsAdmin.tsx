"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { cn } from "@/shared/lib/cn";
import {
  createAnnouncement,
  deleteAnnouncement,
  updateAnnouncementPublish,
} from "@/shared/superadmin/announcementsActions";
import {
  ANNOUNCEMENT_SEVERITIES,
  ANNOUNCEMENT_TARGETS,
  type AnnouncementSeverity,
  type AnnouncementTarget,
  type PlatformAnnouncement,
} from "@/shared/superadmin/announcementsTypes";

const SEVERITY_BADGE: Record<AnnouncementSeverity, string> = {
  info: "border-sky-500/55 bg-sky-400/15 text-sky-700",
  warning: "border-amber-500/55 bg-amber-400/15 text-amber-700",
  urgent: "border-nq-error/55 bg-nq-error/15 text-nq-error",
};

const TARGET_LABEL: Record<AnnouncementTarget, string> = {
  all: "Everyone",
  owners: "Owners only",
  staff: "Staff only",
  superadmins: "Superadmins only",
};

/**
 * Phase 1F — platform announcements admin (minimal).
 *
 * Scope: list, create, publish/unpublish, delete. Published announcements
 * are rendered by the shared salon Dashboard layout for the selected audience.
 *
 * Server actions are gated to `founder | ops_admin` per
 * PERMISSION_MATRIX §8.6.
 */
export function AnnouncementsAdmin({
  initial,
}: {
  initial: PlatformAnnouncement[];
}) {
  const router = useRouter();
  const [items, setItems] = useState<PlatformAnnouncement[]>(initial);
  const [showCreate, setShowCreate] = useState(false);

  function refresh() {
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-nq-muted">
          Broadcast messages to owners/staff/superadmins. Drafts stay
          hidden until published. Hard expires at <code>expires_at</code>{" "}
          if set.
        </p>
        {!showCreate ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => setShowCreate(true)}
            data-testid="announcements-create-open"
          >
            New announcement
          </Button>
        ) : null}
      </div>

      {showCreate ? (
        <CreateAnnouncementForm
          onCreated={(row) => {
            setItems((cur) => [row, ...cur]);
            setShowCreate(false);
            refresh();
          }}
          onCancel={() => setShowCreate(false)}
        />
      ) : null}

      {items.length === 0 ? (
        <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 px-5 py-8 text-center text-sm text-nq-muted">
          No announcements yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((a) => (
            <AnnouncementRow
              key={a.id}
              announcement={a}
              onChange={(next) => {
                setItems((cur) =>
                  cur.map((item) => (item.id === next.id ? next : item)),
                );
                refresh();
              }}
              onDelete={() => {
                setItems((cur) => cur.filter((item) => item.id !== a.id));
                refresh();
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateAnnouncementForm({
  onCreated,
  onCancel,
}: {
  onCreated: (row: PlatformAnnouncement) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<AnnouncementSeverity>("info");
  const [target, setTarget] = useState<AnnouncementTarget>("all");
  const [publishNow, setPublishNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (title.trim().length === 0 || body.trim().length === 0) {
      setError("Title and body are both required.");
      return;
    }
    startTransition(async () => {
      const publishedAt = publishNow ? new Date().toISOString() : null;
      const result = await createAnnouncement({
        title: title.trim(),
        body: body.trim(),
        severity,
        target,
        publishedAt,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Optimistic row — caller will router.refresh() to pull canonical.
      onCreated({
        id: result.id,
        title: title.trim(),
        body: body.trim(),
        severity,
        target,
        publishedAt,
        expiresAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      data-testid="announcements-create-form"
      className="flex flex-col gap-3 rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5"
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-nq-muted">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={120}
          autoFocus
          className="rounded-lg border border-nq-border/50 bg-nq-bg/85 px-3 py-2 text-sm text-nq-foreground outline-none focus-visible:border-nq-primary/80"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-nq-muted">Body</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          rows={3}
          maxLength={2_000}
          className="rounded-lg border border-nq-border/50 bg-nq-bg/85 px-3 py-2 text-sm text-nq-foreground outline-none focus-visible:border-nq-primary/80"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-nq-muted">Severity</span>
          <select
            value={severity}
            onChange={(e) =>
              setSeverity(e.target.value as AnnouncementSeverity)
            }
            className="rounded-lg border border-nq-border/50 bg-nq-bg/85 px-3 py-2 text-sm text-nq-foreground"
          >
            {ANNOUNCEMENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-nq-muted">Audience</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as AnnouncementTarget)}
            className="rounded-lg border border-nq-border/50 bg-nq-bg/85 px-3 py-2 text-sm text-nq-foreground"
          >
            {ANNOUNCEMENT_TARGETS.map((t) => (
              <option key={t} value={t}>
                {TARGET_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs text-nq-muted">
        <input
          type="checkbox"
          checked={publishNow}
          onChange={(e) => setPublishNow(e.target.checked)}
          className="size-4 accent-nq-primary"
        />
        Publish immediately (otherwise saves as draft)
      </label>

      {error ? (
        <p role="alert" className="text-xs text-nq-error">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={pending}
          data-testid="announcements-create-submit"
        >
          {pending ? "Saving…" : publishNow ? "Save + publish" : "Save draft"}
        </Button>
      </div>
    </form>
  );
}

function AnnouncementRow({
  announcement,
  onChange,
  onDelete,
}: {
  announcement: PlatformAnnouncement;
  onChange: (next: PlatformAnnouncement) => void;
  onDelete: () => void;
}) {
  const [pendingPublish, startPublishTransition] = useTransition();
  const [pendingDelete, startDeleteTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isPublished = announcement.publishedAt !== null;

  function togglePublish() {
    setError(null);
    startPublishTransition(async () => {
      const result = await updateAnnouncementPublish({
        id: announcement.id,
        publishedAt: isPublished ? null : new Date().toISOString(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onChange({
        ...announcement,
        publishedAt: isPublished ? null : new Date().toISOString(),
      });
    });
  }

  function onDeleteClick() {
    const confirmed = window.confirm(
      `Delete "${announcement.title}"?\n\nThis is a hard delete. The audit log preserves the trail.`,
    );
    if (!confirmed) return;
    setError(null);
    startDeleteTransition(async () => {
      const result = await deleteAnnouncement(announcement.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDelete();
    });
  }

  return (
    <article
      data-testid={`announcement-${announcement.id}`}
      className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold tracking-tight text-nq-foreground">
              {announcement.title}
            </h3>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                SEVERITY_BADGE[announcement.severity],
              )}
            >
              {announcement.severity}
            </span>
            <span className="rounded-full border border-nq-border/45 bg-nq-bg/45 px-2 py-0.5 text-[10px] uppercase tracking-wide text-nq-muted">
              {TARGET_LABEL[announcement.target]}
            </span>
            {isPublished ? (
              <span className="rounded-full border border-nq-success/45 bg-nq-success/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-nq-success">
                Published
              </span>
            ) : (
              <span className="rounded-full border border-nq-muted/45 bg-nq-bg/45 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-nq-muted">
                Draft
              </span>
            )}
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-nq-muted">
            {announcement.body}
          </p>
        </div>
      </header>

      <footer className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-nq-muted/80">
          Created{" "}
          {new Date(announcement.createdAt).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {error ? (
            <span className="text-xs text-nq-error">Error: {error}</span>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pendingPublish || pendingDelete}
            onClick={togglePublish}
            data-testid={`announcement-${announcement.id}-toggle`}
          >
            {pendingPublish ? "Saving…" : isPublished ? "Unpublish" : "Publish"}
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={pendingPublish || pendingDelete}
            onClick={onDeleteClick}
            data-testid={`announcement-${announcement.id}-delete`}
          >
            {pendingDelete ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </footer>
    </article>
  );
}
