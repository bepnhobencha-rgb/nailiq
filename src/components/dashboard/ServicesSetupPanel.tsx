"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SaveButton, type SaveButtonStatus } from "@/components/ui/SaveButton";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import { SetupDeleteConfirm } from "@/components/dashboard/SetupDeleteConfirm";
import {
  addService,
  deleteService,
  updateService,
} from "@/shared/dashboard/setupActions";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export type SetupServiceRow = {
  id: string;
  name: string;
  price_cents: number;
  duration_minutes: number;
  buffer_minutes: number;
};

function centsFromDollarsString(raw: string): number | null {
  const normalized = raw.replace(/[^0-9.]/g, "");
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function dollarsFromCents(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

const TOAST_ERR = "✗ Could not save. Check your connection.";

export function ServicesSetupPanel({
  slug,
  initialRows,
}: {
  slug: string;
  initialRows: SetupServiceRow[];
}) {
  const { language } = useUserLanguage();
  const setupErrors = getUserMessages(language).setupErrors;
  const router = useRouter();
  const [rows, setRows] = useState<SetupServiceRow[]>(initialRows);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaveStatus, setAddSaveStatus] = useState<SaveButtonStatus>("idle");
  const [toast, setToast] = useState<SetupToastPayload | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const addStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [draftName, setDraftName] = useState("");
  const [draftPrice, setDraftPrice] = useState("");
  const [draftDur, setDraftDur] = useState("45");
  const [draftBuf, setDraftBuf] = useState("10");

  const clearAddStatusTimer = useCallback(() => {
    if (addStatusTimerRef.current !== null) {
      clearTimeout(addStatusTimerRef.current);
      addStatusTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearAddStatusTimer();
    },
    [clearAddStatusTimer],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server list after refresh
    setRows(initialRows);
  }, [initialRows]);

  const refresh = useCallback(() => router.refresh(), [router]);

  const handleUpdate = useCallback(
    async (
      serviceId: string,
      patch: Partial<
        Pick<
          SetupServiceRow,
          "name" | "price_cents" | "duration_minutes" | "buffer_minutes"
        >
      >,
    ) => {
      setFormError(null);
      setPendingId(serviceId);
      const res = await updateService(slug, serviceId, patch);
      setPendingId(null);
      if (!res.ok) {
        setFormError(mapUpdateError(res.error));
        setToast({ variant: "error", message: TOAST_ERR });
        return;
      }
      setRows((prev) =>
        prev.map((r) =>
          r.id === serviceId
            ? {
                ...r,
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                ...(patch.price_cents !== undefined
                  ? { price_cents: patch.price_cents }
                  : {}),
                ...(patch.duration_minutes !== undefined
                  ? { duration_minutes: patch.duration_minutes }
                  : {}),
                ...(patch.buffer_minutes !== undefined
                  ? { buffer_minutes: patch.buffer_minutes }
                  : {}),
              }
            : r,
        ),
      );
      setToast({ variant: "success", message: "✓ Service saved" });
      refresh();
    },
    [refresh, slug],
  );

  const handleDelete = useCallback(
    async (serviceId: string) => {
      setFormError(null);
      setConfirmDeleteId(null);
      setPendingId(serviceId);
      const res = await deleteService(slug, serviceId);
      setPendingId(null);
      if (!res.ok) {
        setFormError(mapDeleteError(res.error, setupErrors));
        setToast({ variant: "error", message: TOAST_ERR });
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== serviceId));
      setToast({ variant: "success", message: "✓ Service removed" });
      refresh();
    },
    [refresh, setupErrors, slug],
  );

  const onAdd = useCallback(async () => {
    setAddError(null);
    const cents = centsFromDollarsString(draftPrice);
    if (!draftName.trim()) {
      setAddError("Enter a service name.");
      return;
    }
    if (cents === null) {
      setAddError("Enter a valid price.");
      return;
    }
    const dm = Number.parseInt(draftDur, 10);
    const bm = Number.parseInt(draftBuf, 10);
    if (!Number.isFinite(dm) || dm < 1) {
      setAddError("Duration must be at least 1 minute.");
      return;
    }
    if (!Number.isFinite(bm) || bm < 0) {
      setAddError("Buffer must be 0 or more minutes.");
      return;
    }

    clearAddStatusTimer();
    setAddSaveStatus("saving");
    const res = await addService(slug, {
      name: draftName.trim(),
      price_cents: cents,
      duration_minutes: dm,
      buffer_minutes: bm,
    });
    if (!res.ok) {
      setAddSaveStatus("error");
      setToast({ variant: "error", message: TOAST_ERR });
      addStatusTimerRef.current = setTimeout(() => setAddSaveStatus("idle"), 3000);
      return;
    }
    setAddSaveStatus("saved");
    setToast({ variant: "success", message: "✓ Service saved" });
    addStatusTimerRef.current = setTimeout(() => setAddSaveStatus("idle"), 2000);
    setDraftName("");
    setDraftPrice("");
    setDraftDur("45");
    setDraftBuf("10");
    refresh();
  }, [
    clearAddStatusTimer,
    draftBuf,
    draftDur,
    draftName,
    draftPrice,
    refresh,
    slug,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <SetupToast toast={toast} onDismiss={() => setToast(null)} />

      {formError ? (
        <p className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          {formError}
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-4"
          >
            <ServiceRowFields
              row={row}
              disabled={pendingId === row.id}
              confirmingDelete={confirmDeleteId === row.id}
              onBeginDelete={() => {
                setConfirmDeleteId(row.id);
              }}
              onCancelDelete={() => {
                setConfirmDeleteId(null);
              }}
              onConfirmDelete={() => {
                void handleDelete(row.id);
              }}
              onBlurSave={(partial) => {
                void handleUpdate(row.id, partial);
              }}
              canDelete={rows.length > 1}
            />
          </li>
        ))}
      </ul>

      <section
        aria-label="Add service"
        className="rounded-2xl border border-nq-primary/35 bg-nq-bg/85 p-4"
      >
        <h2 className="text-base font-semibold text-nq-foreground">
          Add service
        </h2>
        {addError ? (
          <p className="mt-2 text-sm text-nq-error" role="alert">
            {addError}
          </p>
        ) : null}
        <div className="mt-3 flex flex-col gap-3">
          <label className="block text-sm font-medium text-nq-muted">
            Name
            <input
              className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
              value={draftName}
              disabled={addSaveStatus === "saving"}
              onChange={(e) => {
                setDraftName(e.target.value);
              }}
              placeholder="e.g. Acrylic full set"
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-nq-muted">
              Price (USD)
              <input
                inputMode="decimal"
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
                value={draftPrice}
                disabled={addSaveStatus === "saving"}
                onChange={(e) => {
                  setDraftPrice(e.target.value);
                }}
                placeholder="45.00"
              />
            </label>
            <label className="block text-sm font-medium text-nq-muted">
              Duration (min)
              <input
                inputMode="numeric"
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
                value={draftDur}
                disabled={addSaveStatus === "saving"}
                onChange={(e) => {
                  setDraftDur(e.target.value);
                }}
              />
            </label>
            <label className="block text-sm font-medium text-nq-muted sm:col-span-2">
              Buffer (min)
              <input
                inputMode="numeric"
                className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
                value={draftBuf}
                disabled={addSaveStatus === "saving"}
                onChange={(e) => {
                  setDraftBuf(e.target.value);
                }}
              />
            </label>
          </div>
          <SaveButton
            status={addSaveStatus}
            onSave={() => {
              void onAdd();
            }}
            idleLabel="Add service"
            savedLabel="✓ Saved"
            disabled={
              addSaveStatus === "saving" ||
              !draftName.trim() ||
              centsFromDollarsString(draftPrice) === null
            }
            className="min-h-11 w-full"
          />
        </div>
      </section>
    </div>
  );
}

