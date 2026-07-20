/**
 * NailIQ AI Receptionist — phone voice bridge.
 *
 * A persistent WebSocket service (Vercel serverless cannot hold a socket for a
 * whole call) that bridges a Twilio Voice Media Stream to an OpenAI Realtime
 * session. The AGENT itself (prompt + tools + booking logic) stays in the Next
 * app — this process only moves audio and relays tool calls, so web and phone
 * run the exact same brain.
 *
 * Per call:
 *   Twilio <Connect><Stream> ─ μ-law 8k ─▶ this bridge ─▶ OpenAI Realtime
 *   OpenAI audio deltas ─────────────────▶ this bridge ─▶ Twilio playback
 *   OpenAI function calls ─▶ POST {NEXT}/api/voice/tool (with the caller's
 *     carrier-verified `From` as callerVerifiedPhone + the bridge secret).
 *
 * Env: PORT, OPENAI_API_KEY, NEXT_APP_URL, VOICE_BRIDGE_SECRET.
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  sessionUpdateMessage,
  detectLanguage,
  appendAudioMessage,
  twilioMediaFrame,
  twilioClearFrame,
  functionCallOutputMessages,
  extractAudioDelta,
  extractFunctionCall,
  isSpeechStarted,
  type TwilioInbound,
} from "./router.js";

const PORT = Number(process.env.PORT ?? 8080);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const NEXT_APP_URL = (process.env.NEXT_APP_URL ?? "https://nailiq.ca").replace(/\/$/, "");
const BRIDGE_SECRET = process.env.VOICE_BRIDGE_SECRET ?? "";

// Plain HTTP is only for the health check; real traffic is the WS upgrade.
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(426); res.end("upgrade required");
});
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, () => console.log(`[voice-bridge] listening on :${PORT}`));

wss.on("connection", (twilioWs) => {
  console.log("[voice-bridge] twilio WS connected");
  let streamSid = "";
  let slug = "";
  let from = "";
  let sessionId = "";
  // The caller's most recent transcribed turn. Sent with tool calls so the
  // server can verify the booking time against what the caller actually said —
  // trusted there only because it arrives with the bridge secret.
  let lastUserUtterance = "";
  let currentLang = "en";
  let switchingLang = false;
  let openaiWs: WebSocket | null = null;
  let closed = false;

  // Mid-call language switch. The session opens in the salon's default language;
  // if the caller clearly speaks a different supported one, re-fetch the prompt
  // in that language and re-configure the live session. Mirrors what the web
  // widget does, which the phone channel never had — a Vietnamese caller was
  // stuck talking to an English agent.
  const maybeSwitchLanguage = async (userText: string) => {
    if (switchingLang) return;
    const detected = detectLanguage(userText);
    if (!detected || detected === currentLang) return;
    switchingLang = true;
    try {
      const r = await fetch(`${NEXT_APP_URL}/api/voice/phone-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-voice-bridge-secret": BRIDGE_SECRET },
        body: JSON.stringify({ slug, from, language: detected }),   // no newSession → no new row
      });
      if (!r.ok) return;
      const c = (await r.json()) as { instructions: string; voice: string; tools: unknown[] };
      currentLang = detected;
      openaiWs?.send(JSON.stringify(sessionUpdateMessage({
        instructions: c.instructions, voice: c.voice, tools: c.tools, transcribeLang: detected,
      })));
      console.log(`[voice-bridge] switched language → ${detected}`);
    } catch { /* best-effort — the call continues in the current language */ }
    finally { switchingLang = false; }
  };

  // Conversation record for owner/admin review — the phone equivalent of what
  // the web widget captures. Written to voice_ai_sessions.transcript at hangup.
  const transcript: { role: "ai" | "user"; text: string }[] = [];
  const startedAt = Date.now();

  const finalizeSession = async () => {
    if (!sessionId) return;
    try {
      await fetch(`${NEXT_APP_URL}/api/voice/session/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-voice-bridge-secret": BRIDGE_SECRET },
        body: JSON.stringify({
          sessionId,
          durationSeconds: Math.round((Date.now() - startedAt) / 1000),
          transcript,
          status: "completed",
        }),
      });
    } catch { /* best-effort — losing the record must not throw on hangup */ }
  };

  const closeAll = () => {
    if (closed) return;
    closed = true;
    void finalizeSession();
    try { openaiWs?.close(); } catch { /* noop */ }
    try { twilioWs.close(); } catch { /* noop */ }
  };

  const runTool = async (name: string, args: Record<string, unknown>, callId: string) => {
    let result: unknown;
    try {
      const r = await fetch(`${NEXT_APP_URL}/api/voice/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-voice-bridge-secret": BRIDGE_SECRET },
        // sessionId threads the tool call into tool_log; lastUserUtterance lets
        // the server check the booking time against what the caller just said.
        body: JSON.stringify({ toolName: name, toolArgs: args, salonSlug: slug, callerVerifiedPhone: from, sessionId: sessionId || null, lastUserUtterance }),
      });
      result = await r.json().catch(() => ({ error: "tool_parse_failed" }));
    } catch {
      result = { error: "tool_unavailable" };
    }
    for (const msg of functionCallOutputMessages(callId, result)) {
      openaiWs?.send(JSON.stringify(msg));
    }
  };

  const startOpenAi = async () => {
    // Fetch the agent config (instructions + tools + voice + model) from Next.
    let cfg: { model: string; voice: string; instructions: string; tools: unknown[]; sessionId?: string | null; language?: string };
    try {
      const r = await fetch(`${NEXT_APP_URL}/api/voice/phone-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-voice-bridge-secret": BRIDGE_SECRET },
        // `from` is the carrier-verified caller number. newSession=true marks this
        // as the call-opening fetch (creates the session row); language switches
        // re-fetch without it.
        body: JSON.stringify({ slug, from, newSession: true }),
      });
      if (!r.ok) { console.warn("[voice-bridge] phone-config FAILED", r.status); return closeAll(); }
      cfg = (await r.json()) as typeof cfg;
      sessionId = cfg.sessionId ?? "";
      currentLang = cfg.language ?? "en";
      console.log(`[voice-bridge] phone-config ok model=${cfg.model} lang=${currentLang} session=${sessionId || "(none)"}`);
    } catch (e) {
      console.warn("[voice-bridge] phone-config error", e);
      return closeAll();
    }

    // GA Realtime API — no `OpenAI-Beta` header (the Beta shape was retired).
    openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(cfg.model)}`,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } },
    );

    openaiWs.on("open", () => {
      console.log("[voice-bridge] openai WS connected — sending session.update + greet");
      openaiWs?.send(JSON.stringify(sessionUpdateMessage({ instructions: cfg.instructions, voice: cfg.voice, tools: cfg.tools, transcribeLang: currentLang })));
      openaiWs?.send(JSON.stringify({ type: "response.create" })); // greet first
    });

    openaiWs.on("message", (raw) => {
      let evt: Record<string, unknown>;
      try { evt = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }

      // Surface OpenAI session/response errors + lifecycle events (but not the
      // high-frequency audio deltas) so a failed session.update is visible.
      const t = typeof evt.type === "string" ? evt.type : "";
      if (t.includes("error")) {
        console.warn("[voice-bridge] openai EVENT", raw.toString().slice(0, 600));
      } else if (!t.includes("audio") && !t.includes("delta")) {
        console.log("[voice-bridge] openai evt:", t);
      }

      // Capture finished transcripts for the review log. The agent's spoken
      // turn and the caller's transcribed turn arrive as separate event types.
      if (t === "response.output_audio_transcript.done" || t === "response.audio_transcript.done") {
        const txt = typeof evt.transcript === "string" ? evt.transcript.trim() : "";
        if (txt) transcript.push({ role: "ai", text: txt });
      } else if (t === "conversation.item.input_audio_transcription.completed") {
        const txt = typeof evt.transcript === "string" ? evt.transcript.trim() : "";
        if (txt) {
          transcript.push({ role: "user", text: txt });
          lastUserUtterance = txt;   // most recent caller turn, for the time guard
          void maybeSwitchLanguage(txt);
        }
      }

      const audio = extractAudioDelta(evt);
      if (audio && streamSid) {
        twilioWs.send(JSON.stringify(twilioMediaFrame(streamSid, audio)));
        return;
      }
      if (isSpeechStarted(evt) && streamSid) {
        twilioWs.send(JSON.stringify(twilioClearFrame(streamSid))); // barge-in
        return;
      }
      const fn = extractFunctionCall(evt);
      if (fn) void runTool(fn.name, fn.args, fn.callId);
    });

    openaiWs.on("close", closeAll);
    openaiWs.on("error", (e) => { console.warn("[voice-bridge] openai error", e); closeAll(); });
  };

  twilioWs.on("message", (raw) => {
    let msg: TwilioInbound;
    try { msg = JSON.parse(raw.toString()) as TwilioInbound; } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      slug = msg.start.customParameters?.slug ?? "";
      from = msg.start.customParameters?.from ?? "";
      console.log(`[voice-bridge] START slug=${slug || "(none)"} from=${from || "(none)"} openaiKey=${OPENAI_API_KEY ? "set" : "MISSING"} bridgeSecret=${BRIDGE_SECRET ? "set" : "MISSING"}`);
      if (!slug || !OPENAI_API_KEY || !BRIDGE_SECRET) { console.warn("[voice-bridge] closing: missing slug/key/secret"); return closeAll(); }
      void startOpenAi();
    } else if (msg.event === "media") {
      if (openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify(appendAudioMessage(msg.media.payload)));
      }
    } else if (msg.event === "stop") {
      closeAll();
    }
  });

  twilioWs.on("close", closeAll);
  twilioWs.on("error", closeAll);
});
