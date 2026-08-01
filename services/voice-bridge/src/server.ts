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
  normalizeAllowedLangs,
  appendAudioMessage,
  twilioMediaFrame,
  twilioClearFrame,
  twilioMarkFrame,
  extractMarkName,
  createHangupController,
  HANGUP_FALLBACK_MS,
  TOOL_REQUEST_TIMEOUT_MS,
  voiceToolMaxAttempts,
  isSilentTransportTool,
  callerPresenceLabel,
  voiceSessionStatusForClose,
  finalizeVoiceSession,
  functionCallOutput,
  plainResponseCreate,
  zeroAudioRecoveryResponseCreate,
  summarizeRealtimeResponseDone,
  addRealtimeUsage,
  EMPTY_REALTIME_USAGE,
  realtimeUsageFromEvent,
  summarizeRealtimeRateLimitsUpdated,
  isTokenRateLimitExceeded,
  shouldHoldCoordinatorForToolResult,
  createTokenRateLimitRecoveryGuard,
  tokenRateLimitComfortTonePayloads,
  createZeroAudioRecoveryGuard,
  openingGreetingResponseCreate,
  openingLookupFollowupResponseCreate,
  extractSayThis,
  sayThisResponseCreate,
  farewellResponseCreate,
  shouldQueuePinnedFarewellAfterEndCall,
  createResponseCoordinator,
  extractAudioDelta,
  extractFunctionCall,
  extractResponseId,
  isSpeechStarted,
  type TwilioInbound,
  type RealtimeUsage,
  type SupportedLang,
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
  let callSid = "";
  let slug = "";
  let from = "";
  let to = "";
  let sessionId = "";
  // The caller's most recent transcribed turn. Sent with tool calls so the
  // server can verify the booking time against what the caller actually said —
  // trusted there only because it arrives with the bridge secret.
  let lastUserUtterance = "";
  let currentLang = "en";
  let allowedLangs: SupportedLang[] = normalizeAllowedLangs(null);
  let switchingLang = false;
  let userTurnCount = 0;
  let endCallRequested = false;
  let forcedFarewellAttempts = 0;
  const handledToolCallIds = new Set<string>();
  const usageEventIds = new Set<string>();
  let realtimeUsage: RealtimeUsage = { ...EMPTY_REALTIME_USAGE };
  // The session.update carrying the salon's brain has been sent — until then we
  // do not forward caller audio (it would be handled with the default config).
  let sessionConfigured = false;
  // Has the agent produced ANY audio yet? If the opening lookup_customer runs
  // before a single word was spoken, the caller is sitting in dead air — we must
  // let a reply through to greet, not suppress it.
  // The agent asked to end the call (end_call). The hangup controller (created
  // below, after closeAll exists) hangs up only once the farewell has actually
  // PLAYED — never mid-word.
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
        const c = (await r.json()) as {
          instructions: string;
          voice: string;
          tools: unknown[];
          allowedLanguages?: unknown;
          language?: unknown;
        };
        allowedLangs = normalizeAllowedLangs(c.allowedLanguages);
        currentLang = typeof c.language === "string"
          && allowedLangs.includes(c.language as SupportedLang)
          ? c.language
          : allowedLangs[0]!;
        // Reconfigure prompt/voice/tools + transcriber language. Preserve the
        // live barge-in state: if a protected say_this is playing right now, keep
        // interruption OFF so this session.update does not un-protect it.
        openaiWs?.send(JSON.stringify(sessionUpdateMessage({
          instructions: c.instructions, voice: c.voice, tools: c.tools,
          transcribeLang: currentLang, interruptResponse: !coordinator.isProtectedActive(),
        })));
      }
      // No separate acknowledgement response. The per-turn reply (fired on
      // input_audio_buffer.committed) already answers THIS turn in the caller's
      // spoken language — a second "ack" response produced a confusing double turn
      // that re-asked for things already known. The session.update above makes the
      // new language stick for every following turn.
      console.log(`[voice-bridge] switched language → ${currentLang}`);
    } catch { /* best-effort — the call continues in the current language */ }
    finally { switchingLang = false; }
  };

  const maybeSwitchLanguage = (userText: string): boolean => {
    if (switchingLang) return true;   // a switch is already in flight for this turn
    const target = resolveSwitchLanguage(userText, currentLang, allowedLangs);
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

  // ── Per-leg latency telemetry ─────────────────────────────────────────────
  // One structured JSON line per event so the logs can be grepped and charted:
  //   [telemetry] {"call":"MZ…","event":"first_audio","t":8123,"sinceCommitMs":640,…}
  // `t` is ms since the Twilio WS connected. This instruments the exact chain
  // that was previously unmeasured: caller stops speaking → response created →
  // tool call → bridge HTTP round trip (+ the server's own Server-Timing
  // breakdown) → tool output sent → first audio after the tool → Twilio mark
  // played → call closed. Telemetry must never break a call — hence the guard.
  const logT = (event: string, fields: Record<string, unknown> = {}) => {
    try {
      console.log("[telemetry]", JSON.stringify({ call: streamSid || sessionId || "(pending)", event, t: Date.now() - startedAt, ...fields }));
    } catch { /* noop */ }
  };
  // Per-turn timing marks. Zero = "not currently measuring that leg".
  let turnCommittedAt = 0;    // caller's turn closed (input_audio_buffer.committed)
  let responseCreatedAt = 0;  // the active response's response.created
  let firstAudioSeen = true;  // first audio delta of the active response already logged?
  let responseAudioDeltaCount = 0;
  let responseAudioBase64Chars = 0;
  let toolOutputSentAt = 0;   // last function_call_output sent → measures tool→audio gap
  const zeroAudioRecovery = createZeroAudioRecoveryGuard();
  const tokenRateLimitRecovery = createTokenRateLimitRecoveryGuard();
  let tokenRateLimitRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let tokenRateLimitCooldownUntil = 0;
  let coalescedRateLimitedTurns = 0;
  let inFlightBusinessTools = 0;
  let toolResultBarrierActive = false;
  let transportHandoffStarted = false;

  const resumeCoordinatorIfUnblocked = () => {
    if (!transportHandoffStarted && !tokenRateLimitRetryTimer && inFlightBusinessTools === 0) {
      coordinator.resume();
    }
  };

  const clearTokenRateLimitCooldown = () => {
    if (tokenRateLimitRetryTimer) {
      clearTimeout(tokenRateLimitRetryTimer);
      tokenRateLimitRetryTimer = null;
    }
    tokenRateLimitCooldownUntil = 0;
    coalescedRateLimitedTurns = 0;
    resumeCoordinatorIfUnblocked();
  };

  const playTokenRateLimitComfortTone = () => {
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
    for (const payload of tokenRateLimitComfortTonePayloads()) {
      twilioWs.send(JSON.stringify(twilioMediaFrame(streamSid, payload)));
    }
  };

  const finalizeSession = async (reason: string) => {
    if (!sessionId) return;
    const result = await finalizeVoiceSession({
      url: `${NEXT_APP_URL}/api/voice/session/end`,
      secret: BRIDGE_SECRET,
      payload: {
        sessionId,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        transcript,
        status: voiceSessionStatusForClose({
          reason,
          endCallRequested,
          transportHandoffStarted,
        }),
        language: currentLang,   // persist the language the call ended in
        realtimeUsage,
      },
    });
    logT(result.ok ? "session_finalize_succeeded" : "session_finalize_failed", {
      attempts: result.attempts,
      status: result.status,
      finalizeReason: result.reason,
    });
  };

  const closeAll = (reason = "unspecified") => {
    if (closed) return;
    closed = true;
    logT("call_closed", { reason });
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    if (tokenRateLimitRetryTimer) {
      clearTimeout(tokenRateLimitRetryTimer);
      tokenRateLimitRetryTimer = null;
    }
    hangup.onClose();              // never let the fallback timer fire after teardown
    coordinator.onClose();         // stop the queue; no more sends after hangup
    void finalizeSession(reason);
    try { openaiWs?.close(); } catch { /* noop */ }
    try { twilioWs.close(); } catch { /* noop */ }
  };

  // Playback-aware hangup. `response.done` only means OpenAI finished
  // GENERATING the farewell — Twilio may still hold seconds of it in its
  // playback buffer, so closing on a fixed timer (the old 1.2 s) cut long
  // goodbyes off mid-word and made short ones feel abruptly dropped. Instead:
  // send a named `mark` AFTER the last farewell audio frame; Twilio echoes it
  // back only once everything queued before it has actually PLAYED to the
  // caller; hang up on that echo. A timer survives only as a fallback for when
  // the ack never arrives (caller hung up first, media glitch). The whole
  // lifecycle lives in createHangupController (router.ts) so it is unit-tested;
  // this block only wires in the real Twilio socket, telemetry and closeAll.
  let hangupMarkSentAt = 0;
  const hangup = createHangupController({
    sendMark: (name) => {
      if (closed || !streamSid || twilioWs.readyState !== WebSocket.OPEN) return false;
      hangupMarkSentAt = Date.now();
      twilioWs.send(JSON.stringify(twilioMarkFrame(streamSid, name)));
      logT("hangup_mark_sent");
      return true;
    },
    close: (reason) => {
      if (reason === "farewell_fully_played" && hangupMarkSentAt) {
        logT("hangup_mark_played", { playbackMs: Date.now() - hangupMarkSentAt });
      } else if (reason === "hangup_fallback_timeout") {
        logT("hangup_fallback_fired", { waitedMs: HANGUP_FALLBACK_MS });
      }
      closeAll(reason);
    },
  });

  const runTool = async (name: string, args: Record<string, unknown>, callId: string) => {
    // end_call is a TRANSPORT action, not a DB one — only the bridge can hang up
    // the phone. Answer the tool so the model isn't left waiting. A separate,
    // server-pinned farewell is always queued after this response; only then
    // does the bridge arm the playback-aware hangup.
    if (name === "end_call") {
      openaiWs?.send(JSON.stringify(functionCallOutput(callId, { ok: true })));
      endCallRequested = true;
      logT("end_call_requested", {
        farewellStillGenerating: coordinator.isBusy(),
        audibleFramesSoFar: responseAudioDeltaCount,
      });
      // Wait for response.done before arming hangup. Model-authored audio in
      // this response is not accepted as the final farewell because it may
      // paraphrase or narrate the transport action.
      return;                                        // no follow-up response
    }

    // Silence / background audio is not a conversational turn. Acknowledge the
    // no-op tool to Realtime, then stay silent — creating a response here would
    // make the assistant talk to a TV, another person, or line noise.
    if (isSilentTransportTool(name)) {
      openaiWs?.send(JSON.stringify(functionCallOutput(callId, { ok: true, silent: true })));
      logT("wait_for_user");
      return;                                        // no follow-up response
    }

    // Snapshot this before the network round trip. The caller may begin speaking
    // while lookup_customer is in flight; that must not turn the silent opening
    // enrichment into a late duplicate greeting when the result returns.
    const isOpeningLookup = name === "lookup_customer" && userTurnCount === 0;
    inFlightBusinessTools++;
    try {
      let result: unknown;
      logT("tool_call_started", { tool: name });
      const httpStartedAt = Date.now();
      const maxAttempts = voiceToolMaxAttempts(name);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TOOL_REQUEST_TIMEOUT_MS);
        try {
          const r = await fetch(`${NEXT_APP_URL}/api/voice/tool`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-voice-bridge-secret": BRIDGE_SECRET },
            signal: controller.signal,
            // sessionId threads the tool call into tool_log; lastUserUtterance lets
            // the server check the booking time against what the caller just said.
            body: JSON.stringify({
              toolName: name,
              toolArgs: args,
              salonSlug: slug,
              callerVerifiedPhone: from,
              calledVerifiedPhone: to,
              phoneCallSid: callSid,
              language: currentLang,
              sessionId: sessionId || null,
              lastUserUtterance,
            }),
          });
          const parsed = await r.json().catch(() => ({ error: "tool_parse_failed" }));
          // serverTiming is the tool route's own breakdown (gate / exec / log) —
          // side by side with httpMs it shows whether a slow tool was the network
          // or the database, without guessing.
          logT("tool_http_done", { tool: name, attempt, httpMs: Date.now() - httpStartedAt, status: r.status, serverTiming: r.headers.get("server-timing") });
          if (r.status >= 500 && attempt < maxAttempts) {
            logT("tool_retry", { tool: name, attempt, reason: "server_error" });
            continue;
          }
          result = parsed;
          break;
        } catch {
          const timedOut = controller.signal.aborted;
          logT("tool_http_error", { tool: name, attempt, httpMs: Date.now() - httpStartedAt, reason: timedOut ? "timeout" : "network" });
          if (attempt < maxAttempts) {
            logT("tool_retry", { tool: name, attempt, reason: timedOut ? "timeout" : "network" });
            continue;
          }
          result = {
            error: timedOut ? "tool_timeout" : "tool_unavailable",
            retryable: false,
            // For writes the server may have committed before the response was
            // lost. The prompt must escalate, never blindly repeat the action.
            outcome: maxAttempts === 1 ? "unknown" : "not_completed",
          };
        } finally {
          clearTimeout(timeout);
        }
      }
      result ??= { error: "tool_unavailable", retryable: false, outcome: "not_completed" };

      // Hand the tool result back (a conversation item, NOT a response), then ask
      // the coordinator for exactly one follow-up response — it decides when to
      // actually emit response.create so nothing races an in-flight response.
      openaiWs?.send(JSON.stringify(functionCallOutput(callId, result)));
      toolOutputSentAt = Date.now();
      logT("tool_output_sent", { tool: name });

      if (
        name === "transfer_to_human" &&
        (result as { transportAction?: unknown } | null)?.transportAction === "transfer_call"
      ) {
        // Twilio is redirecting the live parent call away from this Media Stream
        // to <Dial>. Do not let a queued model response talk over ringback; the
        // socket will close naturally as soon as Twilio applies the new TwiML.
        transportHandoffStarted = true;
        coordinator.pause();
        logT("human_transfer_started");
        return;
      }

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
      } else if (isOpeningLookup) {
        // Never swallow an opening lookup result. The previous implementation
        // intentionally emitted no response here after the greeting, which left
        // the caller in silence until they spoke first.
        coordinator.request({
          kind: "normal",
          build: () => openingLookupFollowupResponseCreate(currentLang),
          language: () => currentLang,
        });
        logT("opening_lookup_followup_requested");
      } else {
        coordinator.request({ kind: "normal", build: plainResponseCreate, language: () => currentLang });
      }
    } finally {
      inFlightBusinessTools = Math.max(0, inFlightBusinessTools - 1);
      if (toolResultBarrierActive && inFlightBusinessTools === 0) {
        toolResultBarrierActive = false;
        logT("tool_result_barrier_released", { tool: name });
      }
      resumeCoordinatorIfUnblocked();
    }
  };

  type PhoneConfig = {
    model: string;
    voice: string;
    instructions: string;
    greeting: string;
    tools: unknown[];
    sessionId?: string | null;
    language?: string;
    allowedLanguages?: unknown;
  };

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
      coordinator.request({
        kind: "normal",
        build: () => openingGreetingResponseCreate(currentLang, cfg!.greeting),
        language: () => currentLang,
      });
      console.log("[voice-bridge] configured + greeting");
    };

    // The caller's carrier-verified number; newSession=true creates the session row.
    fetch(`${NEXT_APP_URL}/api/voice/phone-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-voice-bridge-secret": BRIDGE_SECRET },
      body: JSON.stringify({ slug, from, newSession: true }),
    }).then(async (r) => {
      if (!r.ok) { console.warn("[voice-bridge] phone-config FAILED", r.status); return closeAll("phone_config_failed"); }
      cfg = (await r.json()) as PhoneConfig;
      sessionId = cfg.sessionId ?? "";
      allowedLangs = normalizeAllowedLangs(cfg.allowedLanguages);
      currentLang = typeof cfg.language === "string"
        && allowedLangs.includes(cfg.language as SupportedLang)
        ? cfg.language
        : allowedLangs[0]!;
      if (cfg.model && cfg.model !== REALTIME_MODEL) {
        console.warn(`[voice-bridge] config model ${cfg.model} != socket model ${REALTIME_MODEL}`);
      }
      console.log(
        `[voice-bridge] phone-config ok lang=${currentLang} session=${sessionId || "(none)"} ` +
        `promptChars=${cfg.instructions.length} toolsChars=${JSON.stringify(cfg.tools).length} ` +
        `greetingChars=${cfg.greeting.length}`,
      );
      greetWhenReady();
    }).catch((e) => { console.warn("[voice-bridge] phone-config error", e); closeAll("phone_config_error"); });

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
      if (
        t === "response.done" ||
        t === "conversation.item.input_audio_transcription.completed"
      ) {
        const response = evt.response && typeof evt.response === "object"
          ? evt.response as Record<string, unknown>
          : {};
        const identity = typeof evt.event_id === "string"
          ? evt.event_id
          : t === "response.done" && typeof response.id === "string"
            ? `response:${response.id}`
            : null;
        if (!identity || !usageEventIds.has(identity)) {
          if (identity) usageEventIds.add(identity);
          realtimeUsage = addRealtimeUsage(
            realtimeUsage,
            realtimeUsageFromEvent(evt),
          );
        }
      }
      if (t.includes("error")) {
        console.warn("[voice-bridge] openai EVENT", raw.toString().slice(0, 600));
      } else if (!t.includes("audio") && !t.includes("delta")) {
        console.log("[voice-bridge] openai evt:", t);
      }

      if (t === "rate_limits.updated") {
        const limits = summarizeRealtimeRateLimitsUpdated(evt);
        tokenRateLimitRecovery.onRateLimits(limits);
        logT("rate_limits_updated", { limits });
      }

      // Capture finished transcripts for the review log. The agent's spoken
      // turn and the caller's transcribed turn arrive as separate event types.
      if (t === "response.output_audio_transcript.done" || t === "response.audio_transcript.done") {
        const txt = typeof evt.transcript === "string" ? evt.transcript.trim() : "";
        if (txt) transcript.push({ role: "ai", text: txt });
      } else if (t === "input_audio_buffer.speech_started") {
        // Instrumentation for the dead-air investigation — these events are
        // otherwise hidden (suppressed as "audio" below).
        logT("speech_started", { busy: coordinator.isBusy() });
      } else if (t === "input_audio_buffer.speech_stopped") {
        // The moment the caller went quiet — the clock the caller experiences
        // dead air against starts HERE, before VAD commits the turn.
        logT("speech_stopped");
      } else if (t === "input_audio_buffer.committed") {
        turnCommittedAt = Date.now();
        logT("turn_committed", { busy: coordinator.isBusy() });
        // The caller's turn just closed. Ask for the reply NOW — do not wait for
        // the transcription to come back. gpt-realtime is speech-to-speech: it
        // answers the AUDIO directly, so gating the response on Whisper finishing
        // added seconds of dead air per turn on 8 kHz phone audio, and the caller
        // filled the silence with "are you there?" — which then barged in and cut
        // the late reply. Firing here removes that latency. (A language switch,
        // detected once the transcript lands, still adds its own reply on top.)
        if (tokenRateLimitRetryTimer) {
          coalescedRateLimitedTurns++;
          logT("rate_limit_turn_coalesced", {
            coalescedTurns: coalescedRateLimitedTurns,
            retryInMs: Math.max(0, tokenRateLimitCooldownUntil - Date.now()),
          });
        } else {
          coordinator.request({ kind: "normal", build: plainResponseCreate, language: () => currentLang });
        }
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
        responseCreatedAt = Date.now();
        firstAudioSeen = false;   // measure this response's first audio delta
        responseAudioDeltaCount = 0;
        responseAudioBase64Chars = 0;
        logT("response_created", {
          id: rid || null,
          sinceCommitMs: turnCommittedAt ? responseCreatedAt - turnCommittedAt : null,
        });
        coordinator.onResponseCreated(rid);
      } else if (t === "response.done" || t === "response.cancelled") {
        const rid = extractResponseId(evt) ?? "";
        lastProgressAt = Date.now();
        const summary = t === "response.done"
          ? summarizeRealtimeResponseDone(evt)
          : {
              status: "cancelled",
              statusType: null,
              statusReason: null,
              errorType: null,
              errorCode: null,
              outputItemTypes: [],
              outputContentTypes: [],
              hasFunctionCall: false,
            };
        const tokenRateLimited = t === "response.done" && isTokenRateLimitExceeded(summary);
        const waitingForToolResult = t === "response.done" &&
          shouldHoldCoordinatorForToolResult(summary, inFlightBusinessTools);
        // Do not let onResponseEnded immediately pump a queued response into the
        // same exhausted token window. A function-call response also waits for
        // its HTTP result, so a stale caller turn cannot consume a redundant
        // model response before the real tool-result response is queued.
        if (tokenRateLimited || waitingForToolResult) coordinator.pause();
        if (waitingForToolResult) {
          toolResultBarrierActive = true;
          logT("tool_result_barrier_started", { inFlightBusinessTools });
        }
        const endedActive = coordinator.onResponseEnded(rid);
        if ((tokenRateLimited || waitingForToolResult) && !endedActive) {
          toolResultBarrierActive = false;
          resumeCoordinatorIfUnblocked();
        }
        logT("response_ended", {
          type: t,
          id: rid || null,
          activeMatch: endedActive,
          status: summary.status,
          statusType: summary.statusType,
          statusReason: summary.statusReason,
          errorType: summary.errorType,
          errorCode: summary.errorCode,
          outputItemTypes: summary.outputItemTypes,
          outputContentTypes: summary.outputContentTypes,
          audioDeltaCount: responseAudioDeltaCount,
          audioBase64Chars: responseAudioBase64Chars,
        });
        // Always synthesize the approved farewell after end_call. The model may
        // have emitted audible words before the tool, but those words can be a
        // meta-transition rather than the approved goodbye. One retry covers a
        // rare zero-audio pinned response without risking a loop.
        if (shouldQueuePinnedFarewellAfterEndCall({
          endCallRequested,
          hangupPending: hangup.isHangupPending(),
          endedActive,
          forcedFarewellAttempts,
          modelAudioDeltaCount: responseAudioDeltaCount,
        })) {
          forcedFarewellAttempts++;
          coordinator.request({
            kind: "protected",
            build: () => farewellResponseCreate(currentLang),
            language: () => currentLang,
          });
          hangup.onEndCall(coordinator.isBusy());
          logT("forced_farewell_requested", { attempt: forcedFarewellAttempts });
        } else if (
          hangup.isHangupPending() &&
          endedActive &&
          responseAudioDeltaCount === 0 &&
          forcedFarewellAttempts > 0 &&
          forcedFarewellAttempts < 2
        ) {
          forcedFarewellAttempts++;
          coordinator.request({
            kind: "protected",
            build: () => farewellResponseCreate(currentLang),
            language: () => currentLang,
          });
          hangup.onResponseEnded(coordinator.isBusy());
          logT("forced_farewell_requested", { attempt: forcedFarewellAttempts });
        } else {
          // Audible farewell (or an unrelated response): when hangup is pending,
          // the mark now follows the final audio frame and closes only after
          // Twilio confirms it played.
          hangup.onResponseEnded(coordinator.isBusy());
        }

        // response.done is emitted for every terminal outcome and carries status
        // details, but omits raw audio. We therefore pair its safe metadata with
        // the deltas observed above. A completed/failed/incomplete response with
        // no tool call and zero audio is real caller-facing dead air. Retry once
        // with a short, tool-free recovery line; never loop and never retry a
        // write. If another response is already queued, it is the recovery.
        if (
          t === "response.done" &&
          endedActive &&
          !coordinator.isBusy() &&
          !hangup.isHangupPending()
        ) {
          if (tokenRateLimited) {
            const decision = tokenRateLimitRecovery.decide(summary);
            if (decision.kind === "retry") {
              tokenRateLimitCooldownUntil = Date.now() + decision.delayMs;
              playTokenRateLimitComfortTone();
              logT("token_rate_limit_cooldown_started", {
                recoveryAttempt: decision.attempt,
                delayMs: decision.delayMs,
              });
              tokenRateLimitRetryTimer = setTimeout(() => {
                tokenRateLimitRetryTimer = null;
                tokenRateLimitCooldownUntil = 0;
                if (closed || hangup.isHangupPending()) return;
                const coalescedTurns = coalescedRateLimitedTurns;
                coalescedRateLimitedTurns = 0;
                coordinator.request({
                  kind: "normal",
                  build: () => zeroAudioRecoveryResponseCreate(currentLang),
                  language: () => currentLang,
                });
                resumeCoordinatorIfUnblocked();
                logT("token_rate_limit_recovery_requested", {
                  recoveryAttempt: decision.attempt,
                  coalescedTurns,
                });
              }, decision.delayMs);
            } else if (decision.kind === "exhausted") {
              resumeCoordinatorIfUnblocked();
              logT("token_rate_limit_recovery_exhausted", {
                recoveryAttempts: decision.attempts,
              });
            }
          } else {
            const decision = zeroAudioRecovery.decide(summary, responseAudioDeltaCount);
            if (decision === "retry") {
              logT("zero_audio_detected", {
                id: rid || null,
                status: summary.status,
                statusType: summary.statusType,
                statusReason: summary.statusReason,
                errorType: summary.errorType,
                errorCode: summary.errorCode,
                recoveryAttempt: zeroAudioRecovery.attempts(),
              });
              coordinator.request({
                kind: "normal",
                build: () => zeroAudioRecoveryResponseCreate(currentLang),
                language: () => currentLang,
              });
              logT("zero_audio_recovery_requested", {
                recoveryAttempt: zeroAudioRecovery.attempts(),
              });
            } else if (decision === "exhausted") {
              logT("zero_audio_recovery_exhausted", {
                id: rid || null,
                status: summary.status,
                recoveryAttempts: zeroAudioRecovery.attempts(),
              });
            }
          }
        }
        if (tokenRateLimited && endedActive && !tokenRateLimitRetryTimer) {
          // A stale/mismatched lifecycle, pending hangup, or exhausted circuit
          // must never leave the coordinator paused permanently.
          resumeCoordinatorIfUnblocked();
        }
      } else if (t.includes("error")) {
        coordinator.onError();
      }

      const audio = extractAudioDelta(evt);
      if (audio && streamSid) {
        lastProgressAt = Date.now();   // the pipeline is producing audio — not stalled
        responseAudioDeltaCount++;
        responseAudioBase64Chars += audio.length;
        zeroAudioRecovery.onAudibleOutput();
        tokenRateLimitRecovery.onAudibleOutput();
        if (tokenRateLimitRetryTimer) {
          clearTokenRateLimitCooldown();
          logT("token_rate_limit_cooldown_cleared", { reason: "audible_output" });
        }
        if (!firstAudioSeen) {
          // The caller-felt latency numbers: silence → first sound, and (after a
          // tool) tool result → first sound. Logged once per response.
          firstAudioSeen = true;
          logT("first_audio", {
            sinceResponseMs: responseCreatedAt ? Date.now() - responseCreatedAt : null,
            sinceCommitMs: turnCommittedAt ? Date.now() - turnCommittedAt : null,
            sinceToolOutputMs: toolOutputSentAt ? Date.now() - toolOutputSentAt : null,
          });
          toolOutputSentAt = 0;   // the tool→audio gap is measured; don't reattribute it
        }
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

    openaiWs.on("close", () => closeAll("openai_ws_closed"));
    openaiWs.on("error", (e) => { console.warn("[voice-bridge] openai error", e); closeAll("openai_ws_error"); });
  };

  twilioWs.on("message", (raw) => {
    let msg: TwilioInbound;
    try { msg = JSON.parse(raw.toString()) as TwilioInbound; } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid ?? "";
      slug = msg.start.customParameters?.slug ?? "";
      from = msg.start.customParameters?.from ?? "";
      to = msg.start.customParameters?.to ?? "";
      console.log(`[voice-bridge] START slug=${slug || "(none)"} caller=${callerPresenceLabel(from)} openaiKey=${OPENAI_API_KEY ? "set" : "MISSING"} bridgeSecret=${BRIDGE_SECRET ? "set" : "MISSING"}`);
      if (!slug || !callSid || !OPENAI_API_KEY || !BRIDGE_SECRET) { console.warn("[voice-bridge] closing: missing slug/call/key/secret"); return closeAll("missing_config"); }
      void startOpenAi();
    } else if (msg.event === "media") {
      // Hold caller audio until the salon brain is configured — audio sent before
      // session.update would be handled with the wrong (default) language/config.
      if (sessionConfigured && openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify(appendAudioMessage(msg.media.payload)));
      }
    } else if (msg.event === "mark") {
      // Twilio confirms everything queued before this mark has PLAYED to the
      // caller. The controller closes only on OUR hangup mark — any other mark
      // name (or a stray echo before we sent one) is ignored.
      hangup.onMark(extractMarkName(msg));
    } else if (msg.event === "stop") {
      closeAll("twilio_stop");
    }
  });

  twilioWs.on("close", () => closeAll("twilio_ws_closed"));
  twilioWs.on("error", () => closeAll("twilio_ws_error"));
});
