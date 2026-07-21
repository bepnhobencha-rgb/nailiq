import { describe, it, expect } from "vitest";
import {
  sessionUpdateMessage,
  appendAudioMessage,
  twilioMediaFrame,
  twilioClearFrame,
  functionCallOutput,
  plainResponseCreate,
  extractSayThis,
  sayThisResponseCreate,
  sayThisInstruction,
  interruptToggleMessage,
  turnDetection,
  createCallLifecycle,
  detectLanguageRequest,
  resolveSwitchLanguage,
  extractAudioDelta,
  extractFunctionCall,
  isSpeechStarted,
} from "./router";

describe("voice-bridge router — Twilio ↔ OpenAI Realtime translation", () => {
  it("session.update carries brain + μ-law audio + tuned server VAD (GA shape)", () => {
    const m = sessionUpdateMessage({ instructions: "be Lily", voice: "marin", tools: [{ name: "x" }] }) as {
      type: string;
      session: {
        type: string; instructions: string; tools: unknown;
        audio: {
          input: { format: { type: string }; turn_detection: { type: string; interrupt_response: boolean; silence_duration_ms: number } };
          output: { format: { type: string }; voice: string };
        };
      };
    };
    expect(m.type).toBe("session.update");
    expect(m.session.audio.output.voice).toBe("marin");
    expect(m.session.audio.input.format.type).toBe("audio/pcmu");
    expect(m.session.audio.input.turn_detection.type).toBe("server_vad");
    expect(m.session.audio.input.turn_detection.interrupt_response).toBe(true);     // interruptible by default
    expect(m.session.audio.input.turn_detection.silence_duration_ms).toBeGreaterThan(500); // tuned longer for phone
  });

  it("Twilio media → OpenAI append, and OpenAI delta → Twilio media (pass-through base64)", () => {
    expect(appendAudioMessage("AAAB")).toEqual({ type: "input_audio_buffer.append", audio: "AAAB" });
    expect(twilioMediaFrame("S1", "ZZZZ")).toEqual({ event: "media", streamSid: "S1", media: { payload: "ZZZZ" } });
    expect(twilioClearFrame("S1")).toEqual({ event: "clear", streamSid: "S1" });
    expect(isSpeechStarted({ type: "input_audio_buffer.speech_started" })).toBe(true);
    expect(isSpeechStarted({ type: "response.audio.delta" })).toBe(false);
  });

  it("extractAudioDelta / extractFunctionCall behave", () => {
    expect(extractAudioDelta({ type: "response.output_audio.delta", delta: "b" })).toBe("b");
    expect(extractAudioDelta({ type: "response.text.delta", delta: "c" })).toBeNull();
    expect(extractFunctionCall({ type: "response.function_call_arguments.done", name: "x", arguments: '{"a":1}', call_id: "c1" }))
      .toEqual({ name: "x", args: { a: 1 }, callId: "c1" });
  });

  it("functionCallOutput is JUST the item — no response.create bundled (avoids double response)", () => {
    const item = functionCallOutput("c1", { ok: true, id: "b1" }) as { type: string; item: { call_id: string; output: string } };
    expect(item.type).toBe("conversation.item.create");
    expect(JSON.parse(item.item.output)).toEqual({ ok: true, id: "b1" });
    expect(plainResponseCreate()).toEqual({ type: "response.create" });
  });
});

describe("router — say_this", () => {
  it("extractSayThis pulls the string, ignores everything else", () => {
    expect(extractSayThis({ say_this: "All set!" })).toBe("All set!");
    expect(extractSayThis({ ok: true })).toBeNull();
    expect(extractSayThis({ say_this: "" })).toBeNull();
    expect(extractSayThis(null)).toBeNull();
    expect(extractSayThis("string")).toBeNull();
  });

  it("say_this response.create instructs to read it verbatim, in the CURRENT language", () => {
    const en = sayThisInstruction("All set! Booked Gel at 6:00 PM with Bella.", "en");
    expect(en).toContain("in English");
    expect(en).toContain("All set! Booked Gel at 6:00 PM with Bella.");

    const es = sayThisInstruction("All set! Booked Gel at 6:00 PM with Bella.", "es");
    expect(es).toContain("in Spanish");
    // details preserved verbatim even in a Spanish session
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
    expect(detectLanguageRequest("¿podemos hablar en español?")).toBe("es");
    expect(detectLanguageRequest("en français s'il vous plaît")).toBe("fr");
    expect(detectLanguageRequest("in chinese please")).toBe("zh");
    expect(detectLanguageRequest("switch to English")).toBe("en");
    expect(detectLanguageRequest("I'd like a manicure")).toBeNull();
  });

  it("resolveSwitchLanguage runs the request first, then falls back to spoken", () => {
    // request in English → switch to Spanish (the point of issue 4)
    expect(resolveSwitchLanguage("Can we continue in Spanish?", "en")).toBe("es");
    // already in the requested language → no switch
    expect(resolveSwitchLanguage("in english please", "en")).toBeNull();
    // no request, but clearly speaking Vietnamese → switch
    expect(resolveSwitchLanguage("mình muốn đặt lịch", "en")).toBe("vi");
    // nothing decisive → stay
    expect(resolveSwitchLanguage("yes okay", "en")).toBeNull();
  });
});

