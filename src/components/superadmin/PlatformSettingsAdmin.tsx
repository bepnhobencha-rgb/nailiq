"use client";

import { useState, useTransition } from "react";
import {
  updatePlatformSettings,
  testTwilioConnection,
  testResendConnection,
  type PlatformSettingsRow,
  type UpdatePlatformSettingsInput,
} from "@/shared/superadmin/superadminActions";
import { cn } from "@/shared/lib/cn";

type FieldState = "idle" | "saved" | "error";

function SecretInput({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "email";
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-sm font-medium text-nq-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Not set"}
        className="w-full rounded-xl border border-nq-border/40 bg-nq-bg/60 px-3 py-2.5 font-mono text-sm text-nq-foreground placeholder:text-nq-muted/50 focus:outline-none focus:ring-2 focus:ring-nq-primary/50"
      />
      {hint ? (
        <p className="mt-1 text-xs text-nq-muted">{hint}</p>
      ) : null}
    </div>
  );
}

function StatusLine({
  state,
  message,
}: {
  state: FieldState;
  message: string;
}) {
  if (state === "idle") return null;
  return (
    <p
      className={cn(
        "mt-2 text-xs",
        state === "saved" ? "text-nq-success" : "text-nq-error",
      )}
    >
      {message}
    </p>
  );
}

