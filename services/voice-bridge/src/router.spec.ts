import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sessionUpdateMessage,
  appendAudioMessage,
  twilioMediaFrame,
  twilioClearFrame,
  functionCallOutput,
  plainResponseCreate,
  zeroAudioRecoveryResponseCreate,
  summarizeRealtimeResponseDone,
  shouldRecoverZeroAudio,
  createZeroAudioRecoveryGuard,
  ZERO_AUDIO_RECOVERY_MAX_ATTEMPTS,
  REALTIME_MAX_OUTPUT_TOKENS,
  REALTIME_SPEECH_SPEED,
  REALTIME_POST_INSTRUCTION_TOKEN_LIMIT,
  REALTIME_TRUNCATION_RETENTION_RATIO,
  summarizeRealtimeRateLimitsUpdated,
  isTokenRateLimitExceeded,
  shouldHoldCoordinatorForToolResult,
  createTokenRateLimitRecoveryGuard,
  TOKEN_RATE_LIMIT_RECOVERY_MAX_ATTEMPTS,
  TOKEN_RATE_LIMIT_RESET_BUFFER_MS,
  tokenRateLimitComfortTonePayloads,
  openingGreetingResponseCreate,
  openingLookupFollowupResponseCreate,
  extractSayThis,
  sayThisResponseCreate,
  sayThisInstruction,
  interruptToggleMessage,
  turnDetection,
  createResponseCoordinator,
  extractResponseId,
  detectLanguageRequest,
  languageAckResponseCreate,
  resolveSwitchLanguage,
  extractAudioDelta,
  extractFunctionCall,
  isSpeechStarted,
  twilioMarkFrame,
  extractMarkName,
  createHangupController,
  HANGUP_MARK,
  HANGUP_FALLBACK_MS,
  TOOL_REQUEST_TIMEOUT_MS,
  voiceToolMaxAttempts,
  isSilentTransportTool,
  callerPresenceLabel,
} from "./router";

// ── helpers for reading coordinator output ──────────────────────────────────
const isToggle = (m: unknown): boolean =>
  !!m && typeof m === "object" && (m as { type?: string }).type === "session.update";
const toggleValue = (m: unknown): boolean =>
  (m as { session: { audio: { input: { turn_detection: { interrupt_response: boolean } } } } }).session.audio.input.turn_detection.interrupt_response;
const isResponseCreate = (m: unknown): boolean => !!m && (m as { type?: string }).type === "response.create";
const sayThisText = (m: unknown): string | undefined =>
  (m as { response?: { instructions?: string } }).response?.instructions;
const isSayThis = (m: unknown): boolean => isResponseCreate(m) && typeof sayThisText(m) === "string";

function makeCoord() {
  const sent: unknown[] = [];
  const c = createResponseCoordinator((m) => sent.push(m));
  return { c, sent };
}
const plain = (lang: () => string) => ({ kind: "normal" as const, build: plainResponseCreate, language: lang });

