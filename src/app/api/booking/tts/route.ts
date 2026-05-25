import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

// ElevenLabs — Sarah voice (premium, multi-lingual)
const ELEVENLABS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // Sarah — stable professional voice
const ELEVENLABS_MODEL = "eleven_turbo_v2"; // turbo_v2_5 deprecated → turbo_v2

export async function POST(req: NextRequest) {
  const { text } = (await req.json()) as {
    text: string;
    language?: "en" | "vi";
  };

  if (!text || text.length > 500) {
    return NextResponse.json({ error: "invalid_text" }, { status: 400 });
  }

  // Prefer ElevenLabs (more natural) — fall back to OpenAI if key not set
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: ELEVENLABS_MODEL,
            voice_settings: {
              stability: 0.40,       // less stability = more expressive/natural
              similarity_boost: 0.85,
              style: 0.35,           // more style = more personality
              use_speaker_boost: true,
            },
          }),
        },
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(`[TTS] ElevenLabs failed status=${res.status} voice=${ELEVENLABS_VOICE_ID} model=${ELEVENLABS_MODEL}:`, detail);
        throw new Error(`elevenlabs_${res.status}`);
      }
      const audioBuffer = await res.arrayBuffer();
      return new Response(audioBuffer, {
        headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
      });
    } catch (err) {
      console.error("[TTS] ElevenLabs failed, falling back to OpenAI TTS:", err);
    }
  }

  // OpenAI TTS fallback
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "no_tts_key" }, { status: 503 });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice: "nova",
    input: text,
    speed: 1.0,
    response_format: "mp3",
  });

  const audioBuffer = await response.arrayBuffer();
  return new Response(audioBuffer, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
