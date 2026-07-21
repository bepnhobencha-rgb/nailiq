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
// Platform-wide Realtime model (mirrors the app's VOICE_MODEL). Known before the
// phone-config fetch returns, so the socket can connect in parallel with it —
// the caller is not left in silence while one waits on the other.
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1";
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
  let userTurnCount = 0;
  const handledToolCallIds = new Set<string>();
  // The session.update carrying the salon's brain has been sent — until then we
  // do not forward caller audio (it would be handled with the default config).
  let sessionConfigured = false;
  // Has the agent produced ANY audio yet? If the opening lookup_customer runs
  // before a single word was spoken, the caller is sitting in dead air — we must
  // let a reply through to greet, not suppress it.
  let greetingSpoken = false;
  // The agent asked to end the call (end_call). Hang up once its farewell has
  // finished playing — never mid-word.
  let hangupPending = false;
  let hangupTimer: ReturnType<typeof setTimeout> | null = null;
  // Watchdog: last time the response pipeline made progress (audio out, or a
  // response created/ended). If the coordinator stays busy with no progress, a
  // response.done was likely missed and the agent has gone silent — recover.
  let lastProgressAt = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let openaiWs: WebSocket | null = null;
  let closed = false;

  // The single response coordinator for this call — the ONLY place a
  // response.create is emitted (server_vad create_response is off). Everything
  // that wants the agent to speak goes through coordinator.request(); it keeps
  // exactly one response active, queues the rest, gives a protected say_this
  // priority, and tracks responses by id so one response's end never tears down
  // another's barge-in protection.
  const coordinator = createResponseCoordinator((msg) => {
    // Reset the watchdog clock whenever a response is DISPATCHED, so its 8s
    // window measures time-since-dispatch — not stale history. Without this, the
    // first reply after a long caller silence looked "stalled for 11s" the instant
    // it dispatched, and the watchdog recovered a coordinator that was perfectly
    // fine (false positive).
    if ((msg as { type?: string }).type === "response.create") lastProgressAt = Date.now();
    openaiWs?.send(JSON.stringify(msg));
  });

  // Stall watchdog. A response.done can be missed (id mismatch), leaving the
  // coordinator "busy" forever so it never speaks again — the caller hears dead
  // air for the rest of the call. If it stays busy with no audio/lifecycle
  // progress for 8s, force it back to a serving state. 8s is far longer than any
  // real response, so this only fires on a genuine stall, never mid-sentence.
  watchdog = setInterval(() => {
    if (closed || !coordinator.isBusy()) return;
    if (Date.now() - lastProgressAt < 8000) return;
    const { recovered } = coordinator.forceRecover();
    if (recovered) {
      lastProgressAt = Date.now();
      console.warn("[voice-bridge] watchdog: recovered a stalled response coordinator (missed response.done?)");
    }
  }, 2000);

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
      // No separate acknowledgement response. The per-turn reply (fired on
      // input_audio_buffer.committed) already answers THIS turn in the caller's
      // spoken language — a second "ack" response produced a confusing double turn
      // that re-asked for things already known. The session.update above makes the
      // new language stick for every following turn.
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
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    coordinator.onClose();         // stop the queue; no more sends after hangup
    void finalizeSession();
    try { openaiWs?.close(); } catch { /* noop */ }
    try { twilioWs.close(); } catch { /* noop */ }
  };

  // Hang up shortly after the farewell — long enough for the last audio frames to
  // drain to Twilio, so the caller hears the whole goodbye, then the line drops.
  const scheduleHangup = () => {
    if (hangupTimer || closed) return;
    hangupTimer = setTimeout(() => closeAll(), 1200);
  };

  const runTool = async (name: string, args: Record<string, unknown>, callId: string) => {
    // end_call is a TRANSPORT action, not a DB one — only the bridge can hang up
    // the phone. Answer the tool so the model isn't left waiting, then drop the
    // line once its farewell (already spoken, per the prompt) finishes playing.
    if (name === "end_call") {
      openaiWs?.send(JSON.stringify(functionCallOutput(callId, { ok: true })));
      hangupPending = true;
      if (!coordinator.isBusy()) scheduleHangup();  // farewell already done → hang up now
      return;                                        // no follow-up response
    }

    // Snapshot this before the network round trip. The caller may begin speaking
    // while lookup_customer is in flight; that must not turn the silent opening
    // enrichment into a late duplicate greeting when the result returns.
    const isOpeningLookup = name === "lookup_customer" && userTurnCount === 0;
    {
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
      } else if (!isOpeningLookup || !greetingSpoken) {
        // Normally the opening lookup enriches silently — the opening response
        // already greeted, so a forced follow-up would just repeat it. BUT if the
        // agent called lookup_customer WITHOUT speaking first (greetingSpoken is
        // still false), the caller is sitting in dead air on pickup — let the
        // reply through so it finally greets (now personalised by the lookup).
        coordinator.request({ kind: "normal", build: plainResponseCreate, language: () => currentLang });
      }
    }
  };

  type PhoneConfig = { model: string; voice: string; instructions: string; tools: unknown[]; sessionId?: string | null; language?: string };

  const startOpenAi = () => {
    // Open the socket AND fetch the salon's brain at the SAME time, then greet the
    // instant both are ready. A real receptionist answers immediately; the old
    // serial chain (await config → then connect → then greet) left the caller in
    // silence for a couple of seconds, so they said "hello?" into a dead line.
    let cfg: PhoneConfig | null = null;
    let wsOpen = false;
    const greetWhenReady = () => {
      if (sessionConfigured || !wsOpen || !cfg) return;
      sessionConfigured = true;
      openaiWs?.send(JSON.stringify(sessionUpdateMessage({
        instructions: cfg.instructions, voice: cfg.voice, tools: cfg.tools, transcribeLang: currentLang,
      })));
      // Greet through the coordinator — with create_response:false it is the only
      // way a response gets made, and it keeps the greet inside the one-at-a-time
      // discipline like every other response.
      coordinator.request({ kind: "normal", build: plainResponseCreate, language: () => currentLang });
      console.log("[voice-bridge] configured + greeting");
    };

    // The caller's carrier-verified number; newSession=true creates the session row.
    fetch(`${NEXT_APP_URL}/api/voice/phone-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-voice-bridge-secret": BRIDGE_SECRET },
      body: JSON.stringify({ slug, from, newSession: true }),
    }).then(async (r) => {
      if (!r.ok) { console.warn("[voice-bridge] phone-config FAILED", r.status); return closeAll(); }
      cfg = (await r.json()) as PhoneConfig;
      sessionId = cfg.sessionId ?? "";
      currentLang = cfg.language ?? "en";
      if (cfg.model && cfg.model !== REALTIME_MODEL) {
        console.warn(`[voice-bridge] config model ${cfg.model} != socket model ${REALTIME_MODEL}`);
      }
      console.log(`[voice-bridge] phone-config ok lang=${currentLang} session=${sessionId || "(none)"}`);
      greetWhenReady();
    }).catch((e) => { console.warn("[voice-bridge] phone-config error", e); closeAll(); });

    // GA Realtime API — no `OpenAI-Beta` header. The model is platform-wide, so we
    // connect without waiting for the config fetch above.
    openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } },
    );

    openaiWs.on("open", () => { wsOpen = true; console.log("[voice-bridge] openai WS connected"); greetWhenReady(); });

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
      } else if (t === "input_audio_buffer.speech_started") {
        // Instrumentation for the dead-air investigation — these events are
        // otherwise hidden (suppressed as "audio" below).
        console.log(`[voice-bridge] speech_started (busy=${coordinator.isBusy()})`);
      } else if (t === "input_audio_buffer.committed") {
        console.log(`[voice-bridge] committed → request reply (busy=${coordinator.isBusy()})`);
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
        const rid = extractResponseId(evt) ?? "";
        lastProgressAt = Date.now();
        console.log(`[voice-bridge] response.created id=${rid || "(none)"}`);
        coordinator.onResponseCreated(rid);
      } else if (t === "response.done" || t === "response.cancelled") {
        const rid = extractResponseId(evt) ?? "";
        lastProgressAt = Date.now();
        console.log(`[voice-bridge] ${t} id=${rid || "(none)"} (activeMatch=${coordinator.isBusy()})`);
        coordinator.onResponseEnded(rid);
        // If the agent ended the call, the farewell just finished — hang up.
        if (hangupPending && !coordinator.isBusy()) scheduleHangup();
      } else if (t.includes("error")) {
        coordinator.onError();
      }

      const audio = extractAudioDelta(evt);
      if (audio && streamSid) {
        lastProgressAt = Date.now();   // the pipeline is producing audio — not stalled
        greetingSpoken = true;         // the caller has now heard the agent speak
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
      // Hold caller audio until the salon brain is configured — audio sent before
      // session.update would be handled with the wrong (default) language/config.
      if (sessionConfigured && openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify(appendAudioMessage(msg.media.payload)));
      }
    } else if (msg.event === "stop") {
      closeAll();
    }
  });

  twilioWs.on("close", closeAll);
  twilioWs.on("error", closeAll);
});