describe("voice-bridge router — Twilio ↔ OpenAI Realtime translation", () => {
  it("session.update carries brain + μ-law audio + tuned server VAD (GA shape)", () => {
    const m = sessionUpdateMessage({ instructions: "be Lily", voice: "marin", tools: [{ name: "x" }] }) as {
      type: string;
      session: {
        type: string; instructions: string; tools: unknown; max_output_tokens: number;
        truncation: {
          type: string; retention_ratio: number;
          token_limits: { post_instructions: number };
        };
        audio: {
          input: { format: { type: string }; turn_detection: { type: string; interrupt_response: boolean; create_response: boolean; silence_duration_ms: number } };
          output: { format: { type: string }; voice: string; speed: number };
        };
      };
    };
    expect(m.type).toBe("session.update");
    expect(m.session.audio.output.voice).toBe("marin");
    expect(m.session.audio.input.format.type).toBe("audio/pcmu");
    expect(m.session.audio.input.turn_detection.type).toBe("server_vad");
    expect(m.session.audio.input.turn_detection.interrupt_response).toBe(true);
    expect(m.session.audio.input.turn_detection.create_response).toBe(false); // coordinator drives responses
    expect(m.session.audio.input.turn_detection.silence_duration_ms).toBeGreaterThan(500);
    expect(m.session.max_output_tokens).toBe(REALTIME_MAX_OUTPUT_TOKENS);
    expect(m.session.truncation.token_limits.post_instructions).toBeLessThanOrEqual(4_000);
    expect(m.session.audio.output.speed).toBe(REALTIME_SPEECH_SPEED);
    expect(m.session.truncation).toEqual({
      type: "retention_ratio",
      retention_ratio: REALTIME_TRUNCATION_RETENTION_RATIO,
      token_limits: { post_instructions: REALTIME_POST_INSTRUCTION_TOKEN_LIMIT },
    });
  });

  it("Twilio media → OpenAI append, and OpenAI delta → Twilio media (pass-through base64)", () => {
    expect(appendAudioMessage("AAAB")).toEqual({ type: "input_audio_buffer.append", audio: "AAAB" });
    expect(twilioMediaFrame("S1", "ZZZZ")).toEqual({ event: "media", streamSid: "S1", media: { payload: "ZZZZ" } });
    expect(twilioClearFrame("S1")).toEqual({ event: "clear", streamSid: "S1" });
    expect(isSpeechStarted({ type: "input_audio_buffer.speech_started" })).toBe(true);
    expect(isSpeechStarted({ type: "response.audio.delta" })).toBe(false);
  });

  it("bounds tool dead-air, retries only reads, and keeps caller PII out of logs", () => {
    expect(TOOL_REQUEST_TIMEOUT_MS).toBe(12_000);
    expect(voiceToolMaxAttempts("get_available_slots")).toBe(2);
    expect(voiceToolMaxAttempts("lookup_customer")).toBe(2);
    expect(voiceToolMaxAttempts("confirm_booking")).toBe(1);
    expect(voiceToolMaxAttempts("cancel_booking")).toBe(1);
    expect(isSilentTransportTool("wait_for_user")).toBe(true);
    expect(isSilentTransportTool("confirm_booking")).toBe(false);
    expect(callerPresenceLabel("+16045551234")).toBe("present");
    expect(callerPresenceLabel("")).toBe("missing");
    expect(callerPresenceLabel("+16045551234")).not.toContain("1234");
  });

  it("mark frame round-trips: send a named mark, recognise its Twilio echo (playback-aware hangup)", () => {
    expect(twilioMarkFrame("S1", "hangup-after-farewell"))
      .toEqual({ event: "mark", streamSid: "S1", mark: { name: "hangup-after-farewell" } });
    expect(extractMarkName({ event: "mark", mark: { name: "hangup-after-farewell" } })).toBe("hangup-after-farewell");
    expect(extractMarkName({ event: "mark" })).toBeNull();          // mark with no name → ignore
    expect(extractMarkName({ event: "stop" })).toBeNull();          // not a mark at all
  });

  it("extractAudioDelta / extractFunctionCall / extractResponseId behave", () => {
    expect(extractAudioDelta({ type: "response.output_audio.delta", delta: "b" })).toBe("b");
    expect(extractAudioDelta({ type: "response.text.delta", delta: "c" })).toBeNull();
    expect(extractFunctionCall({ type: "response.function_call_arguments.done", name: "x", arguments: '{"a":1}', call_id: "c1" }))
      .toEqual({ name: "x", args: { a: 1 }, callId: "c1" });
    expect(extractResponseId({ response: { id: "r_1" } })).toBe("r_1");
    expect(extractResponseId({ response_id: "r_2" })).toBe("r_2");
    expect(extractResponseId({})).toBeNull();
  });

  it("functionCallOutput is JUST the item — no response.create bundled", () => {
    const item = functionCallOutput("c1", { ok: true, id: "b1" }) as { type: string; item: { call_id: string; output: string } };
    expect(item.type).toBe("conversation.item.create");
    expect(JSON.parse(item.item.output)).toEqual({ ok: true, id: "b1" });
    expect(plainResponseCreate()).toEqual({ type: "response.create" });
  });

  it("summarizes response.done without retaining transcript or error messages", () => {
    const summary = summarizeRealtimeResponseDone({
      type: "response.done",
      response: {
        status: "failed",
        status_details: {
          type: "failed",
          reason: "server_error",
          error: { type: "realtime_error", code: "audio_failed", message: "private details" },
        },
        output: [{
          type: "message",
          content: [{ type: "output_audio", transcript: "private booking transcript" }],
        }],
      },
    });
    expect(summary).toEqual({
      status: "failed",
      statusType: "failed",
      statusReason: "server_error",
      errorType: "realtime_error",
      errorCode: "audio_failed",
      outputItemTypes: ["message"],
      outputContentTypes: ["output_audio"],
      hasFunctionCall: false,
    });
    expect(JSON.stringify(summary)).not.toContain("private");
  });

  it("recovers only zero-audio speech outcomes, never tool calls or cancellations", () => {
    const completed = summarizeRealtimeResponseDone({
      response: { status: "completed", output: [{ type: "message", content: [{ type: "output_audio" }] }] },
    });
    const toolOnly = summarizeRealtimeResponseDone({
      response: { status: "completed", output: [{ type: "function_call" }] },
    });
    const cancelled = summarizeRealtimeResponseDone({
      response: { status: "cancelled", status_details: { type: "cancelled", reason: "turn_detected" } },
    });
    const tokenLimited = summarizeRealtimeResponseDone({
      response: {
        status: "failed",
        status_details: {
          type: "failed",
          error: { type: "tokens", code: "rate_limit_exceeded" },
        },
      },
    });
    expect(shouldRecoverZeroAudio(completed, 0)).toBe(true);
    expect(shouldRecoverZeroAudio(completed, 1)).toBe(false);
    expect(shouldRecoverZeroAudio(toolOnly, 0)).toBe(false);
    expect(shouldRecoverZeroAudio(cancelled, 0)).toBe(false);
    expect(isTokenRateLimitExceeded(tokenLimited)).toBe(true);
    expect(shouldRecoverZeroAudio(tokenLimited, 0)).toBe(false);
  });

  it("holds a function-call response until its business tool result is queued", () => {
    const toolOnly = summarizeRealtimeResponseDone({
      response: { status: "completed", output: [{ type: "function_call" }] },
    });
    const spoken = summarizeRealtimeResponseDone({
      response: { status: "completed", output: [{ type: "message" }] },
    });
    expect(shouldHoldCoordinatorForToolResult(toolOnly, 1)).toBe(true);
    expect(shouldHoldCoordinatorForToolResult(toolOnly, 0)).toBe(false);
    expect(shouldHoldCoordinatorForToolResult(spoken, 1)).toBe(false);
  });

  it("retries one consecutive zero-audio response, then stops until audio resumes", () => {
    const summary = summarizeRealtimeResponseDone({
      response: { status: "completed", output: [] },
    });
    const guard = createZeroAudioRecoveryGuard();
    expect(ZERO_AUDIO_RECOVERY_MAX_ATTEMPTS).toBe(1);
    expect(guard.decide(summary, 0)).toBe("retry");
    expect(guard.decide(summary, 0)).toBe("exhausted");
    guard.onAudibleOutput();
    expect(guard.decide(summary, 0)).toBe("retry");
  });

  it("zero-audio recovery is audible, tool-free, and preserves confirmed outcomes", () => {
    const message = zeroAudioRecoveryResponseCreate("vi") as {
      type: string;
      response: { instructions: string; tools: unknown[]; output_modalities: string[] };
    };
    expect(message.type).toBe("response.create");
    expect(message.response.tools).toEqual([]);
    expect(message.response.output_modalities).toEqual(["audio"]);
    expect(message.response.instructions).toContain("Vietnamese");
    expect(message.response.instructions).toContain("Do not call any tool");
    expect(message.response.instructions).toContain("server-confirmed result");
    expect(message.response.instructions).toContain("one short question");
  });

  it("waits for the documented token reset, bounds retries, and resets after audio", () => {
    const limits = summarizeRealtimeRateLimitsUpdated({
      type: "rate_limits.updated",
      rate_limits: [
        { name: "requests", limit: 100, remaining: 98, reset_seconds: 0.2 },
        { name: "tokens", limit: 20_000, remaining: 0, reset_seconds: 4.25 },
        { name: "tokens", limit: "private", remaining: -1, reset_seconds: Number.NaN },
      ],
      private_future_field: "must not be retained",
    });
    expect(limits).toEqual([
      { name: "requests", limit: 100, remaining: 98, resetSeconds: 0.2 },
      { name: "tokens", limit: 20_000, remaining: 0, resetSeconds: 4.25 },
      { name: "tokens", limit: null, remaining: null, resetSeconds: null },
    ]);
    expect(JSON.stringify(limits)).not.toContain("private");

    const summary = summarizeRealtimeResponseDone({
      response: {
        status: "failed",
        status_details: { error: { type: "tokens", code: "rate_limit_exceeded" } },
      },
    });
    const guard = createTokenRateLimitRecoveryGuard();
    guard.onRateLimits(limits, 10_000);
    expect(guard.decide(summary, 10_250)).toEqual({
      kind: "retry",
      delayMs: 4_500,
      attempt: 1,
    });
    expect(guard.decide(summary, 15_000)).toMatchObject({ kind: "retry", attempt: 2 });
    expect(guard.decide(summary, 15_001)).toEqual({
      kind: "exhausted",
      attempts: TOKEN_RATE_LIMIT_RECOVERY_MAX_ATTEMPTS,
    });
    guard.onAudibleOutput();
    expect(guard.decide(summary, 20_000)).toMatchObject({
      kind: "retry",
      attempt: 1,
    });
  });

  it("generates a short local μ-law comfort tone without OpenAI", () => {
    const payloads = tokenRateLimitComfortTonePayloads();
    expect(payloads).toHaveLength(12);
    const decoded = payloads.map((payload) => Buffer.from(payload, "base64"));
    expect(decoded.every((frame) => frame.length === 160)).toBe(true);
    expect(decoded.some((frame) => frame.some((byte) => byte !== 0xff))).toBe(true);
    expect(TOKEN_RATE_LIMIT_RESET_BUFFER_MS).toBeGreaterThan(0);
  });

  it("opening greeting invites the caller to speak before any tool call", () => {
    const greeting = "Hi, thanks for calling Tech Nails Salon. This is Lily. How can I help today?";
    const message = openingGreetingResponseCreate("en", greeting) as {
      type: string;
      response: { instructions: string };
    };
    expect(message.type).toBe("response.create");
    expect(message.response.instructions).toContain(JSON.stringify(greeting));
    expect(message.response.instructions).toContain("EXACTLY");
    expect(message.response.instructions).toContain("clearly enunciate the salon name");
    expect(message.response.instructions).toContain("Do not translate, paraphrase, rename the salon");
    expect(message.response.instructions).toContain("call a tool");
    expect(message.response.instructions).toContain("stop and listen");
  });

  it("opening lookup recovery always resumes instead of leaving dead air", () => {
    const message = openingLookupFollowupResponseCreate("vi") as {
      type: string;
      response: { instructions: string };
    };
    expect(message.response.instructions).toContain("Vietnamese");
    expect(message.response.instructions).toContain("Do not repeat the full greeting");
    expect(message.response.instructions).toContain("what you can help them with today");
  });
});

