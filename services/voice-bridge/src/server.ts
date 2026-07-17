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
const TOOL_TIMEOUT_MS = 12_000;
const END_CALL_GRACE_MS = 4_000; // let the goodbye audio flush before hanging up

// Injected phone-only tool so the agent can actually hang up. Not a server tool —
// the bridge handles it locally by closing the call after the goodbye plays.
const END_CALL_TOOL = {
  type: "function",
  name: "end_call",
  description:
    "Hang up the phone call. Call this ONLY after you have already said a short goodbye, " +
    "when the caller says goodbye / asks to hang up, or the booking is fully finished.",
  parameters: { type: "object", properties: {} },
};

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
  let openaiWs: WebSocket | null = null;
  let closed = false;

  const closeAll = () => {
    if (closed) return;
    closed = true;
    try { openaiWs?.close(); } catch { /* noop */ }
    try { twilioWs.close(); } catch { /* noop */ }
  };

  const runTool = async (name: string, args: Record<string, unknown>, callId: string) => {
    let result: unknown;
    // Hard timeout: a slow/hung tool call must NEVER freeze the live call. Without
    // this, one stuck availability query leaves the caller in silence forever.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TOOL_TIMEOUT_MS);
    try {
      const r = await fetch(`${NEXT_APP_URL}/api/voice/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-voice-bridge-secret": BRIDGE_SECRET },
        body: JSON.stringify({ toolName: name, toolArgs: args, salonSlug: slug, callerVerifiedPhone: from }),
        signal: ac.signal,
      });
      result = await r.json().catch(() => ({ error: "tool_parse_failed" }));
    } catch {
      result = { error: "tool_unavailable" };
    } finally {
      clearTimeout(timer);
    }
    console.log("[voice-bridge] tool result:", name, JSON.stringify(result).slice(0, 200));
    for (const msg of functionCallOutputMessages(callId, result)) {
      openaiWs?.send(JSON.stringify(msg));
    }
  };

  const startOpenAi = async () => {
    // Fetch the agent config (instructions + tools + voice + model) from Next.
    let cfg: { model: string; voice: string; instructions: string; tools: unknown[] };
    try {
      const r = await fetch(`${NEXT_APP_URL}/api/voice/phone-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-voice-bridge-secret": BRIDGE_SECRET },
        body: JSON.stringify({ slug }),
      });
      if (!r.ok) { console.warn("[voice-bridge] phone-config FAILED", r.status); return closeAll(); }
      cfg = (await r.json()) as typeof cfg;
      console.log(`[voice-bridge] phone-config ok model=${cfg.model} tools=${cfg.tools?.length ?? 0}`);
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
      // Tell the agent the caller's own (carrier-verified) number so the common
      // case — booking under the number you're calling from — needs NO OTP. The
      // tool layer already treats callerVerifiedPhone == customer_phone as
      // verified; this just makes the agent USE that number by default instead
      // of asking and then failing verification on a mismatched one.
      const callerNote = from
        ? `\n\nCALLER PHONE: This caller is phoning from ${from}. Use THIS number as their ` +
          `booking contact by default — it is already verified, so do NOT request an OTP for it. ` +
          `Confirm it back briefly ("booking under the number you're calling from, ending ${from.slice(-4)}?"). ` +
          `Only if they ask to use a DIFFERENT number do you verify it with request_otp then verify_otp.`
        : "";
      openaiWs?.send(JSON.stringify(sessionUpdateMessage({
        instructions: cfg.instructions + callerNote,
        voice: cfg.voice,
        tools: [...cfg.tools, END_CALL_TOOL], // add hang-up capability for phone
      })));
      openaiWs?.send(JSON.stringify({ type: "response.create" })); // greet first
    });

    openaiWs.on("message", (raw) => {
      let evt: Record<string, unknown>;
      try { evt = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }

      // Surface errors + what the AI actually said (transcript) for diagnosis.
      const t = typeof evt.type === "string" ? evt.type : "";
      if (t.includes("error")) {
        console.warn("[voice-bridge] openai EVENT", raw.toString().slice(0, 600));
      } else if (t === "response.output_audio_transcript.done") {
        console.log("[voice-bridge] AI said:", String((evt as { transcript?: unknown }).transcript ?? "").slice(0, 300));
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
      if (fn) {
        console.log("[voice-bridge] tool:", fn.name, JSON.stringify(fn.args).slice(0, 200));
        if (fn.name === "end_call") {
          console.log("[voice-bridge] end_call — hanging up after goodbye");
          setTimeout(closeAll, END_CALL_GRACE_MS); // let the goodbye audio finish
          return;
        }
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
