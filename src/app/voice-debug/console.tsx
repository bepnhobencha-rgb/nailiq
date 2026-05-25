"use client";

import { useState, useRef, useEffect } from "react";
import { useVoiceDebug } from "@/hooks/useVoiceDebug";
import type { DebugMode, LoggedEvent, RegressionResult } from "@/hooks/useVoiceDebug";
import { BUILT_IN_TESTS } from "./regression-tests";

// ─── Helpers ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  idle: "text-neutral-500",
  connecting_mic: "text-yellow-400",
  connecting_openai: "text-yellow-400",
  connecting_dc: "text-yellow-400",
  ready: "text-green-400",
  listening: "text-blue-400",
  thinking: "text-purple-400",
  speaking: "text-cyan-400",
  tool_calling: "text-orange-400",
  confirmed: "text-green-400",
  ended: "text-neutral-400",
  error: "text-red-400",
};

const DIR_COLOR: Record<string, string> = {
  in: "text-cyan-400",
  out: "text-yellow-400",
  system: "text-neutral-500",
};

const DIR_LABEL: Record<string, string> = { in: "←", out: "→", sys: "·" };

function relMs(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  return `+${(ms / 1000).toFixed(2)}s`;
}

function ConnDot({ state }: { state: string | null }) {
  const cls =
    state === "connected" || state === "open" ? "bg-green-500"
    : state === "connecting" || state === "checking" ? "bg-yellow-500 animate-pulse"
    : state === "failed" || state === "closed" ? "bg-red-500"
    : "bg-neutral-600";
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${cls}`} />;
}

// ─── Event row ────────────────────────────────────────────────────────────────

function EventRow({ ev, onSelect }: { ev: LoggedEvent; onSelect: (ev: LoggedEvent) => void }) {
  return (
    <button
      onClick={() => onSelect(ev)}
      className="w-full text-left flex gap-2 items-baseline px-2 py-0.5 hover:bg-neutral-800 rounded text-xs font-mono"
    >
      <span className="text-neutral-600 w-16 shrink-0">{relMs(ev.relMs)}</span>
      <span className={`w-4 shrink-0 ${DIR_COLOR[ev.direction]}`}>
        {DIR_LABEL[ev.direction === "system" ? "sys" : ev.direction]}
      </span>
      <span className={`truncate ${DIR_COLOR[ev.direction]}`}>{ev.type}</span>
    </button>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function VoiceDebugConsole() {
  const {
    status, mode, connectionStats, errorMessage,
    messages, eventLog, latencyLog,
    setMode, start, end, injectText, clearLog, exportSession, runTest,
  } = useVoiceDebug();

  const [shopSlug, setShopSlug] = useState("demo");
  const [language, setLanguage] = useState<"en" | "vi">("vi");
  const [textInput, setTextInput] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<LoggedEvent | null>(null);
  const [testResults, setTestResults] = useState<RegressionResult[]>([]);
  const [runningTestId, setRunningTestId] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);

  const eventEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll event log
  useEffect(() => {
    if (autoScroll && eventEndRef.current) {
      eventEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [eventLog.length, autoScroll]);

  const isConnected = status === "ready" || status === "listening" || status === "thinking" || status === "speaking" || status === "tool_calling";
  const isConnecting = status === "connecting_mic" || status === "connecting_openai" || status === "connecting_dc";

  const handleInject = () => {
    if (!textInput.trim()) return;
    injectText(textInput.trim());
    setTextInput("");
  };

  const handleRunTest = async (test: typeof BUILT_IN_TESTS[number]) => {
    setRunningTestId(test.id);
    const result = await runTest(test);
    setTestResults((p) => {
      const filtered = p.filter((r) => r.test.id !== test.id);
      return [...filtered, result];
    });
    setRunningTestId(null);
  };

  const handleExport = () => {
    const json = exportSession();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `voice-session-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredLog = eventFilter.trim()
    ? eventLog.filter((e) => e.type.includes(eventFilter.trim()))
    : eventLog;

  // Latency stats
  const sttLatencies = latencyLog.filter((l) => l.type === "stt").map((l) => l.ms);
  const respLatencies = latencyLog.filter((l) => l.type === "response").map((l) => l.ms);
  const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const min = (arr: number[]) => arr.length ? Math.min(...arr) : null;
  const max = (arr: number[]) => arr.length ? Math.max(...arr) : null;

  return (
    <div className="max-w-[1600px] mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold font-mono tracking-tight">
          🎙 Voice AI Debug Console
          <span className="ml-3 text-xs font-normal text-neutral-500">
            NailIQ Realtime WebRTC
          </span>
        </h1>
        <div className="flex gap-2 items-center">
          <button
            onClick={handleExport}
            className="px-3 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 rounded font-mono border border-neutral-700"
          >
            Export JSON
          </button>
          <button
            onClick={clearLog}
            className="px-3 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 rounded font-mono border border-neutral-700"
          >
            Clear Log
          </button>
        </div>
      </div>

      {/* ── Row 1: Controls + Connection Stats ─────────────────────────────── */}
      <div className="grid grid-cols-[1fr_1fr_auto] gap-4">
        {/* Session controls */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 space-y-3">
          <div className="text-xs text-neutral-500 font-mono uppercase tracking-widest">Session</div>
          <div className="flex gap-2">
            <input
              value={shopSlug}
              onChange={(e) => setShopSlug(e.target.value)}
              placeholder="salon slug"
              className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs font-mono text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-500"
            />
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as "en" | "vi")}
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs font-mono text-neutral-100 focus:outline-none"
            >
              <option value="vi">VI</option>
              <option value="en">EN</option>
            </select>
          </div>
          {/* Mode selector */}
          <div className="flex gap-1">
            {(["safe", "tool", "full"] as DebugMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={isConnected || isConnecting}
                className={`flex-1 py-1 text-xs font-mono rounded border transition-colors ${
                  mode === m
                    ? "bg-neutral-700 border-neutral-500 text-neutral-100"
                    : "bg-neutral-900 border-neutral-700 text-neutral-500 hover:border-neutral-600"
                } disabled:opacity-40`}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-neutral-600 font-mono">
            SAFE=no tools &nbsp;·&nbsp; TOOL=booking tools &nbsp;·&nbsp; FULL=complete flow
          </div>
          {/* Connect / disconnect */}
          <div className="flex gap-2">
            <button
              onClick={() => start(shopSlug, language)}
              disabled={isConnected || isConnecting || !shopSlug}
              className="flex-1 py-1.5 text-xs font-mono rounded bg-green-700 hover:bg-green-600 disabled:opacity-40 transition-colors"
            >
              {isConnecting ? "Connecting…" : "Connect"}
            </button>
            <button
              onClick={end}
              disabled={!isConnected && !isConnecting}
              className="flex-1 py-1.5 text-xs font-mono rounded bg-red-800 hover:bg-red-700 disabled:opacity-40 transition-colors"
            >
              Disconnect
            </button>
          </div>
          {errorMessage && (
            <div className="text-red-400 text-xs font-mono bg-red-950 border border-red-800 rounded px-2 py-1">
              {errorMessage}
            </div>
          )}
        </div>

        {/* Connection stats */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 space-y-3">
          <div className="text-xs text-neutral-500 font-mono uppercase tracking-widest">Connection</div>
          <div className="space-y-1.5">
            {[
              { label: "Status", value: status, isStatus: true },
              { label: "ICE", value: connectionStats.ice ?? "—" },
              { label: "PC", value: connectionStats.pc ?? "—" },
              { label: "DC", value: connectionStats.dc ?? "—" },
              { label: "Signaling", value: connectionStats.signaling ?? "—" },
            ].map(({ label, value, isStatus }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-neutral-600 text-xs font-mono w-20">{label}</span>
                <span className="flex items-center gap-1.5">
                  {!isStatus && <ConnDot state={value} />}
                  <span className={`text-xs font-mono ${isStatus ? (STATUS_COLOR[value] ?? "text-neutral-400") : "text-neutral-300"}`}>
                    {value}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Latency stats */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 w-44 space-y-3">
          <div className="text-xs text-neutral-500 font-mono uppercase tracking-widest">Latency</div>
          <div className="space-y-2">
            {[
              { label: "STT", data: sttLatencies },
              { label: "Response", data: respLatencies },
            ].map(({ label, data }) => (
              <div key={label}>
                <div className="text-[10px] text-neutral-500 font-mono mb-1">{label} ({data.length})</div>
                <div className="grid grid-cols-3 gap-1 text-[10px] font-mono">
                  <div className="text-center">
                    <div className="text-neutral-600">avg</div>
                    <div className="text-neutral-300">{avg(data) ?? "—"}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-neutral-600">min</div>
                    <div className="text-neutral-300">{min(data) ?? "—"}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-neutral-600">max</div>
                    <div className="text-neutral-300">{max(data) ?? "—"}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Row 2: Event Stream + Event Detail + Transcript ─────────────────── */}
      <div className="grid grid-cols-[1fr_320px_1fr] gap-4 h-[420px]">
        {/* Event stream */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 shrink-0">
            <span className="text-xs text-neutral-500 font-mono uppercase tracking-widest">Event Stream</span>
            <div className="flex items-center gap-2">
              <input
                value={eventFilter}
                onChange={(e) => setEventFilter(e.target.value)}
                placeholder="filter type…"
                className="bg-neutral-800 border border-neutral-700 rounded px-2 py-0.5 text-xs font-mono w-28 placeholder-neutral-600 focus:outline-none focus:border-neutral-500"
              />
              <label className="flex items-center gap-1 text-[10px] text-neutral-600 font-mono cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="w-3 h-3"
                />
                auto
              </label>
              <span className="text-[10px] text-neutral-600 font-mono">{filteredLog.length}</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {filteredLog.map((ev) => (
              <EventRow key={ev.id} ev={ev} onSelect={setSelectedEvent} />
            ))}
            <div ref={eventEndRef} />
          </div>
        </div>

        {/* Event detail */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-neutral-800 shrink-0">
            <span className="text-xs text-neutral-500 font-mono uppercase tracking-widest">Event Detail</span>
            {selectedEvent && (
              <span className={`ml-2 text-xs font-mono ${DIR_COLOR[selectedEvent.direction]}`}>
                {selectedEvent.type}
              </span>
            )}
          </div>
          <div className="flex-1 overflow-auto p-2">
            {selectedEvent ? (
              <pre className="text-[10px] text-neutral-300 font-mono whitespace-pre-wrap break-all">
                {JSON.stringify(selectedEvent.payload, null, 2)}
              </pre>
            ) : (
              <p className="text-neutral-700 text-xs font-mono p-2">Click an event to inspect</p>
            )}
          </div>
        </div>

        {/* Transcript */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-neutral-800 shrink-0">
            <span className="text-xs text-neutral-500 font-mono uppercase tracking-widest">Transcript</span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {messages.length === 0 && (
              <p className="text-neutral-700 text-xs font-mono">No messages yet</p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`text-xs rounded px-2 py-1.5 ${m.role === "user" ? "bg-blue-950 text-blue-200 self-end" : "bg-neutral-800 text-neutral-200"}`}>
                <div className="text-[10px] text-neutral-500 font-mono mb-0.5">
                  {m.role === "user" ? "You" : "AI"} · {new Date(m.ts).toLocaleTimeString()}
                </div>
                {m.text}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Row 3: Text Injection + Regression Tests ────────────────────────── */}
      <div className="grid grid-cols-[400px_1fr] gap-4">
        {/* Text injection */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 space-y-3">
          <div className="text-xs text-neutral-500 font-mono uppercase tracking-widest">Text Injection (no mic)</div>
          <div className="flex gap-2">
            <input
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleInject(); }}
              disabled={!isConnected}
              placeholder="Type a message to inject…"
              className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs font-mono text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-500 disabled:opacity-40"
            />
            <button
              onClick={handleInject}
              disabled={!isConnected || !textInput.trim()}
              className="px-3 py-1.5 text-xs font-mono rounded bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 transition-colors"
            >
              Send
            </button>
          </div>
          {/* Quick inject presets */}
          <div className="flex flex-wrap gap-1">
            {[
              "Hi",
              "Tôi muốn đặt lịch làm móng tay",
              "What services do you have?",
              "Book for tomorrow at 2pm",
            ].map((preset) => (
              <button
                key={preset}
                onClick={() => { injectText(preset); }}
                disabled={!isConnected}
                className="px-2 py-0.5 text-[10px] font-mono rounded bg-neutral-800 border border-neutral-700 hover:border-neutral-500 text-neutral-400 hover:text-neutral-200 disabled:opacity-30 transition-colors"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        {/* Regression tests */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-neutral-500 font-mono uppercase tracking-widest">Regression Tests</span>
            <button
              onClick={async () => {
                for (const test of BUILT_IN_TESTS) {
                  await handleRunTest(test);
                  // brief pause between tests
                  await new Promise((r) => setTimeout(r, 1000));
                }
              }}
              disabled={!isConnected || runningTestId !== null}
              className="px-2 py-0.5 text-[10px] font-mono rounded bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 border border-neutral-600"
            >
              Run All
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto">
            {BUILT_IN_TESTS.map((test) => {
              const result = testResults.find((r) => r.test.id === test.id);
              const isRunning = runningTestId === test.id;
              return (
                <div
                  key={test.id}
                  className={`rounded px-2 py-1.5 border text-[10px] font-mono space-y-0.5 ${
                    isRunning ? "border-yellow-700 bg-yellow-950"
                    : result?.passed ? "border-green-800 bg-green-950"
                    : result ? "border-red-800 bg-red-950"
                    : "border-neutral-700 bg-neutral-800"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-neutral-300">{test.name}</span>
                    {isRunning && <span className="text-yellow-400 shrink-0">…</span>}
                    {!isRunning && result && (
                      <span className={result.passed ? "text-green-400 shrink-0" : "text-red-400 shrink-0"}>
                        {result.passed ? "✓" : "✗"}
                      </span>
                    )}
                  </div>
                  {result && (
                    <div className="text-neutral-500 truncate">
                      {result.actualToolName ? `→ ${result.actualToolName}` : result.error ?? "no tool"}
                      {result.durationMs ? ` ${result.durationMs}ms` : ""}
                    </div>
                  )}
                  {!result && !isRunning && (
                    <button
                      onClick={() => handleRunTest(test)}
                      disabled={!isConnected || runningTestId !== null}
                      className="text-neutral-600 hover:text-neutral-300 disabled:opacity-30 underline"
                    >
                      run
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