function ServiceRowFields({
  row,
  disabled,
  confirmingDelete,
  onBeginDelete,
  onCancelDelete,
  onConfirmDelete,
  onBlurSave,
  canDelete,
}: {
  row: SetupServiceRow;
  disabled: boolean;
  confirmingDelete: boolean;
  onBeginDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onBlurSave: (
    patch: Partial<
      Pick<
        SetupServiceRow,
        "name" | "price_cents" | "duration_minutes" | "buffer_minutes"
      >
    >,
  ) => void;
  canDelete: boolean;
}) {
  const [name, setName] = useState(row.name);
  const [price, setPrice] = useState(dollarsFromCents(row.price_cents));
  const [dur, setDur] = useState(String(row.duration_minutes));
  const [buf, setBuf] = useState(String(row.buffer_minutes));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- row props after save / refresh
    setName(row.name);
    setPrice(dollarsFromCents(row.price_cents));
    setDur(String(row.duration_minutes));
    setBuf(String(row.buffer_minutes));
  }, [row]);

  if (confirmingDelete) {
    return (
      <SetupDeleteConfirm
        title={`Delete ${row.name}?`}
        onCancel={onCancelDelete}
        onConfirm={onConfirmDelete}
        busy={disabled}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-nq-muted">
          Name
          <input
            className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={name}
            disabled={disabled}
            onChange={(e) => {
              setName(e.target.value);
            }}
            onBlur={() => {
              const t = name.trim();
              if (t && t !== row.name) onBlurSave({ name: t });
            }}
          />
        </label>
        <label className="block text-sm font-medium text-nq-muted">
          Price (USD)
          <input
            inputMode="decimal"
            className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={price}
            disabled={disabled}
            onChange={(e) => {
              setPrice(e.target.value);
            }}
            onBlur={() => {
              const c = centsFromDollarsString(price);
              if (c !== null && c !== row.price_cents) onBlurSave({ price_cents: c });
            }}
          />
        </label>
        <label className="block text-sm font-medium text-nq-muted">
          Duration (min)
          <input
            inputMode="numeric"
            className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={dur}
            disabled={disabled}
            onChange={(e) => {
              setDur(e.target.value);
            }}
            onBlur={() => {
              const n = Number.parseInt(dur, 10);
              if (
                Number.isFinite(n) &&
                n >= 1 &&
                n !== row.duration_minutes
              )
                onBlurSave({ duration_minutes: n });
            }}
          />
        </label>
        <label className="block text-sm font-medium text-nq-muted">
          Buffer (min)
          <input
            inputMode="numeric"
            className="mt-1.5 flex min-h-[44px] w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base tabular-nums text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={buf}
            disabled={disabled}
            onChange={(e) => {
              setBuf(e.target.value);
            }}
            onBlur={() => {
              const n = Number.parseInt(buf, 10);
              if (Number.isFinite(n) && n >= 0 && n !== row.buffer_minutes)
                onBlurSave({ buffer_minutes: n });
            }}
          />
        </label>
      </div>
      <Button
        type="button"
        variant="secondary"
        className="min-h-11 w-full touch-manipulation sm:w-auto sm:self-start"
        disabled={disabled || !canDelete}
        onClick={onBeginDelete}
      >
        Delete service
      </Button>
    </div>
  );
}

function mapUpdateError(code: string): string {
  if (code === "invalid_name") return "Fix the name and try again.";
  if (code === "not_found") return "Could not update that row.";
  return "Could not save. Try again.";
}

function mapDeleteError(
  code: string,
  setupErrors: { serviceInUse: string },
): string {
  if (code === "minimum_services")
    return "You need more than one service before you can delete.";
  if (code === "service_in_use" || code === "in_use")
    return setupErrors.serviceInUse;
  return "Could not delete. Try again.";
}