describe("router — say_this", () => {
  it("extractSayThis pulls the string, ignores everything else", () => {
    expect(extractSayThis({ say_this: "All set!" })).toBe("All set!");
    expect(extractSayThis({ ok: true })).toBeNull();
    expect(extractSayThis({ say_this: "" })).toBeNull();
    expect(extractSayThis(null)).toBeNull();
  });

  it("say_this reads verbatim in the CURRENT language, details preserved", () => {
    const es = sayThisInstruction("All set! Booked Gel at 6:00 PM with Bella.", "es");
    expect(es).toContain("in Spanish");
    expect(es).toContain("6:00 PM");
    expect(es).toContain("Bella");
    expect(es).toContain("EXACTLY as written");
    const r = sayThisResponseCreate("hi", "vi") as { type: string; response: { instructions: string } };
    expect(r.type).toBe("response.create");
    expect(r.response.instructions).toContain("in Vietnamese");
  });
});

describe("router — language request beats spoken-language detection", () => {
  it("detectLanguageRequest catches an explicit ask even when the ask is in English", () => {
    expect(detectLanguageRequest("Can we continue in Spanish?")).toBe("es");
    expect(detectLanguageRequest("can we speak in vietnamese")).toBe("vi");
    expect(detectLanguageRequest("en français s'il vous plaît")).toBe("fr");
    expect(detectLanguageRequest("in chinese please")).toBe("zh");
    expect(detectLanguageRequest("Can you speak Chinese?")).toBe("zh");
    expect(detectLanguageRequest("Can we continue Vietnamese?")).toBe("vi");
    expect(detectLanguageRequest("Can you speak Vietnamese?")).toBe("vi");
    expect(detectLanguageRequest("Please switch to French")).toBe("fr");
    expect(detectLanguageRequest("switch to English")).toBe("en");
    expect(detectLanguageRequest("I'd like a manicure")).toBeNull();
    // A Vietnamese caller names other languages in Vietnamese (call 4e705d34:
    // "nói bằng tiếng Hoa" was missed and the agent wrongly refused).
    expect(detectLanguageRequest("nói bằng tiếng Hoa được không?")).toBe("zh");
    expect(detectLanguageRequest("cho tôi tiếng Trung")).toBe("zh");
    expect(detectLanguageRequest("nói tiếng Pháp đi")).toBe("fr");
    expect(detectLanguageRequest("tiếng Tây Ban Nha")).toBe("es");
  });

  it("pins the language acknowledgement instead of inheriting stale context", () => {
    const m = languageAckResponseCreate("vi") as { response: { instructions: string } };
    expect(m.response.instructions).toContain("Vietnamese only");
    expect(m.response.instructions).toContain("latest request");
  });

  it("resolveSwitchLanguage runs the request first, then falls back to spoken", () => {
    expect(resolveSwitchLanguage("Can we continue in Spanish?", "en")).toBe("es");
    expect(resolveSwitchLanguage("in english please", "en")).toBeNull();
    expect(resolveSwitchLanguage("mình muốn đặt lịch", "en")).toBe("vi");
    expect(resolveSwitchLanguage("yes okay", "en")).toBeNull();
  });
});

