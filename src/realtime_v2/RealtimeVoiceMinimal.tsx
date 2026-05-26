"use client";

import { useRealtimeMinimal, type MinimalStatus, type LogEntry } from "./useRealtimeMinimal";

export function RealtimeVoiceMinimal() {
  const { status, log, error, start, stop } = useRealtimeMinimal();

  return (
    <div>
      <StatusBadge status={status} error={error} />
      <Controls status={status} onStart={start} onStop={stop} />
      <Timeline log={log} />
    </div>
  );
}

function StatusBadge({ status, error }: { status: MinimalStatus; error: string | null }) {
  const color =
    status === "connected" ? "#22c55e"
    : status === "error"   ? "#ef4444"
    : status === "idle"    ? "#6b7280"
    : "#f59e0b";

  return (
    <div style={{ marginBottom: 12 }}>
      <span style={{
        display: "inline-block", padding: "4px 12px",
        background: color, color: "#fff", borderRadius: 4,
        fontWeight: "bold", fontSize: 13,
      }}>
        {status.toUpperCase()}
      </span>
      {error && (
        <span style={{ marginLeft: 8, color: "#ef4444", fontSize: 13 }}>
          — {error}
        </span>
      )}
    </div>
  );
}

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
          padding: "8px 20px", borderRadius: 4, border: "none", cursor: canStart ? "pointer" : "not-allowed",
          background: canStart ? "#2563eb" : "#93c5fd", color: "#fff", fontWeight: "bold",
        }}
      >
        Start
      </button>
      <button
        onClick={onStop}
        disabled={!canStop}
        style={{
          padding: "8px 20px", borderRadius: 4, border: "none", cursor: canStop ? "pointer" : "not-allowed",
          background: canStop ? "#dc2626" : "#fca5a5", color: "#fff", fontWeight: "bold",
        }}
      >
        Disconnect
      </button>
    </div>
  );
}

function Timeline({ log }: { log: LogEntry[] }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
        Timeline — {log.length} events
      </div>
      <div style={{
        background: "#0f172a", color: "#e2e8f0", borderRadius: 6,
        padding: 12, maxHeight: 500, overflowY: "auto",
        fontFamily: "monospace", fontSize: 12,
      }}>
        {log.length === 0 && (
          <div style={{ color: "#475569" }}>No events yet. Press Start.</div>
        )}
        {log.map((entry) => (
          <LogLine key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const isError   = entry.event.includes("error") || entry.event.includes("denied") || entry.event.includes("failed");
  const isSuccess = entry.event === "data_channel_open" || entry.event === "realtime.connected"
    || entry.event === "sdp.answer" || entry.event === "remote_desc_set";
  const isRx      = entry.event.startsWith("rx.");

  const color = isError ? "#f87171" : isSuccess ? "#4ade80" : isRx ? "#94a3b8" : "#e2e8f0";

  const relLabel = `+${entry.relMs}ms`.padStart(8);

  const detailStr = entry.detail !== undefined
    ? (typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail))
    : "";

  return (
    <div style={{ marginBottom: 3, color, display: "flex", gap: 8 }}>
      <span style={{ color: "#475569", flexShrink: 0 }}>{relLabel}</span>
      <span style={{ fontWeight: isSuccess || isError ? "bold" : "normal", flexShrink: 0 }}>
        {entry.event}
      </span>
      {detailStr && (
        <span style={{ color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {detailStr.length > 120 ? detailStr.slice(0, 120) + "…" : detailStr}
        </span>
      )}
    </div>
  );
}