describe("router — turnDetection tuning", () => {
  it("is server_vad with a higher threshold + longer silence, interrupt togglable", () => {
    const on = turnDetection(true) as Record<string, unknown>;
    expect(on.type).toBe("server_vad");
    expect(on.interrupt_response).toBe(true);
    expect(on.threshold as number).toBeGreaterThan(0.5);
    expect(on.silence_duration_ms as number).toBeGreaterThanOrEqual(700);
    expect((turnDetection(false) as Record<string, unknown>).interrupt_response).toBe(false);
  });

  it("interruptToggleMessage is a minimal session.update touching only audio.input", () => {
    const m = interruptToggleMessage(false, "es") as { type: string; session: { instructions?: unknown; audio: { input: { turn_detection: { interrupt_response: boolean }; transcription: { language: string } } } } };
    expect(m.type).toBe("session.update");
    expect(m.session.instructions).toBeUndefined();       // does not resend the whole brain
    expect(m.session.audio.input.turn_detection.interrupt_response).toBe(false);
    expect(m.session.audio.input.transcription.language).toBe("es");
  });
});

describe("router — call lifecycle (barge-in gating + protection restore)", () => {
  it("does NOT clear Twilio in dead air (no response playing)", () => {
    const lc = createCallLifecycle();
    expect(lc.shouldClearOnSpeech()).toBe(false);   // nothing playing → no clear
  });

  it("clears on speech only while a normal response is playing", () => {
    const lc = createCallLifecycle();
    lc.onResponseCreated();
    expect(lc.shouldClearOnSpeech()).toBe(true);     // intentional barge-in works
    lc.onResponseEnded();
    expect(lc.shouldClearOnSpeech()).toBe(false);
  });

  it("a protected say_this line is NOT cleared by speech (echo cannot cut it)", () => {
    const lc = createCallLifecycle();
    lc.onResponseCreated();
    lc.beginProtected();
    expect(lc.isProtected()).toBe(true);
    expect(lc.shouldClearOnSpeech()).toBe(false);     // echo/"Hello" does not interrupt the confirmation
  });

  it("restores interrupt exactly once when a protected line ends — on done", () => {
    const lc = createCallLifecycle();
    lc.onResponseCreated();
    lc.beginProtected();
    expect(lc.onResponseEnded().restore).toBe(true);   // send interrupt=true toggle once
    expect(lc.onResponseEnded().restore).toBe(false);  // not again
    expect(lc.isProtected()).toBe(false);
  });

  it("restores after a cancellation or error too (barge-in never stuck off)", () => {
    const lc = createCallLifecycle();
    lc.onResponseCreated();
    lc.beginProtected();
    // simulate response.cancelled / error path — onResponseEnded is called there
    expect(lc.onResponseEnded().restore).toBe(true);
    expect(lc.shouldClearOnSpeech()).toBe(false);
  });

  it("a normal (unprotected) response end does not emit a restore", () => {
    const lc = createCallLifecycle();
    lc.onResponseCreated();
    expect(lc.onResponseEnded().restore).toBe(false);
  });
});

describe("router — simulates the c3800b1c failures", () => {
  it("the confirmation line is protected, so it is not cut mid-word by echo", () => {
    const lc = createCallLifecycle();
    lc.onResponseCreated();       // say_this response starts playing
    lc.beginProtected();          // runTool marks it protected + sends interrupt=false
    // caller's line echo / "Hello" arrives:
    expect(lc.shouldClearOnSpeech()).toBe(false);   // NOT cut → no "...Shall" truncation
  });

  it("after 'Yes', the booking confirmation say_this is spoken once, in the session language", () => {
    // runTool logic: functionCallOutput + exactly one say_this response.create
    const result = { success: true, bookingId: "b1", say_this: "All set! Gel at 6:00 PM with Bella." };
    const say = extractSayThis(result);
    expect(say).toBe("All set! Gel at 6:00 PM with Bella.");
    const rc = sayThisResponseCreate(say!, "en") as { type: string; response: { instructions: string } };
    expect(rc.type).toBe("response.create");
    expect(rc.response.instructions).toContain("6:00 PM");
  });

  it("'Can we continue in Spanish?' switches to es even though the sentence is English", () => {
    expect(resolveSwitchLanguage("Can we continue in Spanish?", "en")).toBe("es");
  });
});
