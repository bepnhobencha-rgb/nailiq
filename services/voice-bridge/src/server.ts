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
  resolveSwitchLanguage,
  appendAudioMessage,
  twilioMediaFrame,
  twilioClearFrame,
  functionCallOutput,
  plainResponseCreate,
  languageAckResponseCreate,
  extractSayThis,
  sayThisResponseCreate,
  createResponseCoordinator,
  extractAudioDelta,
  extractFunctionCall,
  extractResponseId,
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
  // How many tool calls are mid-flight. A confirm_booking that is running may be
  // about to return a protected say_this, so a language switch during it must NOT
  // fire its own acknowledgement — the say_this confirms in the new language.
  let toolInFlight = 0;
  let userTurnCount = 0;
  const handledToolCallIds = new Set<string>();
  let openaiWs: WebSocket | null = null;
  let closed = false;

  // The single response coordinator for this call — the ONLY place a
  // response.create is emitted (server_vad create_response is off). Everything
  // that wants the agent to speak goes through coordinator.request(); it keeps
  // exactly one response active, queues the rest, gives a protected say_this
  // priority, and tracks responses by id so one response's end never tears down
  // another's barge-in protection.
  const coordinator = createResponseCoordinator((msg) => openaiWs?.send(JSON.stringify(msg)));

  // Mid-call language switch. Opens in the salon's default language; if the
  // caller ASKS for another supported one ("in Spanish?") or clearly SPEAKS it,
  // switch. currentLang is updated FIRST — synchronously — so a say_this that is
  // queued behind an in-flight response is composed in the NEW language when it
  // finally plays. The heavy reconfigure (re-fetch the prompt, session.update)
  // runs async; the acknowledgement goes through the coordinator, which drops it
  // if a protected say_this is already coming (that line confirms in the new
  // language on its own). Returns true if a switch was initiated, so the caller
  // does not ALSO fire a normal response for this turn.
  const reconfigureLanguage = async (target: string) => {
    try {
      const r = await fetch(`${NEXT_APP_URL}/api/voice/phone-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-voice-bridge-secret": BRIDGE_SECRET },
        body: JSON.stringify({ slug, from, language: target }),   // no newSession → no new row
      });
      if (r.ok) {
        const c = (await r.json()) as { instructions: string; voice: string; tools: unknown[] };
        // Reconfigure prompt/voice/tools + transcriber language. Preserve the
        // live barge-in state: if a protected say_this is playing right now, keep
        // interruption OFF so this session.update does not un-protect it.
        openaiWs?.send(JSON.stringify(sessionUpdateMessage({
          instructions: c.instructions, voice: c.voice, tools: c.tools,
          transcribeLang: target, interruptResponse: !coordinator.isProtectedActive(),
        })));
      }
      // Acknowledge in the new language — but only if no tool result is pending
      // (a say_this from it would confirm in the new language on its own, and the
      // coordinator drops the ack anyway once that protected line is queued).
      if (toolInFlight === 0) {
        coordinator.request({
          kind: "ack",
          build: () => languageAckResponseCreate(currentLang),
          language: () => currentLang,
        });
      }
      console.log(`[voice-bridge] switched language → ${target}`);
    } catch { /* best-effort — the call continues in the current language */ }
    finally { switchingLang = false; }
  };

  const maybeSwitchLanguage = (userText: string): boolean => {
    if (switchingLang) return true;   // a switch is already in flight for this turn
    const target = resolveSwitchLanguage(userText, currentLang);
    if (!target) return false;
    switchingLang = true;
    currentLang = target;             // update FIRST so a queued say_this speaks the new language
    void reconfigureLanguage(target);
    return true;
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
          language: currentLang,   // persist the language the call ended in
        }),
      });
    } catch { /* best-effort — losing the record must not throw on hangup */ }
  };

  const closeAll = () => {
    if (closed) return;
    closed = true;
    coordinator.onClose();         // stop the queue; no more sends after hangup
    void finalizeSession();
    try { openaiWs?.close(); } catch { /* noop */ }
    try { twilioWs.close(); } catch { /* noop */ }
  };

  const runTool = async (name: string, args: Record<string, unknown>, callId: string) => {
    // Snapshot this before the network round trip. The caller may begin speaking
    // while lookup_customer is in flight; that must not turn the silent opening
    // enrichment into a late duplicate greeting when the result returns.
    const isOpeningLookup = name === "lookup_customer" && userTurnCount === 0;
    toolInFlight++;   // a switch during this must not fire its own ack (say_this may confirm instead)
    try {
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

      // Hand the tool result back (a conversation item, NOT a response), then ask
      // the coordinator for exactly one follow-up response — it decides when to
      // actually emit response.create so nothing races an in-flight response.
      openaiWs?.send(JSON.stringify(functionCallOutput(callId, result)));

      const sayThis = extractSayThis(result);
      if (sayThis) {
        // A server-composed line (booking confirmation, OTP notice). Protected:
        // the coordinator turns barge-in OFF for it (echo cannot cut it) and reads
        // it verbatim in the language current AT PLAY TIME, then restores barge-in
        // when this exact response ends.
        coordinator.request({
          kind: "protected",
          build: () => sayThisResponseCreate(sayThis, currentLang),
          language: () => currentLang,
        });
      } else if (!isOpeningLookup) {
        // The opening response has already greeted the caller. Its background
        // lookup must enrich the conversation silently, otherwise the forced
        // follow-up repeats the greeting/question before the caller can answer.
        coordinator.request({ kind: "normal", build: plainResponseCreate, language: () => currentLang });
      }
    } finally {
      toolInFlight--;
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
      // Greet through the coordinator — with create_response:false it is the only
      // way a response gets made, and it keeps the greet inside the one-at-a-time
      // discipline like every other response.
      coordinator.request({ kind: "normal", build: plainResponseCreate, language: () => currentLang });
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
      } else if (t === "input_audio_buffer.committed") {
        // The caller's turn just closed. Ask for the reply NOW — do not wait for
        // the transcription to come back. gpt-realtime is speech-to-speech: it
        // answers the AUDIO directly, so gating the response on Whisper finishing
        // added seconds of dead air per turn on 8 kHz phone audio, and the caller
        // filled the silence with "are you there?" — which then barged in and cut
        // the late reply. Firing here removes that latency. (A language switch,
        // detected once the transcript lands, still adds its own reply on top.)
        coordinator.request({ kind: "normal", build: plainResponseCreate, language: () => currentLang });
      } else if (t === "conversation.item.input_audio_transcription.completed") {
        // The transcript lands a beat after the reply was already requested. Use
        // it only for the record, the time-guard utterance, and — if the caller
        // asked to change language — the switch (which fires its own reply in the
        // new language via the coordinator).
        const txt = typeof evt.transcript === "string" ? evt.transcript.trim() : "";
        if (txt) {
          transcript.push({ role: "user", text: txt });
          lastUserUtterance = txt;   // most recent caller turn, for the time guard
          userTurnCount++;
          maybeSwitchLanguage(txt);
        }
      }

      // Response lifecycle → the coordinator gates barge-in and restores
      // protection, always keyed to the response's own id so one response's end
      // never finishes another. Errors clear the in-flight response and restore
      // barge-in if it was protected, so the call is never left stuck.
      if (t === "response.created") {
        coordinator.onResponseCreated(extractResponseId(evt) ?? "");
      } else if (t === "response.done" || t === "response.cancelled") {
        coordinator.onResponseEnded(extractResponseId(evt) ?? "");
      } else if (t.includes("error")) {
        coordinator.onError();
      }

      const audio = extractAudioDelta(evt);
      if (audio && streamSid) {
        twilioWs.send(JSON.stringify(twilioMediaFrame(streamSid, audio)));
        return;
      }
      if (isSpeechStarted(evt) && streamSid) {
        // Only flush Twilio playback when an UNPROTECTED response is actually
        // playing. Clearing in dead air did nothing but muddy state; clearing
        // over a protected line let echo cut the confirmation off mid-word.
        if (coordinator.shouldClearOnSpeech()) {
          twilioWs.send(JSON.stringify(twilioClearFrame(streamSid)));
        }
        return;
      }
      const fn = extractFunctionCall(evt);
      if (fn && !handledToolCallIds.has(fn.callId)) {
        // The GA API may describe the same completed function call through both
        // response.function_call_arguments.done and response.output_item.done.
        // call_id is the idempotency key: execute and answer exactly once.
        handledToolCallIds.add(fn.callId);
        void runTool(fn.name, fn.args, fn.callId);
      }
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
