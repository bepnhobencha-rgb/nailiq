-- voice_ai_sessions.tool_log
--
-- `transcript` had two writers fighting over it: logVoiceToolCall appended one
-- entry per tool call while the session ran, and /api/voice/session/end wrote
-- the conversation the widget captured. Last write won, so a call that produced
-- a real conversation lost its tool log entirely — the record of what the agent
-- actually DID, which is the half you need when a booking goes wrong.
--
-- Splitting them: `transcript` keeps the human-readable conversation (role +
-- text per turn), `tool_log` keeps the machine record (tool name, ok, at).
alter table public.voice_ai_sessions
  add column if not exists tool_log jsonb not null default '[]'::jsonb;

comment on column public.voice_ai_sessions.transcript is
  'Conversation turns captured by the client: [{role: "ai"|"user", text}]. Written once at session end.';
comment on column public.voice_ai_sessions.tool_log is
  'Server-side record of tool invocations: [{at, type, tool, ok}]. Appended during the session.';
