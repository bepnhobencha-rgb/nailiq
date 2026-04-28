import { colors } from "@/shared/theme/tokens";

export const BOOKING_CONFETTI_COLORS = [
  colors.primary,
  colors.primarySoft,
  "#B8960C",
];

export async function fireBookingConfetti(): Promise<void> {
  const mod = await import("canvas-confetti");
  mod.default({
    particleCount: 80,
    spread: 70,
    origin: { x: 0.5, y: 0.6 },
    colors: BOOKING_CONFETTI_COLORS,
    disableForReducedMotion: true,
  });
}
