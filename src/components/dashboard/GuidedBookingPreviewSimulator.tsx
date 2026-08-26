"use client";

import {
  useMemo,
  useState,
  useTransition,
  type CSSProperties,
} from "react";
import { recordGoLiveAttestation } from "@/shared/dashboard/goLiveAttestationAction";
import type { GuidedBookingPreviewData } from "@/shared/dashboard/loadGuidedBookingPreview";
import { loadGuidedBookingPreviewAvailability } from "@/shared/dashboard/loadGuidedBookingPreviewAvailability";

type Props = {
  data: GuidedBookingPreviewData;
  language: "en" | "vi";
};

type PreviewStep = "service" | "staff" | "date" | "time" | "review";

const previewSteps: PreviewStep[] = [
  "service",
  "staff",
  "date",
  "time",
  "review",
];

export function GuidedBookingPreviewSimulator({ data, language }: Props) {
  const vi = language === "vi";
  const [step, setStep] = useState<PreviewStep>("service");
  const [serviceId, setServiceId] = useState(data.services[0]?.id ?? "");
  const [staffId, setStaffId] = useState("any");
  const [dateYmd, setDateYmd] = useState(data.previewWindow.firstDateYmd);
  const [timeLabel, setTimeLabel] = useState("");
  const [slots, setSlots] = useState<
    Array<{ label: string; available: boolean }>
  >([]);
  const [availabilityMessage, setAvailabilityMessage] = useState<string | null>(
    null,
  );
  const [evidenceNote, setEvidenceNote] = useState("");
  const [recordMessage, setRecordMessage] = useState<string | null>(null);
  const [isLoading, startAvailabilityTransition] = useTransition();
  const [isRecording, startRecordTransition] = useTransition();

  const selectedService = data.services.find(
    (service) => service.id === serviceId,
  );
  const eligibleStaff = useMemo(() => {
    if (!serviceId || data.capabilityRows === null) return [];
    const eligibleIds = new Set(
      data.capabilityRows
        .filter((row) => row.serviceId === serviceId)
        .map((row) => row.staffId),
    );
    return data.staff.filter((staff) => eligibleIds.has(staff.id));
  }, [data.capabilityRows, data.staff, serviceId]);
  const selectedStaff = data.staff.find((staff) => staff.id === staffId);
  const dateIsClosed = data.salon.bookingClosedDates.includes(dateYmd);
  const hasAvailableSlots = slots.some((slot) => slot.available);

  function resetAvailability() {
    setSlots([]);
    setTimeLabel("");
    setAvailabilityMessage(null);
    setRecordMessage(null);
  }

  function selectService(nextServiceId: string) {
    setServiceId(nextServiceId);
    setStaffId("any");
    resetAvailability();
  }

  function selectStaff(nextStaffId: string) {
    setStaffId(nextStaffId);
    resetAvailability();
  }

  function selectDate(nextDateYmd: string) {
    setDateYmd(nextDateYmd);
    resetAvailability();
  }

  function loadAvailability() {
    setAvailabilityMessage(null);
    startAvailabilityTransition(async () => {
      const result = await loadGuidedBookingPreviewAvailability({
        slug: data.slug,
        serviceId,
        staffId,
        dateYmd,
      });
      if (!result.ok) {
        setSlots([]);
        setTimeLabel("");
        setAvailabilityMessage(
          result.reason === "resource_mode_not_proven"
            ? vi
              ? "Preview lịch cho salon dùng giường/ghế chưa được chứng minh an toàn. Bước này vẫn chưa hoàn tất."
              : "Availability preview for resource-based salons is not safely proven yet. This step remains incomplete."
            : vi
              ? "Không thể chứng minh lịch trống từ dữ liệu hiện tại. Không có slot nào được giả định là trống."
              : "Availability could not be proven from current data. No slot is assumed to be open.",
        );
        return;
      }
      setSlots(result.slots);
      setTimeLabel("");
      setStep("time");
    });
  }

  function continuePreview() {
    if (step === "service" && serviceId) setStep("staff");
    else if (step === "staff") setStep("date");
    else if (step === "date") loadAvailability();
    else if (step === "time" && timeLabel) setStep("review");
  }

  function back() {
    setRecordMessage(null);
    if (step === "review") setStep("time");
    else if (step === "time") setStep("date");
    else if (step === "date") setStep("staff");
    else if (step === "staff") setStep("service");
  }

  function recordSafePreview() {
    const note = evidenceNote.trim();
    if (note.length < 10 || !timeLabel) {
      setRecordMessage(
        vi
          ? "Ghi chú cần ít nhất 10 ký tự và phải chọn một giờ trống."
          : "Enter at least 10 characters of evidence and select an available time.",
      );
      return;
    }
    setRecordMessage(null);
    startRecordTransition(async () => {
      const result = await recordGoLiveAttestation(data.slug, {
        checkKey: "live_rehearsal_completed",
        action: "attest",
        evidenceNote: note,
        guidedPreviewSelection: {
          serviceId,
          staffId,
          dateYmd,
          timeLabel,
        },
      });
      setRecordMessage(
        result.ok
          ? vi
            ? result.unchanged
              ? "Preview này đã được ghi nhận trước đó."
              : "Đã ghi nhận preview chỉ đọc vào lịch sử audit."
            : result.unchanged
              ? "This preview was already recorded."
              : "The read-only preview was recorded in the audit history."
          : vi
            ? "Không thể ghi nhận preview. Dữ liệu hoặc slot đã thay đổi; hãy kiểm tra lại."
            : "The preview could not be recorded. Data or availability changed; review it again.",
      );
    });
  }

  return (
    <section
      data-testid="guided-booking-preview-simulator"
      data-preview-read-only="true"
      className="overflow-hidden rounded-3xl border border-nq-border/50 bg-nq-surface/60"
      style={{ "--preview-brand": data.salon.brandColor } as CSSProperties}
    >
      <header className="border-b border-nq-border/40 px-5 py-5">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--preview-brand)]">
          {vi ? "Xem trước an toàn · chỉ đọc" : "Safe preview · read only"}
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-nq-foreground">
          {data.salon.name}
        </h1>
        <p className="mt-1 text-sm text-nq-muted">
          {[data.salon.address, data.salon.phone].filter(Boolean).join(" · ")}
        </p>
      </header>

      <div className="px-5 py-5">
        <ol
          aria-label={vi ? "Các bước xem trước" : "Preview steps"}
          className="mb-5 grid grid-cols-5 gap-1 text-center text-[11px] font-semibold sm:gap-2 sm:text-xs"
        >
          {previewSteps.map((item, index) => (
            <li
              key={item}
              aria-current={step === item ? "step" : undefined}
              className={
                step === item
                  ? "rounded-full bg-nq-primary/15 px-1 py-2 text-nq-primary sm:px-2"
                  : "rounded-full bg-nq-bg/50 px-1 py-2 text-nq-muted sm:px-2"
              }
            >
              {index + 1}. {vi
                ? ["Dịch vụ", "Nhân viên", "Ngày", "Giờ", "Kiểm tra"][index]
                : ["Service", "Staff", "Date", "Time", "Review"][index]}
            </li>
          ))}
        </ol>

        {step === "service" ? (
          <div data-testid="guided-preview-service-step">
            <h2 className="text-lg font-semibold text-nq-foreground">
              {vi ? "Khách sẽ chọn dịch vụ" : "Customer chooses a service"}
            </h2>
            <div className="mt-3 grid gap-2">
              {data.services.map((service) => (
                <button
                  key={service.id}
                  type="button"
                  onClick={() => selectService(service.id)}
                  aria-pressed={serviceId === service.id}
                  className={
                    serviceId === service.id
                      ? "rounded-2xl border border-nq-primary bg-nq-primary/10 p-4 text-left"
                      : "rounded-2xl border border-nq-border/50 bg-nq-bg/40 p-4 text-left"
                  }
                >
                  <span className="flex items-start justify-between gap-4">
                    <span>
                      <span className="font-semibold text-nq-foreground">
                        {service.name}
                      </span>
                      <span className="mt-1 block text-xs text-nq-muted">
                        {service.durationMinutes} min
                        {service.description ? ` · ${service.description}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 font-semibold text-nq-foreground">
                      {service.priceDisplay ?? "—"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === "staff" ? (
          <div data-testid="guided-preview-staff-step">
            <h2 className="text-lg font-semibold text-nq-foreground">
              {vi ? "Khách sẽ chọn nhân viên" : "Customer chooses staff"}
            </h2>
            <div className="mt-3 grid gap-2">
              <button
                type="button"
                onClick={() => selectStaff("any")}
                aria-pressed={staffId === "any"}
                className={
                  staffId === "any"
                    ? "rounded-2xl border border-nq-primary bg-nq-primary/10 p-4 text-left"
                    : "rounded-2xl border border-nq-border/50 bg-nq-bg/40 p-4 text-left"
                }
              >
                <span className="font-semibold text-nq-foreground">
                  {vi ? "Bất kỳ nhân viên phù hợp" : "Any eligible staff"}
                </span>
              </button>
              {data.salon.staffSelectionEnabled
                ? eligibleStaff.map((staff) => (
                    <button
                      key={staff.id}
                      type="button"
                      onClick={() => selectStaff(staff.id)}
                      aria-pressed={staffId === staff.id}
                      className={
                        staffId === staff.id
                          ? "rounded-2xl border border-nq-primary bg-nq-primary/10 p-4 text-left"
                          : "rounded-2xl border border-nq-border/50 bg-nq-bg/40 p-4 text-left"
                      }
                    >
                      <span className="font-semibold text-nq-foreground">
                        {staff.name}
                      </span>
                      <span className="mt-1 block text-xs text-nq-muted">
                        {staff.jobRole}
                      </span>
                    </button>
                  ))
                : null}
            </div>
          </div>
        ) : null}

        {step === "date" ? (
          <div data-testid="guided-preview-date-step">
            <h2 className="text-lg font-semibold text-nq-foreground">
              {vi ? "Chọn ngày để kiểm tra" : "Choose a date to inspect"}
            </h2>
            <label className="mt-3 block text-sm font-medium text-nq-foreground">
              {vi ? "Ngày tại múi giờ salon" : "Date in the salon timezone"}
              <input
                type="date"
                value={dateYmd}
                min={data.previewWindow.firstDateYmd}
                max={data.previewWindow.lastDateYmd}
                onChange={(event) => selectDate(event.target.value)}
                className="mt-2 block min-h-12 w-full rounded-xl border border-nq-border/60 bg-nq-bg/70 px-3 text-base text-nq-foreground"
              />
            </label>
            {data.salon.resourcesEnabled ? (
              <p className="mt-3 rounded-2xl border border-nq-danger/30 bg-nq-danger/5 p-4 text-sm leading-6 text-nq-danger">
                {vi
                  ? "Salon này dùng giường/ghế. Preview chỉ đọc chưa có bằng chứng resource availability nên giữ bước này chưa hoàn tất."
                  : "This salon uses beds or chairs. The read-only preview does not yet prove resource availability, so this step remains incomplete."}
              </p>
            ) : null}
            {dateIsClosed ? (
              <p
                role="status"
                className="mt-3 rounded-2xl border border-nq-border/50 bg-nq-bg/40 p-4 text-sm leading-6 text-nq-muted"
              >
                {vi
                  ? "Ngày này đã được đánh dấu nghỉ. Hãy chọn ngày khác để kiểm tra lịch trống."
                  : "This date is marked closed. Choose another date to inspect availability."}
              </p>
            ) : null}
            {availabilityMessage ? (
              <p role="status" className="mt-3 text-sm leading-6 text-nq-danger">
                {availabilityMessage}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === "time" ? (
          <div data-testid="guided-preview-time-step">
            <h2 className="text-lg font-semibold text-nq-foreground">
              {vi ? "Lịch trống hiện tại" : "Current availability"}
            </h2>
            <p className="mt-1 text-sm leading-6 text-nq-muted">
              {vi
                ? "Đây là kết quả đọc hiện tại và có thể thay đổi. Slot bị bận không thể chọn."
                : "This is a current read and can change. Occupied slots cannot be selected."}
            </p>
            {!hasAvailableSlots ? (
              <p className="mt-3 rounded-2xl border border-nq-border/50 bg-nq-bg/40 p-4 text-sm text-nq-muted">
                {vi ? "Không có giờ trống cho ngày này." : "No available times for this date."}
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {slots.map((slot) => (
                  <button
                    key={slot.label}
                    type="button"
                    disabled={!slot.available}
                    onClick={() => {
                      setTimeLabel(slot.label);
                      setRecordMessage(null);
                    }}
                    aria-pressed={timeLabel === slot.label}
                    className={
                      timeLabel === slot.label
                        ? "min-h-11 rounded-xl border border-nq-primary bg-nq-primary/10 px-3 text-sm font-semibold text-nq-foreground"
                        : "min-h-11 rounded-xl border border-nq-border/50 bg-nq-bg/40 px-3 text-sm font-semibold text-nq-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    }
                  >
                    {slot.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {step === "review" ? (
          <div data-testid="guided-preview-review-step">
            <h2 className="text-lg font-semibold text-nq-foreground">
              {vi ? "Kiểm tra trước khi hoạt động" : "Review before go-live"}
            </h2>
            <dl className="mt-3 space-y-3 rounded-2xl border border-nq-border/50 bg-nq-bg/40 p-4 text-sm">
              <div>
                <dt className="text-nq-muted">{vi ? "Dịch vụ" : "Service"}</dt>
                <dd className="font-semibold text-nq-foreground">
                  {selectedService?.name ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-nq-muted">{vi ? "Nhân viên" : "Staff"}</dt>
                <dd className="font-semibold text-nq-foreground">
                  {staffId === "any"
                    ? vi
                      ? "Bất kỳ nhân viên phù hợp"
                      : "Any eligible staff"
                    : selectedStaff?.name ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-nq-muted">{vi ? "Ngày và giờ" : "Date and time"}</dt>
                <dd className="font-semibold text-nq-foreground">
                  {dateYmd} · {timeLabel}
                </dd>
              </div>
              <div>
                <dt className="text-nq-muted">{vi ? "Múi giờ" : "Timezone"}</dt>
                <dd className="font-semibold text-nq-foreground">
                  {data.salon.timezone}
                </dd>
              </div>
              <div>
                <dt className="text-nq-muted">
                  {vi ? "Thuế hiển thị khi xác nhận" : "Taxes shown at confirmation"}
                </dt>
                <dd className="font-semibold text-nq-foreground">
                  {data.salon.taxLines.filter((line) => line.enabled && line.rate > 0)
                    .map((line) => `${line.name} ${(line.rate * 100).toFixed(2).replace(/\.00$/, "")}%`)
                    .join(" · ") || (vi ? "Không có" : "None")}
                </dd>
              </div>
            </dl>
            <button
              type="button"
              disabled
              aria-disabled="true"
              data-testid="guided-preview-confirm-disabled"
              className="mt-4 min-h-12 w-full cursor-not-allowed rounded-full bg-nq-muted/20 px-5 font-semibold text-nq-muted"
            >
              {vi
                ? "Xác nhận booking bị tắt trong preview"
                : "Booking confirmation is disabled in preview"}
            </button>
            <p className="mt-2 text-xs leading-5 text-nq-muted">
              {vi
                ? "Preview này không nhận thông tin khách, không gọi OTP, không lưu thẻ, không tạo lịch và không gửi thông báo."
                : "This preview collects no customer data, calls no OTP, stores no card, creates no booking, and sends no notification."}
            </p>

            <label className="mt-4 block text-sm font-medium text-nq-foreground">
              {vi ? "Ghi chú bằng chứng" : "Evidence note"}
              <textarea
                data-testid="guided-preview-evidence-note"
                value={evidenceNote}
                onChange={(event) => setEvidenceNote(event.target.value)}
                maxLength={300}
                rows={3}
                placeholder={
                  vi
                    ? "Ai kiểm tra, dịch vụ/nhân viên/ngày giờ nào..."
                    : "Who reviewed it and which service, staff, date, and time..."
                }
                className="mt-1 block w-full rounded-xl border border-nq-border/60 bg-nq-bg/70 px-3 py-2 text-base text-nq-foreground"
              />
            </label>
            <button
              type="button"
              onClick={recordSafePreview}
              disabled={isRecording || evidenceNote.trim().length < 10}
              data-testid="guided-preview-record-proof"
              className="mt-3 min-h-11 w-full rounded-full bg-nq-primary px-5 text-sm font-semibold text-black disabled:opacity-40"
            >
              {isRecording
                ? vi
                  ? "Đang kiểm tra lại..."
                  : "Rechecking..."
                : vi
                  ? "Ghi nhận preview chỉ đọc"
                  : "Record read-only preview"}
            </button>
            {recordMessage ? (
              <p
                role="status"
                data-testid="guided-preview-record-message"
                className="mt-2 text-sm leading-6 text-nq-muted"
              >
                {recordMessage}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={back}
            disabled={step === "service" || isLoading || isRecording}
            className="min-h-11 rounded-full border border-nq-border/60 px-5 text-sm font-semibold text-nq-foreground disabled:opacity-40"
          >
            {vi ? "Quay lại" : "Back"}
          </button>
          {step !== "review" ? (
            <button
              type="button"
              onClick={continuePreview}
              disabled={
                isLoading ||
                (step === "service" && !serviceId) ||
                (step === "date" &&
                  (!dateYmd || dateIsClosed || data.salon.resourcesEnabled)) ||
                (step === "time" && !timeLabel)
              }
              className="min-h-11 rounded-full bg-nq-primary px-5 text-sm font-semibold text-black disabled:opacity-40"
            >
              {isLoading
                ? vi
                  ? "Đang kiểm tra..."
                  : "Checking..."
                : vi
                  ? "Tiếp tục"
                  : "Continue"}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
