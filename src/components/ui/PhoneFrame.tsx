"use client";

import { motion } from "framer-motion";
import { type HTMLAttributes, useEffect, useState } from "react";
import { PhoneAiFileDemo, PhoneAiIdleScan, PhoneSceneStack } from "@/components/ui/phone/PhoneAiScanViews";
import { PhoneBookingView } from "@/components/ui/phone/PhoneBookingView";
import { PhoneHeroScreen } from "@/components/ui/phone/PhoneHeroScreen";
import { IphoneStatusBar } from "@/components/ui/phone/IphoneStatusBar";
import type {
  PhoneActivityItem,
  PhoneAiDemoState,
  PhoneBookingCopy,
  PhoneFrameScene,
} from "@/components/ui/phone/phoneFrameTypes";
import { cn } from "@/shared/lib/cn";

const DEFAULT_SERVICE_STRIP = ["Pedicure", "Manicure", "Gel"] as const;
const DEFAULT_TIME_SLOTS = ["3:00 PM", "3:30 PM", "4:00 PM"] as const;
const AI_SCAN_S = 1.5;

export type {
  PhoneActivityItem,
  PhoneFrameScene,
  PhoneAiDemoState,
  PhoneBookingCopy,
} from "@/components/ui/phone/phoneFrameTypes";

export type PhoneFrameProps = HTMLAttributes<HTMLDivElement> & {
  children: React.ReactNode;
  /** “9:41” or similar when live clock is off */
  statusLabel?: string;
  serviceStrip?: readonly [string, string, string];
  timeSlots?: readonly [string, string, string];
  activityFeed?: ReadonlyArray<PhoneActivityItem>;
  displayScene: PhoneFrameScene;
  aiDemo: PhoneAiDemoState;
  phoneBookingCopy: PhoneBookingCopy;
  phoneAiLabel: string;
  phoneAiHint: string;
  menuDemoRows: ReadonlyArray<{
    category: string;
    name: string;
    price: string;
  }>;
  /** Shown under hero booking card (hero scene) */
  heroMicroLine?: string;
};

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setReduced(mq.matches);
    read();
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);
  return reduced;
}

/**
 * iPhone-style device with scroll-linked in-screen scenes, optional AI menu demo,
 * and an iOS-like status bar. Respects `prefers-reduced-motion`.
 */
export function PhoneFrame({
  className,
  children,
  statusLabel = "9:41",
  serviceStrip = DEFAULT_SERVICE_STRIP,
  timeSlots = DEFAULT_TIME_SLOTS,
  activityFeed,
  displayScene,
  aiDemo,
  phoneBookingCopy,
  phoneAiLabel,
  phoneAiHint,
  menuDemoRows,
  heroMicroLine,
  ...props
}: PhoneFrameProps) {
  const reduced = usePrefersReducedMotion();

  return (
    <div
      className={cn(
        "relative z-0 mx-auto w-full max-w-[min(16rem,88vw)] py-1.5",
        "sm:max-w-[17rem] sm:py-2",
        "lg:max-w-[20.5rem] xl:max-w-[21.5rem]",
        "origin-center [transform:translateZ(0)]",
        className,
      )}
      {...props}
    >
      <div className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-56 w-56 -translate-x-1/2 -translate-y-1/2 sm:h-64 sm:w-64" aria-hidden>
        <div className="h-full w-full rounded-full bg-nq-primary/22 blur-[48px] animate-nq-orb sm:blur-[56px]" />
      </div>
      <div className="pointer-events-none absolute top-1/2 left-1/2 -z-20 h-72 w-72 -translate-x-1/2 -translate-y-1/2" aria-hidden>
        <div className="h-full w-full rounded-full bg-nq-primary/10 blur-[80px] opacity-90" />
      </div>

      <motion.div
        className={cn(
          "relative z-10 aspect-[9/19.5] w-full touch-manipulation select-none",
          "rounded-[2.35rem] border border-nq-border/50 p-1.5",
          "bg-nq-bg shadow-nq-card-luxury",
          "ring-1 ring-nq-primary/12",
          "origin-center will-change-transform",
        )}
        whileTap={reduced ? undefined : { scale: 0.99 }}
        transition={{ type: "spring", stiffness: 500, damping: 35 }}
      >
        <div
          className={cn(
            "relative flex h-full w-full min-h-0 flex-col overflow-hidden",
            "rounded-[1.82rem] border border-nq-primary/10 bg-nq-bg",
            "ring-1 ring-inset ring-nq-border/30",
          )}
        >
          <IphoneStatusBar
            mode={reduced ? "static" : "live"}
            staticLabel={statusLabel}
          />
          <div className="min-h-0 flex-1 overflow-hidden px-1.5 pb-2 sm:px-2">
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-nq-border/25 bg-nq-surface/35 p-1.5 ring-1 ring-inset ring-nq-primary/6">
              <div className="h-full min-h-0 max-h-full">
                <PhoneSceneStack
                  displayScene={displayScene}
                  reduced={reduced}
                  aiDemo={aiDemo}
                  childrenHero={
                    <PhoneHeroScreen
                      strip={serviceStrip}
                      times={timeSlots}
                      activityFeed={activityFeed ?? []}
                      microLine={heroMicroLine}
                      reduced={reduced}
                    >
                      {children}
                    </PhoneHeroScreen>
                  }
                  booking={
                    <PhoneBookingView
                      copy={phoneBookingCopy}
                      services={serviceStrip}
                      times={timeSlots}
                      reduced={reduced}
                    />
                  }
                  aiIdle={
                    <PhoneAiIdleScan
                      label={phoneAiLabel}
                      hint={phoneAiHint}
                      reduced={reduced}
                    />
                  }
                  aiFileDemo={
                    <PhoneAiFileDemo
                      demo={aiDemo}
                      scanDuration={AI_SCAN_S}
                      menuRows={menuDemoRows}
                      reduced={reduced}
                    />
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