export function PlatformSettingsAdmin({
  initial,
}: {
  initial: PlatformSettingsRow;
}) {
  // Twilio section
  const [twilioSid, setTwilioSid] = useState(initial.twilioAccountSid);
  const [twilioToken, setTwilioToken] = useState(initial.twilioAuthToken);
  const [twilioVSid, setTwilioVSid] = useState(initial.twilioVerifyServiceSid);
  const [twilioState, setTwilioState] = useState<FieldState>("idle");
  const [twilioMsg, setTwilioMsg] = useState("");
  const [twilioTestState, setTwilioTestState] = useState<FieldState>("idle");
  const [twilioTestMsg, setTwilioTestMsg] = useState("");
  const [isSavingTwilio, startSaveTwilio] = useTransition();
  const [isTestingTwilio, startTestTwilio] = useTransition();

  // Resend section
  const [resendKey, setResendKey] = useState(initial.resendApiKey);
  const [resendFrom, setResendFrom] = useState(initial.resendFrom);
  const [resendTestEmail, setResendTestEmail] = useState("");
  const [resendState, setResendState] = useState<FieldState>("idle");
  const [resendMsg, setResendMsg] = useState("");
  const [resendTestState, setResendTestState] = useState<FieldState>("idle");
  const [resendTestMsg, setResendTestMsg] = useState("");
  const [isSavingResend, startSaveResend] = useTransition();
  const [isTestingResend, startTestResend] = useTransition();

  function saveTwilio() {
    setTwilioState("idle");
    startSaveTwilio(async () => {
      const input: UpdatePlatformSettingsInput = {
        twilioAccountSid: twilioSid,
        twilioAuthToken: twilioToken,
        twilioVerifyServiceSid: twilioVSid,
      };
      const r = await updatePlatformSettings(input);
      if (r.ok) {
        setTwilioState("saved");
        setTwilioMsg("Saved ✓");
        setTimeout(() => setTwilioState("idle"), 3000);
      } else {
        setTwilioState("error");
        setTwilioMsg("Could not save. Try again.");
      }
    });
  }

  function testTwilio() {
    setTwilioTestState("idle");
    startTestTwilio(async () => {
      const r = await testTwilioConnection();
      if (r.ok) {
        setTwilioTestState("saved");
        setTwilioTestMsg(r.message);
      } else {
        setTwilioTestState("error");
        setTwilioTestMsg(r.error);
      }
    });
  }

  function saveResend() {
    setResendState("idle");
    startSaveResend(async () => {
      const input: UpdatePlatformSettingsInput = {
        resendApiKey: resendKey,
        resendFrom,
      };
      const r = await updatePlatformSettings(input);
      if (r.ok) {
        setResendState("saved");
        setResendMsg("Saved ✓");
        setTimeout(() => setResendState("idle"), 3000);
      } else {
        setResendState("error");
        setResendMsg("Could not save. Try again.");
      }
    });
  }

  function testResend() {
    setResendTestState("idle");
    if (!resendTestEmail.trim()) {
      setResendTestState("error");
      setResendTestMsg("Enter a recipient email first.");
      return;
    }
    startTestResend(async () => {
      const r = await testResendConnection(resendTestEmail.trim());
      if (r.ok) {
        setResendTestState("saved");
        setResendTestMsg(r.message);
      } else {
        setResendTestState("error");
        setResendTestMsg(r.error);
      }
    });
  }

  const sectionClass =
    "rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5 flex flex-col gap-4";
  const sectionHeadClass = "text-base font-semibold text-nq-foreground";
  const saveButtonClass =
    "rounded-full border border-nq-primary/50 bg-nq-primary px-5 py-2 text-sm font-semibold text-nq-bg transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50";
  const testButtonClass =
    "rounded-full border border-nq-border/50 bg-nq-surface/60 px-4 py-2 text-sm font-medium text-nq-foreground transition hover:bg-nq-surface disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex flex-col gap-6">
      {initial.updatedAt ? (
        <p className="text-xs text-nq-muted">
          Last updated:{" "}
          {new Date(initial.updatedAt).toLocaleString("en-CA", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
      ) : null}

      {/* ── Twilio ─────────────────────────────────────────── */}
      <section className={sectionClass}>
        <div className="flex items-center gap-2">
          <span aria-hidden>📱</span>
          <h2 className={sectionHeadClass}>Twilio Verify (SMS OTP)</h2>
        </div>
        <p className="text-xs text-nq-muted">
          Required for SMS phone verification in the booking flow. Salons can
          enable OTP per-salon in their Settings.
        </p>

        <SecretInput
          id="twilio-sid"
          label="Account SID"
          value={twilioSid}
          onChange={setTwilioSid}
          placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          hint="Starts with AC"
        />
        <SecretInput
          id="twilio-token"
          label="Auth Token"
          value={twilioToken}
          onChange={setTwilioToken}
          placeholder="Not set"
        />
        <SecretInput
          id="twilio-vsid"
          label="Verify Service SID"
          value={twilioVSid}
          onChange={setTwilioVSid}
          placeholder="VAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          hint="Starts with VA — create a Verify service in Twilio console"
        />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={isSavingTwilio}
            onClick={saveTwilio}
            className={saveButtonClass}
          >
            {isSavingTwilio ? "Saving…" : "Save Twilio credentials"}
          </button>
          <button
            type="button"
            disabled={isTestingTwilio}
            onClick={testTwilio}
            className={testButtonClass}
          >
            {isTestingTwilio ? "Testing…" : "Test connection"}
          </button>
        </div>

        <StatusLine state={twilioState} message={twilioMsg} />
        <StatusLine state={twilioTestState} message={twilioTestMsg} />
      </section>

      {/* ── Resend ─────────────────────────────────────────── */}
      <section className={sectionClass}>
        <div className="flex items-center gap-2">
          <span aria-hidden>📧</span>
          <h2 className={sectionHeadClass}>Resend (Transactional Email)</h2>
        </div>
        <p className="text-xs text-nq-muted">
          Used for booking confirmation emails. Leave blank to use environment
          variables.
        </p>

        <SecretInput
          id="resend-key"
          label="Resend API Key"
          value={resendKey}
          onChange={setResendKey}
          placeholder="re_••••••••"
          hint='Get from resend.com → API Keys'
        />
        <SecretInput
          id="resend-from"
          label="From Address"
          value={resendFrom}
          onChange={setResendFrom}
          placeholder='NailIQ <noreply@nailiq.ca>'
          hint="Must match a verified Resend sender domain"
          type="text"
        />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={isSavingResend}
            onClick={saveResend}
            className={saveButtonClass}
          >
            {isSavingResend ? "Saving…" : "Save Resend credentials"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="email"
            value={resendTestEmail}
            onChange={(e) => setResendTestEmail(e.target.value)}
            placeholder="test@example.com"
            className="min-w-0 flex-1 rounded-xl border border-nq-border/40 bg-nq-bg/60 px-3 py-2 text-sm text-nq-foreground placeholder:text-nq-muted/50 focus:outline-none focus:ring-2 focus:ring-nq-primary/50"
          />
          <button
            type="button"
            disabled={isTestingResend}
            onClick={testResend}
            className={testButtonClass}
          >
            {isTestingResend ? "Sending…" : "Send test email"}
          </button>
        </div>

        <StatusLine state={resendState} message={resendMsg} />
        <StatusLine state={resendTestState} message={resendTestMsg} />
      </section>
    </div>
  );
}
