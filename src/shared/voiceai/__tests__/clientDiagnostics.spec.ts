import { describe, expect, it } from "vitest";
import {
  classifyVoiceFailure,
  normalizeVoiceClientDiagnostics,
  normalizeVoiceFailureCode,
  normalizeVoiceSessionChannel,
  voiceSessionChannelFromPathname,
} from "../clientDiagnostics";

describe("voice client diagnostics", () => {
  it("distinguishes embedded and direct booking surfaces", () => {
    expect(voiceSessionChannelFromPathname("/embed/tech-nails")).toBe("web_embed");
    expect(voiceSessionChannelFromPathname("/tech-nails")).toBe("web_direct");
    expect(normalizeVoiceSessionChannel("unknown")).toBe("web_direct");
  });

  it("keeps only bounded, privacy-safe media settings", () => {
    expect(normalizeVoiceClientDiagnostics(undefined)).toBeNull();
    expect(normalizeVoiceClientDiagnostics({
      channel: "web_embed",
      requested: { ignored: "caller content" },
      applied: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: "yes",
        sampleRate: 48000.4,
        deviceId: "must-not-survive",
      },
      outputMode: "audio_context_fallback",
      userAgent: "must-not-survive",
    })).toEqual({
      schemaVersion: 1,
      channel: "web_embed",
      requested: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 24000,
      },
      applied: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: null,
        sampleRate: 48000,
      },
      outputMode: "audio_context_fallback",
    });
  });

  it("allowlists failure codes and maps browser failures", () => {
    expect(normalizeVoiceFailureCode("mic_permission_denied")).toBe("mic_permission_denied");
    expect(normalizeVoiceFailureCode("raw provider error")).toBeNull();
    expect(classifyVoiceFailure("NotAllowedError", "Permission denied")).toBe("mic_permission_denied");
    expect(classifyVoiceFailure("NotFoundError", "No device")).toBe("mic_not_found");
    expect(classifyVoiceFailure("Error", "insecure_context")).toBe("insecure_context");
    expect(classifyVoiceFailure("Error", "session_init_503")).toBe("session_init_failed");
    expect(classifyVoiceFailure("Error", "unknown", "session_init")).toBe("session_init_failed");
    expect(classifyVoiceFailure("Error", "unknown", "connecting")).toBe("audio_pipeline_failed");
  });
});
