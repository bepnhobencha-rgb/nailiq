export const BOOKING_STEP_EASE: [number, number, number, number] = [
  0.22, 1, 0.36, 1,
];

export type BookingMotionDir = number;

export const bookingStepVariants = {
  initial: (dir: BookingMotionDir) => ({
    x: dir * 40,
    opacity: 0,
  }),
  animate: {
    x: 0,
    opacity: 1,
  },
  exit: (dir: BookingMotionDir) => ({
    x: dir * -40,
    opacity: 0,
  }),
};
