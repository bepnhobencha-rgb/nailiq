import { describe, it, expect } from "vitest";
import {
  sessionUpdateMessage,
  appendAudioMessage,
  twilioMediaFrame,
  twilioClearFrame,
  functionCallOutputMessages,
  extractAudioDelta,
  extractFunctionCall,
  isSpeechStarted,
} from "./router";

describe("voice-bridge router — Twilio ↔ OpenAI Realtime translation", () => {
  it("session.update carries brain + μ-law audio + server VAD", () => {
    const m = sessionUpdateMessage({ instructions: "be Lily", voice: "marin", tools: [{ name: "x" }] }) as {
      type: string;
      session: Record<string, unknown>;
    };
    expect(m.type).toBe("session.update");
    expect(m.session.instructions).toBe("be Lily");
    expect(m.session.voice).toBe("marin");
    expect(m.session.input_audio_format).toBe("g711_ulaw");
    expect(m.session.output_audio_format).toBe("g711_ulaw");
    expect((m.session.turn_detection as { type: string }).type).toBe("server_vad");
    expect(m.session.tools).toEqual([{ name: "x" }]);
  });

  it("Twilio media → OpenAI append, and OpenAI delta → Twilio media (pass-through base64)", () => {
    expect(appendAudioMessage("AAAB")).toEqual({ type: "input_audio_buffer.append", audio: "AAAB" });
    expect(twilioMediaFrame("STREAM1", "ZZZZ")).toEqual({
      event: "media",
      streamSid: "STREAM1",
      media: { payload: "ZZZZ" },
    });
  });

  it("barge-in produces a Twilio clear frame", () => {
    expect(twilioClearFrame("STREAM1")).toEqual({ event: "clear", streamSid: "STREAM1" });
    expect(isSpeechStarted({ type: "input_audio_buffer.speech_started" })).toBe(true);
    expect(isSpeechStarted({ type: "response.audio.delta" })).toBe(false);
  });

  it("extractAudioDelta tolerates both event-name variants; ignores non-audio", () => {
    expect(extractAudioDelta({ type: "response.audio.delta", delta: "a" })).toBe("a");
    expect(extractAudioDelta({ type: "response.output_audio.delta", delta: "b" })).toBe("b");
    expect(extractAudioDelta({ type: "response.text.delta", delta: "c" })).toBeNull();
    expect(extractAudioDelta({ type: "response.audio.delta" })).toBeNull();
  });

  it("extractFunctionCall parses name/args/call_id; bad JSON → empty args", () => {
    expect(
      extractFunctionCall({
        type: "response.function_call_arguments.done",
        name: "cancel_booking",
        arguments: '{"booking_id":"b1"}',
        call_id: "c1",
      }),
    ).toEqual({ name: "cancel_booking", args: { booking_id: "b1" }, callId: "c1" });

    expect(
      extractFunctionCall({
        type: "response.function_call_arguments.done",
        name: "x",
        arguments: "not-json",
        call_id: "c2",
      }),
    ).toEqual({ name: "x", args: {}, callId: "c2" });

    expect(extractFunctionCall({ type: "response.audio.delta" })).toBeNull();
  });

  it("function result → conversation.item.create (stringified) + response.create", () => {
    const [item, create] = functionCallOutputMessages("c1", { ok: true, id: "b1" }) as [
      { type: string; item: { call_id: string; output: string } },
      { type: string },
    ];
    expect(item.type).toBe("conversation.item.create");
    expect(item.item.call_id).toBe("c1");
    expect(JSON.parse(item.item.output)).toEqual({ ok: true, id: "b1" });
    expect(create.type).toBe("response.create");
  });
});