describe("router — turnDetection", () => {
  it("server_vad, higher threshold + longer silence, coordinator drives creation, interrupt togglable", () => {
    const on = turnDetection(true) as Record<string, unknown>;
    expect(on.type).toBe("server_vad");
    expect(on.create_response).toBe(false);              // bridge coordinator is the sole creator
    expect(on.interrupt_response).toBe(true);
    expect(on.threshold as number).toBeGreaterThan(0.5);
    expect(on.silence_duration_ms as number).toBeGreaterThanOrEqual(700);
    expect((turnDetection(false) as Record<string, unknown>).interrupt_response).toBe(false);
  });

  it("interruptToggleMessage is a minimal session.update touching only audio.input", () => {
    const m = interruptToggleMessage(false, "es") as { type: string; session: { instructions?: unknown; audio: { input: { turn_detection: { interrupt_response: boolean }; transcription: { language: string } } } } };
    expect(m.type).toBe("session.update");
    expect(m.session.instructions).toBeUndefined();
    expect(m.session.audio.input.turn_detection.interrupt_response).toBe(false);
    expect(m.session.audio.input.transcription.language).toBe("es");
  });
});

describe("coordinator — one response at a time, priority, barge-in gating", () => {
  it("dispatches immediately when idle; queues while one is active; no double response.create", () => {
    const { c, sent } = makeCoord();
    const lang = () => "en";
    c.request(plain(lang));                 // dispatch now (idle)
    expect(sent.filter(isResponseCreate).length).toBe(1);
    c.onResponseCreated("r1");
    c.request(plain(lang));                 // active → queue, NOT sent
    expect(sent.filter(isResponseCreate).length).toBe(1);   // still one → no "already active"
    c.onResponseEnded("r1");                // frees the slot → queued one dispatches
    expect(sent.filter(isResponseCreate).length).toBe(2);
  });

  it("coalesces queued conversational replies so only the latest caller turn is answered", () => {
    const { c, sent } = makeCoord();
    const lang = () => "en";
    c.request(plain(lang));
    c.onResponseCreated("active");
    c.request({ kind: "normal", build: () => ({ type: "response.create", response: { instructions: "stale" } }), language: lang });
    c.request({ kind: "normal", build: () => ({ type: "response.create", response: { instructions: "latest" } }), language: lang });
    c.onResponseEnded("active");
    const creates = sent.filter(isResponseCreate) as Array<{ response?: { instructions?: string } }>;
    expect(creates).toHaveLength(2);
    expect(creates[1]?.response?.instructions).toBe("latest");
  });

  it("pauses queued replies during a rate-limit window and dispatches only after resume", () => {
    const { c, sent } = makeCoord();
    const lang = () => "en";
    c.request(plain(lang));
    c.onResponseCreated("rate_limited");
    c.pause();
    c.request({
      kind: "normal",
      build: () => ({ type: "response.create", response: { instructions: "latest after reset" } }),
      language: lang,
    });
    c.onResponseEnded("rate_limited");
    expect(sent.filter(isResponseCreate)).toHaveLength(1);
    c.resume();
    const creates = sent.filter(isResponseCreate) as Array<{ response?: { instructions?: string } }>;
    expect(creates).toHaveLength(2);
    expect(creates[1]?.response?.instructions).toBe("latest after reset");
  });

  it("does not speak a stale caller turn between a function call and its tool result", () => {
    const { c, sent } = makeCoord();
    const lang = () => "en";
    c.request(plain(lang));
    c.onResponseCreated("function_call");
    c.request({
      kind: "normal",
      build: () => ({ type: "response.create", response: { instructions: "stale caller turn" } }),
      language: lang,
    });

    // server.ts sees response.done(hasFunctionCall) while HTTP is still in
    // flight, so it pauses before ending the function-call response.
    c.pause();
    c.onResponseEnded("function_call");
    expect(sent.filter(isResponseCreate)).toHaveLength(1);

    // The tool result supersedes the stale queued turn, then releases the
    // barrier. Exactly one caller-facing follow-up is generated.
    c.request({
      kind: "normal",
      build: () => ({ type: "response.create", response: { instructions: "real tool result" } }),
      language: lang,
    });
    c.resume();
    const creates = sent.filter(isResponseCreate) as Array<{ response?: { instructions?: string } }>;
    expect(creates).toHaveLength(2);
    expect(creates[1]?.response?.instructions).toBe("real tool result");
    expect(creates.some((message) => message.response?.instructions === "stale caller turn")).toBe(false);
  });

  it("a language acknowledgement replaces stale queued replies", () => {
    const { c, sent } = makeCoord();
    const lang = () => "vi";
    c.request(plain(() => "zh"));
    c.onResponseCreated("chinese");
    c.request({ kind: "normal", build: () => ({ type: "response.create", response: { instructions: "stale Chinese" } }), language: () => "zh" });
    c.request({ kind: "ack", build: () => languageAckResponseCreate("vi"), language: lang });
    c.onResponseEnded("chinese");
    const creates = sent.filter(isResponseCreate) as Array<{ response?: { instructions?: string } }>;
    expect(creates).toHaveLength(2);
    expect(creates[1]?.response?.instructions).toContain("Vietnamese only");
    expect(creates.some((m) => m.response?.instructions === "stale Chinese")).toBe(false);
  });

  it("does NOT clear Twilio in dead air; clears only while an unprotected response plays", () => {
    const { c } = makeCoord();
    expect(c.shouldClearOnSpeech()).toBe(false);   // nothing playing
    c.request(plain(() => "en"));
    c.onResponseCreated("r1");
    expect(c.shouldClearOnSpeech()).toBe(true);    // intentional barge-in works
    c.onResponseEnded("r1");
    expect(c.shouldClearOnSpeech()).toBe(false);
  });

  it("a protected say_this is never cut by speech, and restores barge-in only on its own end", () => {
    const { c, sent } = makeCoord();
    const lang = () => "en";
    c.request({ kind: "protected", build: () => sayThisResponseCreate("All set!", "en"), language: lang });
    // dispatch = interrupt OFF, then the say_this response.create
    expect(isToggle(sent[0]) && toggleValue(sent[0]) === false).toBe(true);
    expect(isSayThis(sent[1])).toBe(true);
    c.onResponseCreated("r_say");
    expect(c.isProtectedActive()).toBe(true);
    expect(c.shouldClearOnSpeech()).toBe(false);   // echo / "Hello" cannot cut it
    c.onResponseEnded("r_say");
    // restore = interrupt back ON, exactly once
    const restores = sent.filter((m) => isToggle(m) && toggleValue(m) === true);
    expect(restores.length).toBe(1);
  });

  it("restores after an error too (barge-in never stuck off)", () => {
    const { c, sent } = makeCoord();
    c.request({ kind: "protected", build: () => sayThisResponseCreate("x", "en"), language: () => "en" });
    c.onResponseCreated("r_say");
    c.onError();
    expect(sent.some((m) => isToggle(m) && toggleValue(m) === true)).toBe(true);
    expect(c.isProtectedActive()).toBe(false);
    expect(c.isBusy()).toBe(false);
  });

  it("a wrong / stale response id never ends another response", () => {
    const { c, sent } = makeCoord();
    c.request({ kind: "protected", build: () => sayThisResponseCreate("x", "en"), language: () => "en" });
    c.onResponseCreated("r_say");
    expect(c.onResponseEnded("r_other")).toBe(false); // stale id → ignored
    expect(c.isProtectedActive()).toBe(true);      // still protected
    expect(sent.some((m) => isToggle(m) && toggleValue(m) === true)).toBe(false); // no restore
    expect(c.onResponseEnded("r_say")).toBe(true);
  });

  it("after close, no further response.create is emitted", () => {
    const { c, sent } = makeCoord();
    c.onClose();
    c.request(plain(() => "en"));
    expect(sent.filter(isResponseCreate).length).toBe(0);
  });

  it("forceRecover unsticks a coordinator whose response.done was missed (dead-air fix)", () => {
    const { c, sent } = makeCoord();
    // A response is created but its .done never matches (id mismatch) → stuck busy.
    c.request(plain(() => "en"));
    c.onResponseCreated("r_stuck");
    c.onResponseEnded("r_WRONG_id");          // mismatched → does NOT clear (by design)
    expect(c.isBusy()).toBe(true);            // stalled: pump() can never dispatch again
    c.request(plain(() => "en"));             // a new turn queues but cannot play
    const before = sent.filter(isResponseCreate).length;

    // Watchdog kicks in: it clears the stuck slot AND dispatches the queued reply.
    expect(c.forceRecover().recovered).toBe(true);
    expect(sent.filter(isResponseCreate).length).toBe(before + 1);   // queued reply now plays
    // The fresh reply runs a clean lifecycle → back to idle (proves it's unstuck).
    c.onResponseCreated("r_fresh");
    c.onResponseEnded("r_fresh");
    expect(c.isBusy()).toBe(false);
    expect(c.forceRecover().recovered).toBe(false);                  // nothing to recover when idle
  });

  it("forceRecover restores barge-in if a protected line was the one stuck", () => {
    const { c, sent } = makeCoord();
    c.request({ kind: "protected", build: () => sayThisResponseCreate("x", "en"), language: () => "en" });
    c.onResponseCreated("r_prot");
    c.onResponseEnded("mismatch");            // protected line stuck (interrupt still OFF)
    c.forceRecover();
    expect(sent.some((m) => isToggle(m) && toggleValue(m) === true)).toBe(true); // barge-in restored
  });
});

