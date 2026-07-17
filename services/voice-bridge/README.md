# NailIQ voice bridge (Twilio Voice ↔ OpenAI Realtime)

A tiny persistent WebSocket service. Vercel serverless functions cannot hold a
socket for a whole phone call, so the audio bridge runs here (Fly.io). The AI
agent — prompt, tools, booking logic — stays in the Next app; this process only
moves audio and relays tool calls, so **web and phone run the same brain**.

```
Caller ─▶ Twilio number ─(Voice webhook)▶ /api/twilio/voice  ──TwiML <Connect><Stream>──▶  this bridge
                                                                                  │  ▲
                                                            OpenAI Realtime WS ◀──┘  └──▶ Twilio audio
                                          tool call ─▶ POST /api/voice/tool (callerVerifiedPhone = From, + bridge secret)
```

## Env / secrets (never commit)
| Var | Where | What |
|---|---|---|
| `OPENAI_API_KEY` | bridge | Realtime API key (server-side, not an ephemeral key) |
| `VOICE_BRIDGE_SECRET` | bridge **and** Next | shared secret; Next honours `callerVerifiedPhone` + `phone-config` only with it |
| `NEXT_APP_URL` | bridge | e.g. `https://nailiq.ca` (for phone-config + voice/tool) |
| `VOICE_BRIDGE_WSS_URL` | Next | e.g. `wss://nailiq-voice-bridge.fly.dev/media` (put in the TwiML Stream) |
| `PORT` | bridge | Fly sets 8080 |

## Deploy (needs a human — I cannot run these here)
1. `cd services/voice-bridge`
2. `fly launch --no-deploy` (or reuse existing app `nailiq-voice-bridge`)
3. `fly secrets set OPENAI_API_KEY=… VOICE_BRIDGE_SECRET=… NEXT_APP_URL=https://nailiq.ca`
4. `fly deploy`
5. On Vercel/Next env: set `VOICE_BRIDGE_SECRET` (same value) + `VOICE_BRIDGE_WSS_URL=wss://<app>.fly.dev/media`
6. Twilio: point the salon's number **Voice webhook** to `https://nailiq.ca/api/twilio/voice?slug=<salon-slug>` (POST)
7. Turn on `voice_ai_enabled` for that ONE pilot salon, place a test call.

## Live bring-up notes (untested from CI)
- Both sides speak G.711 μ-law 8 kHz (`g711_ulaw`) → no transcoding.
- OpenAI has revised Realtime event names across versions — `src/router.ts` accepts
  the known audio-delta / function-call variants; confirm against the current
  Realtime docs when wiring the real key.
- The pure protocol mapping (`src/router.ts`) is unit-tested (`router.spec.ts`);
  the socket glue (`src/server.ts`) can only be verified with a real call.
