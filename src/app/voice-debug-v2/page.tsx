"use client";

import { useRealtimeMinimal, type LogEntry, type MinimalStatus } from "@/realtime_v2/useRealtimeMinimal";
import { REALTIME_MODEL, REALTIME_VOICE } from "@/realtime_v2/realtime.constants";

const ERROR_EVENTS = new Set(["sdp.error", "session.error", "connect.error", "dc.error"]);
const SUCCESS_EVENTS = new Set([
  "mic.granted", "peer.created", "sdp.offer", "sdp.answer",
  "remote_desc_set", "data_channel_open", "realtime.connected",
]);

export default function VoiceDebugV2Page() {
  const { status, log, error, start, stop } = useRealtimeMinimal();
  const errorEntries = log.filter((e) => ERROR_EVENTS.has(e.event));

  return (
    <div style={{ fontFamily: "monospace", padding: 24, maxWidth: 960, margin: "0 auto" }}>
      <h1 style={{ margin: "0 0 4px", fontSize: 20 }}>Realtime V2 — Clean Debug</h1>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 20 }}>
        model: {REALTIME_MODEL} · voice: {REALTIME_VOICE} · proxy: /api/realtime/sdp
      </div>

      <StatusRow status={status} error={error} />
      <Controls status={status} onStart={start} onStop={stop} />

      {errorEntries.length > 0 && <ErrorPanel entries={errorEntries} />}

      <LogPanel log={log} />
    </div>
  );
}

// ── Error panel ────────────────────────────────────────────────────────────────

function ErrorPanel({ entries }: { entries: LogEntry[] }) {
  return (
    <div style={{
      border: "2px solid #7f1d1d", borderRadius: 6, marginBottom: 20,
      background: "#0f0505",
    }}>
      <div style={{
        padding: "8px 14px", background: "#7f1d1d",
        color: "#fecaca", fontWeight: "bold", fontSize: 13,
      }}>
        ⚠ RAW ERROR JSON ({entries.length} error{entries.length > 1 ? "s" : ""})
      </div>

      {entries.map((entry) => (
        <div key={entry.id} style={{ borderTop: "1px solid #3f0f0f" }}>
          <div style={{
            padding: "6px 14px", background: "#1c0a0a",
            color: "#f87171", fontSize: 12,
          }}>
            +{entry.relMs}ms · <strong>{entry.event}</strong>
          </div>
          <pre style={{
            margin: 0, padding: "12px 14px",
            background: "#0f0505", color: "#fde8e8",
            fontSize: 12, lineHeight: 1.6,
            overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
            maxHeight: 600, overflowY: "auto",
          }}>
            {JSON.stringify(entry.detail, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

// ── Status row ─────────────────────────────────────────────────────────────────

function StatusRow({ status, error }: { status: MinimalStatus; error: string | null }) {
  const bg =
    status === "connected" ? "#166534"
    : status === "error"   ? "#7f1d1d"
    : status === "idle"    ? "#1e293b"
    : "#78350f";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "10px 14px", background: bg, borderRadius: 6,
      marginBottom: 12,
    }}>
      <Dot status={status} />
      <span style={{ color: "#f1f5f9", fontWeight: "bold", fontSize: 14 }}>
        {status.toUpperCase()}
      </span>
      {error && <span style={{ color: "#fca5a5", fontSize: 13 }}>— {error}</span>}
    </div>
  );
}

function Dot({ status }: { status: MinimalStatus }) {
  const color =
    status === "connected" ? "#4ade80"
    : status === "error"   ? "#f87171"
    : status === "idle"    ? "#94a3b8"
    : "#fbbf24";
  return (
    <span style={{
      display: "inline-block", width: 10, height: 10,
      borderRadius: "50%", background: color, flexShrink: 0,
    }} />
  );
}

// ── Controls ───────────────────────────────────────────────────────────────────

function Controls({
  status, onStart, onStop,
}: {
  status: MinimalStatus;
  onStart: () => void;
  onStop: () => void;
}) {
  const canStart = status === "idle" || status === "error" || status === "ended";
  const canStop  = status !== "idle" && status !== "ended";

  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
      <button
        onClick={onStart}
        disabled={!canStart}
        style={{
          padding: "9px 22px", borderRadius: 5, border: "none",
          cursor: canStart ? "pointer" : "not-allowed",
          background: canStart ? "#2563eb" : "#1e3a5f",
          color: canStart ? "#fff" : "#475569",
          fontFamily: "monospace", fontWeight: "bold", fontSize: 13,
        }}
      >
        ▶ Start
      </button>
      <button
        onClick={onStop}
        disabled={!canStop}
        style={{
          padding: "9px 22px", borderRadius: 5, border: "none",
          cursor: canStop ? "pointer" : "not-allowed",
          background: canStop ? "#dc2626" : "#1e1e2e",
          color: canStop ? "#fff" : "#475569",
          fontFamily: "monospace", fontWeight: "bold", fontSize: 13,
        }}
      >
        ■ Disconnect
      </button>
    </div>
  );
}

// ── Timeline ───────────────────────────────────────────────────────────────────

function LogPanel({ log }: { log: LogEntry[] }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>
        TIMELINE — {log.length} events
      </div>
      <div style={{
        background: "#0f172a", borderRadius: 6, padding: "10px 12px",
        maxHeight: 500, overflowY: "auto",
        fontFamily: "monospace", fontSize: 12, lineHeight: 1.6,
        border: "1px solid #1e293b",
      }}>
        {log.length === 0 && (
          <span style={{ color: "#334155" }}>Press ▶ Start to begin.</span>
        )}
        {log.map((entry) => (
          <TimelineRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function TimelineRow({ entry }: { entry: LogEntry }) {
  const isError   = ERROR_EVENTS.has(entry.event);
  const isSuccess = SUCCESS_EVENTS.has(entry.event);
  const isRx      = entry.event.startsWith("rx.");

  const textColor = isError ? "#f87171" : isSuccess ? "#4ade80" : isRx ? "#7dd3fc" : "#cbd5e1";
  const relLabel  = `+${String(entry.relMs).padStart(5)}ms`;

  // For error events: one-liner only (full details shown in ErrorPanel above)
  // For all others: show up to 120 chars inline
  let detailStr = "";
  if (entry.detail !== undefined && !isError) {
    const raw = typeof entry.detail === "string"
      ? entry.detail
      : JSON.stringify(entry.detail);
    detailStr = raw.length > 120 ? raw.slice(0, 120) + "…" : raw;
  } else if (isError) {
    detailStr = "↑ see RAW ERROR JSON above";
  }

  return (
    <div style={{ color: textColor, display: "flex", gap: 10 }}>
      <span style={{ color: "#334155", flexShrink: 0 }}>{relLabel}</span>
      <span style={{ flexShrink: 0, fontWeight: isSuccess || isError ? "bold" : "normal" }}>
        {entry.event}
      </span>
      {detailStr && (
        <span style={{
          color: isError ? "#ef4444" : "#475569",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {detailStr}
        </span>
      )}
    </div>
  );
}