// The exact race from call c3800b1c: "Yes" (confirm_booking in-flight), then
// "Can we continue in Spanish?" — the two can both want a response.create.
describe("coordinator — language-switch × say_this race (call c3800b1c)", () => {
  it("A. switch completes BEFORE confirm result → say_this in Spanish, ack dropped, one say_this", () => {
    const { c, sent } = makeCoord();
    let lang = "en";
    const L = () => lang;
    // caller "Yes" turn → normal response that emits the function call
    c.request(plain(L));
    c.onResponseCreated("r_yes");
    // switch lands first: currentLang flips, ack requested (queues behind r_yes)
    lang = "es";
    c.request({ kind: "ack", build: plainResponseCreate, language: L });
    // confirm_booking result → protected say_this (drops the queued ack)
    c.request({ kind: "protected", build: () => sayThisResponseCreate("All set! Gel at 6:00 PM with Bella.", lang), language: L });
    c.onResponseEnded("r_yes");                    // r_yes ends → say_this dispatches (priority)
    const sayThises = sent.filter(isSayThis);
    expect(sayThises.length).toBe(1);              // exactly one say_this
    expect(sayThisText(sayThises[0])).toContain("in Spanish");
    expect(sayThisText(sayThises[0])).toContain("6:00 PM");
    // only two responses total (the "Yes" turn + the say_this) — the ack was dropped
    expect(sent.filter(isResponseCreate).length).toBe(2);
  });

  it("B. confirm result BEFORE switch config → say_this still comes out in Spanish (lazy build)", () => {
    const { c, sent } = makeCoord();
    let lang = "en";
    const L = () => lang;
    c.request(plain(L));
    c.onResponseCreated("r_yes");
    // confirm result first → protected say_this queued (still en at request time)
    c.request({ kind: "protected", build: () => sayThisResponseCreate("All set! Gel at 6:00 PM with Bella.", lang), language: L });
    // switch config arrives: flip lang, ack suppressed (protected already pending)
    lang = "es";
    c.request({ kind: "ack", build: plainResponseCreate, language: L });
    c.onResponseEnded("r_yes");                    // dispatch say_this — built NOW, lang=es
    const sayThises = sent.filter(isSayThis);
    expect(sayThises.length).toBe(1);
    expect(sayThisText(sayThises[0])).toContain("in Spanish");
    expect(sent.filter(isResponseCreate).length).toBe(2);   // "Yes" + say_this, ack suppressed
  });

  it("C. an ack's response.done does NOT restore a protected say_this", () => {
    const { c, sent } = makeCoord();
    const L = () => "es";
    // an ack is active (no protected pending when it was requested)
    c.request({ kind: "ack", build: plainResponseCreate, language: L });
    c.onResponseCreated("r_ack");
    // now a protected say_this is requested → queues behind the ack
    c.request({ kind: "protected", build: () => sayThisResponseCreate("All set!", "es"), language: L });
    c.onResponseEnded("r_ack");                    // ack ends: must NOT restore (ack isn't protected)
    // the ONLY toggle so far is the protected dispatch's interrupt-OFF, no restore-ON yet
    expect(sent.filter((m) => isToggle(m) && toggleValue(m) === true).length).toBe(0);
    c.onResponseCreated("r_say");
    c.onResponseEnded("r_say");                    // NOW the protected line ends → restore
    expect(sent.filter((m) => isToggle(m) && toggleValue(m) === true).length).toBe(1);
  });

  it("D. never two active responses; say_this spoken once in Spanish", () => {
    const { c, sent } = makeCoord();
    let lang = "en";
    const L = () => lang;
    // greet
    c.request(plain(L)); c.onResponseCreated("r0"); c.onResponseEnded("r0");
    // "Yes"
    c.request(plain(L)); c.onResponseCreated("r_yes");
    // switch + confirm race, both while r_yes is active
    lang = "es";
    c.request({ kind: "ack", build: plainResponseCreate, language: L });
    c.request({ kind: "protected", build: () => sayThisResponseCreate("Done at 6:00 PM.", lang), language: L });
    c.onResponseEnded("r_yes");
    c.onResponseCreated("r_say");
    expect(sent.filter(isSayThis).length).toBe(1);
    expect(sayThisText(sent.filter(isSayThis)[0])).toContain("in Spanish");
    // greet + "Yes" + say_this = 3; the ack was dropped, so no 4th response
    expect(sent.filter(isResponseCreate).length).toBe(3);
  });
});

