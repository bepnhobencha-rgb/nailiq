import { describe, expect, it } from "vitest";
import {
  addRealtimeUsage,
  estimateRealtimeCostUsd,
  normalizeRealtimeUsage,
  realtimeUsageFromEvent,
} from "../realtimeUsage";

describe("Realtime usage telemetry", () => {
  it("extracts only bounded token counters from response.done", () => {
    const usage = realtimeUsageFromEvent({
      type: "response.done",
      response: {
        output: [{ transcript: "private conversation" }],
        usage: {
          input_token_details: {
            text_tokens: 119,
            audio_tokens: 13,
            image_tokens: 2,
            cached_tokens_details: {
              text_tokens: 64,
              audio_tokens: 3,
              image_tokens: 1,
            },
          },
          output_token_details: { text_tokens: 30, audio_tokens: 91 },
        },
      },
    });

    expect(usage).toEqual({
      schemaVersion: 1,
      responseCount: 1,
      inputTextTokens: 119,
      inputAudioTokens: 13,
      inputImageTokens: 2,
      cachedInputTextTokens: 64,
      cachedInputAudioTokens: 3,
      cachedInputImageTokens: 1,
      outputTextTokens: 30,
      outputAudioTokens: 91,
      transcriptionAudioTokens: 0,
    });
    expect(JSON.stringify(usage)).not.toContain("private");
  });

  it("adds response and transcription counters without retaining content", () => {
    const response = realtimeUsageFromEvent({
      type: "response.done",
      response: {
        usage: {
          input_token_details: { text_tokens: 10, audio_tokens: 20 },
          output_token_details: { text_tokens: 3, audio_tokens: 4 },
        },
      },
    });
    const transcription = realtimeUsageFromEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "do not retain me",
      usage: { input_token_details: { audio_tokens: 17 } },
    });

    expect(addRealtimeUsage(response, transcription)).toMatchObject({
      responseCount: 1,
      inputTextTokens: 10,
      inputAudioTokens: 20,
      outputTextTokens: 3,
      outputAudioTokens: 4,
      transcriptionAudioTokens: 17,
    });
  });

  it("normalizes hostile client values and caps every counter", () => {
    expect(normalizeRealtimeUsage({
      responseCount: -2,
      inputTextTokens: Number.POSITIVE_INFINITY,
      inputAudioTokens: 50_000_000,
      outputAudioTokens: 2.9,
      transcript: "not part of the schema",
    })).toMatchObject({
      responseCount: 0,
      inputTextTokens: 0,
      inputAudioTokens: 10_000_000,
      outputAudioTokens: 2,
    });
  });

  it("prices uncached, cached, output, and transcription usage server-side", () => {
    const estimate = estimateRealtimeCostUsd("gpt-realtime-2.1", {
      responseCount: 1,
      inputTextTokens: 1_000_000,
      cachedInputTextTokens: 250_000,
      inputAudioTokens: 1_000_000,
      cachedInputAudioTokens: 250_000,
      inputImageTokens: 1_000_000,
      cachedInputImageTokens: 250_000,
      outputTextTokens: 1_000_000,
      outputAudioTokens: 1_000_000,
      transcriptionAudioTokens: 600,
    });

    // Text in $3 + cached $0.10; audio in $24 + cached $0.10;
    // image in $3.75 + cached $0.125; outputs $24 + $64;
    // transcription 60 seconds = $0.017.
    expect(estimate?.estimatedCostUsd).toBe(119.092);
    expect(estimate?.pricingAsOf).toBe("2026-08-01");
  });

  it("fails closed for an unpriced future model", () => {
    expect(estimateRealtimeCostUsd("gpt-realtime-future", {})).toBeNull();
  });
});
