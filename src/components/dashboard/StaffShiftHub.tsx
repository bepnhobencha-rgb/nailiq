"use client";

import { useEffect, useState, useTransition } from "react";
import {
  listActiveStaff,
  listStaffShifts,
  upsertStaffShift,
  deleteStaffShift,
  listStaffUnavailability,
  upsertStaffUnavailability,
  deleteStaffUnavailability,
  type StaffSummary,
  type StaffShiftRow,
  type StaffUnavailabilityRow,
} from "@/shared/dashboard/staffShiftActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type Props = {
  slug: string;
};

const DAYS = [
  { key: "mon", en: "Mon", vi: "T2" },
  { key: "tue", en: "Tue", vi: "T3" },
  { key: "wed", en: "Wed", vi: "T4" },
  { key: "thu", en: "Thu", vi: "T5" },
  { key: "fri", en: "Fri", vi: "T6" },
  { key: "sat", en: "Sat", vi: "T7" },
  { key: "sun", en: "Sun", vi: "CN" },
] as const;

type DayKey = (typeof DAYS)[number]["key"];

// ─── Inline editor for a single day cell ─────────────────────────────────────

function ShiftCell({
  slug,
  staffId,
  dayKey,
  shift,
  onSave,
  onDelete,
}: {
  slug: string;
  staffId: string;
  dayKey: DayKey;
  shift: StaffShiftRow | undefined;
  onSave: (updated: StaffShiftRow) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(shift?.start_time ?? "09:00");
  const [end, setEnd] = useState(shift?.end_time ?? "17:00");
  const [pending, startTx] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function handleEdit() {
    setStart(shift?.start_time ?? "09:00");
    setEnd(shift?.end_time ?? "17:00");
    setErr(null);
    setEditing(true);
  }

  function handleSave() {
    if (start >= end) { setErr("Start must be before end"); return; }
    startTx(async () => {
      const r = await upsertStaffShift(slug, staffId, dayKey, start, end);
      if (r.ok && r.id) {
        onSave({ id: r.id, staff_id: staffId, day_of_week: dayKey, start_time: start, end_time: end, is_active: true });
        setEditing(false);
        setErr(null);
      } else {
        setErr(r.error ?? "error");
      }
    });
  }

  function handleDelete() {
    if (!shift) return;
    startTx(async () => {
      const r = await deleteStaffShift(slug, shift.id);
      if (r.ok) onDelete(shift.id);
      else setErr(r.error ?? "error");
    });
  }

  if (editing) {
    return (
      <td className="p-1 align-middle">
        <div className="flex flex-col gap-1 min-w-[100px]">
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-full rounded border border-nq-border bg-nq-bg px-1.5 py-0.5 text-xs"
            disabled={pending}
          />
          <input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-full rounded border border-nq-border bg-nq-bg px-1.5 py-0.5 text-xs"
            disabled={pending}
          />
          {err && <p className="text-[10px] text-nq-error">{err}</p>}
          <div className="flex gap-1">
            <button
              onClick={handleSave}
              disabled={pending}
              className="flex-1 rounded bg-nq-primary px-1.5 py-0.5 text-[10px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={pending}
              className="rounded px-1.5 py-0.5 text-[10px] text-nq-muted-foreground hover:text-nq-foreground"
            >
              ✕
            </button>
          </div>
        </div>
      </td>
    );
  }

  if (shift) {
    return (
      <td className="p-1 align-middle text-center">
        <button
          onClick={handleEdit}
          className="group relative inline-flex flex-col items-center rounded px-2 py-1 text-[11px] hover:bg-nq-muted/30"
        >
          <span className="font-medium text-nq-foreground">{shift.start_time}</span>
          <span className="text-nq-muted-foreground">–</span>
          <span className="font-medium text-nq-foreground">{shift.end_time}</span>
          <span
            onClick={(e) => { e.stopPropagation(); handleDelete(); }}
            className="absolute -right-1 -top-1 hidden rounded-full bg-nq-error/80 px-1 text-[9px] text-white group-hover:inline"
            title="Remove shift"
          >
            ✕
          </span>
        </button>
      </td>
    );
  }

  return (
    <td className="p-1 align-middle text-center">
      <button
        onClick={handleEdit}
        className="rounded px-2 py-1 text-[11px] text-nq-muted-foreground hover:bg-nq-muted/30 hover:text-nq-foreground"
        title="Add shift"
      >
        +
      </button>
    </td>
  );
}

// ─── Unavailability row ──────────────────────────────────────────────────────

function UnavailabilitySection({
  slug,
  staff,
}: {
  slug: string;
  staff: StaffSummary[];
}) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [rows, setRows] = useState<StaffUnavailabilityRow[]>([]);
  // Which salon the rows belong to. Loading is derived from this rather than
  // held as its own state, so switching slug shows the spinner again without
  // an effect that has to reset a flag.
  const [loadedSlug, setLoadedSlug] = useState<string | null>(null);
  const loading = loadedSlug !== slug;
  const [staffId, setStaffId] = useState(staff[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTx] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Show next 60 days of unavailability
      const today = new Date().toISOString().slice(0, 10);
      const future = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
      const r = await listStaffUnavailability(slug, today, future);
      if (cancelled) return;
      if (r.ok) setRows(r.data ?? []);
      setLoadedSlug(slug);
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  function handleAdd() {
    if (!staffId || !date) { setErr("Select staff and date"); return; }
    setErr(null);
    startTx(async () => {
      const r = await upsertStaffUnavailability(slug, staffId, date, reason || undefined);
      if (r.ok && r.id) {
        const newId = r.id;
        setRows((prev) => [...prev.filter((x) => !(x.staff_id === staffId && x.date === date)), { id: newId, staff_id: staffId, date, reason: reason || null }]);
        setDate("");
        setReason("");
      } else {
        setErr(r.error ?? "error");
      }
    });
  }

  function handleRemove(id: string) {
    startTx(async () => {
      const r = await deleteStaffUnavailability(slug, id);
      if (r.ok) setRows((prev) => prev.filter((x) => x.id !== id));
    });
  }

  const staffMap = Object.fromEntries(staff.map((s) => [s.id, s.name]));

  return (
    <div className="mt-6">
      <h4 className="mb-2 text-sm font-semibold text-nq-foreground">
        {vi ? "Ngày nghỉ lẻ" : "Day-off / Unavailability"}
      </h4>
      <p className="mb-3 text-xs text-nq-muted-foreground">
        {vi
          ? "Đánh dấu ngày nhân viên nghỉ cụ thể (nghỉ phép, đau, tập huấn…). Khách sẽ không thấy lịch trống ngày đó."
          : "Block specific dates (PTO, sick day, training). Customers won't see slots for that staff on that date."}
      </p>

      {/* Add form */}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-[11px] text-nq-muted-foreground">
            {vi ? "Nhân viên" : "Staff"}
          </label>
          <select
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            className="rounded border border-nq-border bg-nq-bg px-2 py-1.5 text-xs text-nq-foreground"
            disabled={pending}
          >
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-nq-muted-foreground">
            {vi ? "Ngày" : "Date"}
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded border border-nq-border bg-nq-bg px-2 py-1.5 text-xs text-nq-foreground"
            disabled={pending}
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-nq-muted-foreground">
            {vi ? "Lý do (tuỳ chọn)" : "Reason (optional)"}
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={vi ? "Nghỉ phép, đau…" : "PTO, sick…"}
            className="rounded border border-nq-border bg-nq-bg px-2 py-1.5 text-xs text-nq-foreground placeholder:text-nq-muted-foreground/50"
            disabled={pending}
          />
        </div>
        <button
          onClick={handleAdd}
          disabled={pending || !staffId || !date}
          className="rounded bg-nq-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {vi ? "Thêm" : "Block date"}
        </button>
        {err && <p className="text-xs text-nq-error">{err}</p>}
      </div>

      {/* List */}
      {loading ? (
        <p className="text-xs text-nq-muted-foreground">{vi ? "Đang tải…" : "Loading…"}</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-nq-muted-foreground">
          {vi ? "Chưa có ngày nghỉ nào trong 60 ngày tới." : "No blocked dates in the next 60 days."}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 rounded bg-nq-muted/20 px-3 py-1.5 text-xs">
              <span className="font-medium text-nq-foreground">{staffMap[r.staff_id] ?? r.staff_id}</span>
              <span className="text-nq-muted-foreground">{r.date}</span>
              {r.reason && <span className="text-nq-muted-foreground">— {r.reason}</span>}
              <button
                onClick={() => handleRemove(r.id)}
                disabled={pending}
                className="ml-auto text-nq-muted-foreground hover:text-nq-error disabled:opacity-50"
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function StaffShiftHub({ slug }: Props) {
  const { language } = useUserLanguage();
  const vi = language === "vi";

  const [staff, setStaff] = useState<StaffSummary[]>([]);
  const [shifts, setShifts] = useState<StaffShiftRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [staffRes, shiftRes] = await Promise.all([
        listActiveStaff(slug),
        listStaffShifts(slug),
      ]);
      if (!alive) return;
      if (staffRes.ok) setStaff(staffRes.data ?? []);
      if (shiftRes.ok) setShifts(shiftRes.data ?? []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [slug]);

  // Shift lookup: shiftMap[staffId][dayKey] = row
  const shiftMap: Record<string, Record<string, StaffShiftRow>> = {};
  for (const s of shifts) {
    if (!shiftMap[s.staff_id]) shiftMap[s.staff_id] = {};
    shiftMap[s.staff_id][s.day_of_week] = s;
  }

  function handleSave(updated: StaffShiftRow) {
    setShifts((prev) => {
      const next = prev.filter(
        (x) => !(x.staff_id === updated.staff_id && x.day_of_week === updated.day_of_week),
      );
      return [...next, updated];
    });
  }

  function handleDelete(id: string) {
    setShifts((prev) => prev.filter((x) => x.id !== id));
  }

  if (loading) {
    return (
      <div className="py-4 text-sm text-nq-muted-foreground">
        {vi ? "Đang tải…" : "Loading…"}
      </div>
    );
  }

  if (staff.length === 0) {
    return (
      <p className="text-sm text-nq-muted-foreground">
        {vi
          ? "Chưa có nhân viên nào. Thêm nhân viên trước rồi quay lại."
          : "No active staff. Add staff first, then set their shifts."}
      </p>
    );
  }

  return (
    <div>
      <p className="mb-4 text-xs text-nq-muted-foreground">
        {vi
          ? "Đặt ca làm việc mặc định cho từng nhân viên theo tuần. Salon không đặt ca = nhân viên hoạt động toàn bộ giờ salon."
          : "Set each staff member's recurring weekly hours. Salons with no shifts set fall back to full salon opening hours."}
      </p>

      {/* Weekly grid */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="w-28 py-1.5 pr-3 text-left text-xs font-medium text-nq-muted-foreground">
                {vi ? "Nhân viên" : "Staff"}
              </th>
              {DAYS.map((d) => (
                <th key={d.key} className="min-w-[80px] py-1.5 text-center text-xs font-medium text-nq-muted-foreground">
                  {vi ? d.vi : d.en}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id} className="border-t border-nq-border/40">
                <td className="py-1.5 pr-3 text-xs font-medium text-nq-foreground">
                  <span className="line-clamp-1">{s.name}</span>
                </td>
                {DAYS.map((d) => (
                  <ShiftCell
                    key={d.key}
                    slug={slug}
                    staffId={s.id}
                    dayKey={d.key}
                    shift={shiftMap[s.id]?.[d.key]}
                    onSave={handleSave}
                    onDelete={handleDelete}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <UnavailabilitySection slug={slug} staff={staff} />
    </div>
  );
}