// ── playback-aware hangup controller ────────────────────────────────────────
// The lifecycle rules the bridge relies on to never cut a farewell mid-word
// and never leave a call hanging open. Mirrors server.ts wiring: end_call →
// onEndCall(coordinator.isBusy()), response.done → onResponseEnded(...),
// Twilio mark event → onMark(name), closeAll for any reason → onClose().
describe("createHangupController — playback-aware hangup lifecycle", () => {
  afterEach(() => { vi.useRealTimers(); });

  function makeHangup(opts: { streamAlive?: boolean } = {}) {
    let streamAlive = opts.streamAlive ?? true;
    let markSends = 0;
    const closed: string[] = [];
    const h = createHangupController({
      sendMark: () => { if (!streamAlive) return false; markSends++; return true; },
      close: (reason) => closed.push(reason),
    });
    return { h, closed, marks: () => markSends, killStream: () => { streamAlive = false; } };
  }

  it("closes ONLY on the hangup mark's echo — other mark names are ignored", () => {
    vi.useFakeTimers();
    const { h, closed, marks } = makeHangup();
    h.onEndCall(false);                    // farewell already generated → mark goes out
    expect(marks()).toBe(1);
    h.onMark("some-other-mark");           // e.g. an unrelated mark echo
    h.onMark(null);                        // a mark event with no name
    expect(closed).toEqual([]);            // still waiting — wrong name never closes
    h.onMark(HANGUP_MARK);
    expect(closed).toEqual(["farewell_fully_played"]);
    vi.advanceTimersByTime(HANGUP_FALLBACK_MS * 2);
    expect(closed).toEqual(["farewell_fully_played"]); // fallback was cancelled by the ack
  });

  it("a stray hangup-mark echo BEFORE end_call never closes the call", () => {
    const { h, closed } = makeHangup();
    h.onMark(HANGUP_MARK);                 // we never sent one — ignore
    expect(closed).toEqual([]);
  });

  it("end_call while the farewell is still generating waits for the response end", () => {
    vi.useFakeTimers();
    const { h, marks, closed } = makeHangup();
    h.onEndCall(true);                     // coordinator busy: farewell in flight
    expect(marks()).toBe(0);               // no mark yet — audio is still being produced
    expect(closed).toEqual([]);
    h.onResponseEnded(false);              // farewell finished generating
    expect(marks()).toBe(1);               // NOW the mark chases the last audio frame
    h.onMark(HANGUP_MARK);
    expect(closed).toEqual(["farewell_fully_played"]);
  });

  it("repeated lifecycle events never send the mark twice", () => {
    vi.useFakeTimers();
    const { h, marks } = makeHangup();
    h.onEndCall(false);
    h.onEndCall(false);                    // duplicate end_call tool call
    h.onResponseEnded(false);              // response.done arriving after the mark
    h.onResponseEnded(false);              // ...and response.cancelled variants
    expect(marks()).toBe(1);
  });

  it("a response end WITHOUT a prior end_call never starts a hangup", () => {
    const { h, marks, closed } = makeHangup();
    h.onResponseEnded(false);              // ordinary turn finishing
    expect(marks()).toBe(0);
    expect(closed).toEqual([]);
  });

  it("fallback closes after HANGUP_FALLBACK_MS when the ack never arrives", () => {
    vi.useFakeTimers();
    const { h, closed } = makeHangup();
    h.onEndCall(false);
    vi.advanceTimersByTime(HANGUP_FALLBACK_MS - 1);
    expect(closed).toEqual([]);            // still inside the grace window
    vi.advanceTimersByTime(1);
    expect(closed).toEqual(["hangup_fallback_timeout"]);
  });

  it("onClose (e.g. Twilio 'stop' closed the call immediately) cancels the fallback", () => {
    vi.useFakeTimers();
    const { h, closed } = makeHangup();
    h.onEndCall(false);                    // mark + fallback armed
    h.onClose();                           // server.ts: 'stop' → closeAll → hangup.onClose()
    vi.advanceTimersByTime(HANGUP_FALLBACK_MS * 2);
    expect(closed).toEqual([]);            // the controller never double-closes a closed call
  });

  it("no live stream to send the mark on → close immediately, no timer", () => {
    vi.useFakeTimers();
    const { h, closed } = makeHangup({ streamAlive: false });
    h.onEndCall(false);
    expect(closed).toEqual(["hangup_no_live_stream"]);
    vi.advanceTimersByTime(HANGUP_FALLBACK_MS * 2);
    expect(closed).toEqual(["hangup_no_live_stream"]); // nothing fires later
  });
});
