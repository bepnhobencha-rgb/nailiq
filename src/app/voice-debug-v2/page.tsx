"use client";

import { useRealtimeMinimal, type LogEntry, type MinimalStatus } from "@/realtime_v2/useRealtimeMinimal";
import { REALTIME_MODEL, REALTIME_VOICE } from "@/realtime_v2/realtime.constants";

export default function VoiceDebugV2Page() {
  const { status, log, error, start, stop } = useRealtimeMinimal();

  return (
    <div style={{ fontFamily: "monospace", padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ margin: "0 0 4px", fontSize: 20 }}>Realtime V2 — Clean Debug</h1>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 20 }}>
        model: {REALTIME_MODEL} · voice: {REALTIME_VOICE} · proxy: /api/realtime/sdp
      </div>

      <StatusRow status={status} error={error} />
      <Controls status={status} onStart={start} onStop={stop} />
      <LogPanel log={log} />
    </div>
  );
}

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

function LogPanel({ log }: { log: LogEntry[] }) {
  const successEvents = new Set([
    "mic.granted", "peer.created", "sdp.offer", "sdp.answer",
    "remote_desc_set", "data_channel_open", "realtime.connected",
  ]);
  const errorEvents   = (e: string) => e.includes("error") || e.includes("denied") || e.includes("failed");
  const rxEvents      = (e: string) => e.startsWith("rx.");

  return (
    <div>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>
        TIMELINE — {log.length} events
      </div>
      <div style={{
        background: "#0f172a", borderRadius: 6, padding: "10px 12px",
        maxHeight: 600, overflowY: "auto",
        fontFamily: "monospace", fontSize: 12, lineHeight: 1.6,
        border: "1px solid #1e293b",
      }}>
        {log.length === 0 && (
          <span style={{ color: "#334155" }}>Press ▶ Start to begin.</span>
        )}
        {log.map((entry) => {
          const isError   = errorEvents(entry.event);
          const isSuccess = successEvents.has(entry.event);
          const isRx      = rxEvents(entry.event);

          const textColor = isError ? "#f87171" : isSuccess ? "#4ade80" : isRx ? "#7dd3fc" : "#cbd5e1";

          const relLabel = `+${String(entry.relMs).padStart(5)}ms`;

          let detailStr = "";
          if (entry.detail !== undefined) {
            const raw = typeof entry.detail === "string"
              ? entry.detail
              : JSON.stringify(entry.detail);
            detailStr = raw.length > 140 ? raw.slice(0, 140) + "…" : raw;
          }

          return (
            <div key={entry.id} style={{ color: textColor, display: "flex", gap: 10 }}>
              <span style={{ color: "#334155", flexShrink: 0 }}>{relLabel}</span>
              <span style={{ flexShrink: 0, fontWeight: isSuccess || isError ? "bold" : "normal" }}>
                {entry.event}
              </span>
              {detailStr && (
                <span style={{ color: "#475569", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {detailStr}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
