"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { DashboardModulesConfig } from "@/shared/dashboard/dashboardModules";

/**
 * Receptionist sound-alerts hook.
 *
 * Generates short, calm tones via the Web Audio API — **no external
 * audio files**. Designed to be ignorable at peripheral hearing
 * (UX_PRINCIPLES §1 "calm, direct, dependable") while still
 * communicating state changes (UX_PRINCIPLES §2 rule 3 — sound, like
 * motion, only when it communicates state, not for atmosphere).
 *
 * Browser autoplay policy: an `AudioContext` cannot play until a user
 * gesture has unlocked it. The hook lazily creates the context, then
 * waits for the first `pointerdown` / `keydown` / `touchstart` to
 * `resume()` it. Alerts that arrive before unlock are queued (capped
 * to one of each type) and drained on unlock.
 *
 * **Volume cap:** every recipe is clamped to `MAX_GAIN = 0.3` so the
 * desk never emits a startling sound, regardless of host volume.
 *
 * **Reduced-motion:** intentionally **not** honored — the brief is
 * explicit ("sound ≠ motion, don't conflate"). A user requesting
 * reduced motion has not requested reduced audio. The salon's
 * `dashboard_modules.sound_alerts` toggle is the one knob that turns
 * audio off.
 *
 * Returns:
 *   - `playAlert(type)` — fires the requested recipe; respects the
 *     module toggle + autoplay-lock state.
 *   - `isUnlocked` — `true` once the AudioContext has been resumed.
 *     Consumer surfaces a subtle 🔇 hint when `false`.
 */

export const SOUND_ALERT_TYPES = [
  "new_walkin",
  "overdue_booking",
  "vip_arrival",
] as const;

export type SoundAlertType = (typeof SOUND_ALERT_TYPES)[number];

interface ToneStep {
  /** Frequency in Hz. */
  freq: number;
  /** Tone duration in ms (200–400 per the brief; capped per step). */
  ms: number;
  /** Per-step gain (clamped to MAX_GAIN at play time). */
  gain: number;
}

/** Hard cap on per-step gain, so host volume never produces a startle. */
const MAX_GAIN = 0.3;

/**
 * Tone recipes. Sine-wave oscillators for warmth (avoids the "alarm
 * clock" feel of square/saw shapes). Frequencies sit in the speech
 * range (~440–880 Hz) so they're audible on small laptop / iPad
 * speakers without needing volume turned up.
 */
const TONE_RECIPES: Record<SoundAlertType, ReadonlyArray<ToneStep>> = {
  // Pleasant ascending two-tone (E5 → A5). 300ms total — short.
  new_walkin: [
    { freq: 660, ms: 150, gain: 0.22 },
    { freq: 880, ms: 150, gain: 0.26 },
  ],
  // Single attention tone (A4). 350ms — medium urgency, no harmonics.
  overdue_booking: [{ freq: 440, ms: 350, gain: 0.28 }],
  // Warm chime — C5 → E5 → G5 (C-major triad), 400ms total. Reads
  // as "positive arrival" rather than "warning".
  vip_arrival: [
    { freq: 523, ms: 120, gain: 0.2 },
    { freq: 659, ms: 120, gain: 0.22 },
    { freq: 784, ms: 160, gain: 0.24 },
  ],
};

/** Older Safari exposes the constructor under `webkitAudioContext`. */
function resolveAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  // Modern browsers expose `AudioContext` directly on `window` (lib.dom).
  // The fallback path covers older Safari; cast `unknown` rather than
  // intersect so we don't shadow lib.dom's `AudioContext` declaration.
  if (typeof window.AudioContext !== "undefined") return window.AudioContext;
  const legacy = (window as unknown as { webkitAudioContext?: typeof AudioContext })
    .webkitAudioContext;
  return legacy ?? null;
}

export interface UseSoundAlertsResult {
  /** Fire an alert. No-op if module is off; queued if audio is locked. */
  playAlert: (type: SoundAlertType) => void;
  /** `false` until the user has performed a gesture; surface a hint UI. */
  isUnlocked: boolean;
}

export function useSoundAlerts(
  modules: DashboardModulesConfig,
): UseSoundAlertsResult {
  const ctxRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<SoundAlertType[]>([]);
  const [isUnlocked, setIsUnlocked] = useState(false);

  /** Lazy AudioContext creation — only after first call. */
  const getContext = useCallback((): AudioContext | null => {
    if (ctxRef.current !== null) return ctxRef.current;
    const Ctor = resolveAudioContextCtor();
    if (Ctor === null) return null;
    try {
      ctxRef.current = new Ctor();
    } catch {
      ctxRef.current = null;
    }
    return ctxRef.current;
  }, []);

  /** Schedule a recipe at `ctx.currentTime`. Caller must verify `running`. */
  const playRecipe = useCallback(
    (ctx: AudioContext, type: SoundAlertType) => {
      const recipe = TONE_RECIPES[type];
      let when = ctx.currentTime;
      for (const step of recipe) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = step.freq;
        const peak = Math.min(step.gain, MAX_GAIN);
        const durSec = Math.max(0.05, step.ms / 1000);
        // Tiny attack + linear release prevents click artifacts on
        // start/stop without lengthening perceived duration.
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(peak, when + 0.01);
        g.gain.linearRampToValueAtTime(0, when + durSec);
        osc.connect(g).connect(ctx.destination);
        osc.start(when);
        osc.stop(when + durSec + 0.02);
        when += durSec;
      }
    },
    [],
  );

  const playAlert = useCallback(
    (type: SoundAlertType) => {
      if (!modules.sound_alerts) return;
      const ctx = getContext();
      if (ctx === null) return;
      if (ctx.state === "running") {
        playRecipe(ctx, type);
        return;
      }
      // Locked — queue de-duplicated by type so a flurry of the same
      // event doesn't create a back-to-back chord on unlock.
      if (!queueRef.current.includes(type)) {
        queueRef.current.push(type);
      }
    },
    [modules.sound_alerts, getContext, playRecipe],
  );

  /**
   * Unlock listener — runs ONCE on the first user gesture, drains
   * any queued alerts, then unbinds. Browser autoplay policy treats
   * `pointerdown` / `keydown` / `touchstart` as gestures; we attach
   * `passive: true` so we never interfere with desk taps.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isUnlocked) return;

    const tryUnlock = () => {
      const ctx = getContext();
      if (ctx === null) return;
      void (async () => {
        try {
          if (ctx.state === "suspended") {
            await ctx.resume();
          }
        } catch {
          // Resume failed; leave locked, will retry on next gesture.
          return;
        }
        if (ctx.state !== "running") return;
        setIsUnlocked(true);
        const queued = queueRef.current.splice(0);
        for (const t of queued) playRecipe(ctx, t);
      })();
    };

    const opts = { passive: true } as const;
    window.addEventListener("pointerdown", tryUnlock, opts);
    window.addEventListener("keydown", tryUnlock, opts);
    window.addEventListener("touchstart", tryUnlock, opts);
    return () => {
      window.removeEventListener("pointerdown", tryUnlock);
      window.removeEventListener("keydown", tryUnlock);
      window.removeEventListener("touchstart", tryUnlock);
    };
  }, [isUnlocked, getContext, playRecipe]);

  return { playAlert, isUnlocked };
}
