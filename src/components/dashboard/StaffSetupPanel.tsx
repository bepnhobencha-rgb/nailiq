"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  addStaff,
  deleteStaff,
  updateStaff,
  type StaffJobRole,
} from "@/shared/dashboard/setupActions";

export type SetupStaffRow = {
  id: string;
  name: string;
  job_role: StaffJobRole;
};

const ROLE_OPTIONS: { value: StaffJobRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "senior", label: "Senior" },
  { value: "nail_tech", label: "Nail Tech" },
];

export function StaffSetupPanel({
  slug,
  initialRows,
}: {
  slug: string;
  initialRows: SetupStaffRow[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [draftName, setDraftName] = useState("");
  const [draftRole, setDraftRole] = useState<StaffJobRole>("nail_tech");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server list after refresh
    setRows(initialRows);
  }, [initialRows]);

  const refresh = useCallback(() => router.refresh(), [router]);

  const handleUpdate = useCallback(
    async (
      staffId: string,
      patch: Partial<Pick<SetupStaffRow, "name" | "job_role">>,
    ) => {
      setFormError(null);
      setPendingId(staffId);
      const res = await updateStaff(slug, staffId, {
        name: patch.name,
        role: patch.job_role,
      });
      setPendingId(null);
      if (!res.ok) {
        setFormError("Could not save changes. Try again.");
        return;
      }
      setRows((prev) =>
        prev.map((r) =>
          r.id === staffId ? { ...r, ...patch } : r,
        ),
      );
      refresh();
    },
    [refresh, slug],
  );

  const handleDelete = useCallback(
    async (staffId: string) => {
      if (!window.confirm("Remove this staff member from the list?")) {
        return;
      }
      setFormError(null);
      setPendingId(staffId);
      const res = await deleteStaff(slug, staffId);
      setPendingId(null);
      if (!res.ok) {
        if (res.error === "minimum_staff") {
          setFormError("You need more than one staff member before you can remove someone.");
        } else if (res.error === "in_use") {
          setFormError("This staff member is linked to bookings and can’t be removed yet.");
        } else {
          setFormError("Could not remove. Try again.");
        }
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== staffId));
      refresh();
    },
    [refresh, slug],
  );

  const onAdd = useCallback(async () => {
    setAddError(null);
    if (!draftName.trim()) {
      setAddError("Enter a name.");
      return;
    }
    setAdding(true);
    const res = await addStaff(slug, {
      name: draftName.trim(),
      role: draftRole,
    });
    setAdding(false);
    if (!res.ok) {
      setAddError("Could not add staff. Try again.");
      return;
    }
    setDraftName("");
    setDraftRole("nail_tech");
    refresh();
  }, [draftName, draftRole, refresh, slug]);

  return (
    <div className="flex flex-col gap-4">
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
            <StaffRowFields
              row={row}
              disabled={pendingId === row.id}
              onBlurSave={(partial) => {
                void handleUpdate(row.id, partial);
              }}
              onDelete={() => {
                void handleDelete(row.id);
              }}
              canDelete={rows.length > 1}
            />
          </li>
        ))}
      </ul>

      <section
        aria-label="Add staff"
        className="rounded-2xl border border-nq-primary/35 bg-nq-bg/85 p-4"
      >
        <h2 className="text-base font-semibold text-nq-foreground">Add staff</h2>
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
              disabled={adding}
              onChange={(e) => {
                setDraftName(e.target.value);
              }}
            />
          </label>
          <label className="block text-sm font-medium text-nq-muted">
            Role
            <select
              className="mt-1.5 flex min-h-[44px] w-full appearance-none rounded-xl border border-nq-border/50 bg-nq-bg/90 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus"
              value={draftRole}
              disabled={adding}
              onChange={(e) => {
                setDraftRole(e.target.value as StaffJobRole);
              }}
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="primary"
            size="lg"
            className="min-h-11 w-full touch-manipulation"
            disabled={adding || !draftName.trim()}
            onClick={() => {
              void onAdd();
            }}
          >
            {adding ? "Saving…" : "Add staff"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function StaffRowFields({
  row,
  disabled,
  onBlurSave,
  onDelete,
  canDelete,
}: {
  row: SetupStaffRow;
  disabled: boolean;
  onBlurSave: (
    patch: Partial<Pick<SetupStaffRow, "name" | "job_role">>,
  ) => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const [name, setName] = useState(row.name);
  const [role, setRole] = useState<StaffJobRole>(row.job_role);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- row props after save / refresh
    setName(row.name);
    setRole(row.job_role);
  }, [row]);

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
          Role
          <select
            className="mt-1.5 flex min-h-[44px] w-full appearance-none rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none focus-visible:border-nq-primary/75 focus-visible:shadow-nq-input-focus disabled:opacity-60"
            value={role}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value as StaffJobRole;
              setRole(v);
              if (v !== row.job_role) onBlurSave({ job_role: v });
            }}
          >
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Button
        type="button"
        variant="secondary"
        className="min-h-11 w-full touch-manipulation sm:w-auto sm:self-start"
        disabled={disabled || !canDelete}
        onClick={onDelete}
      >
        Remove staff
      </Button>
    </div>
  );
}
