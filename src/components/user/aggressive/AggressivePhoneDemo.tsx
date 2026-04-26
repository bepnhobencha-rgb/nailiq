"use client";

import { PhoneFrame } from "@/components/ui/PhoneFrame";
import type { PhoneBookingCopy } from "@/components/ui/phone/phoneFrameTypes";
import type { AggressiveMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";

const AI_DEMO_INACTIVE = { active: false as const };

type AggressivePhoneDemoProps = {
  copy: AggressiveMessages;
  className?: string;
};

/**
 * Live product mock: hero scene only, demo strip/slots/activity from aggressive copy.
 */
export function AggressivePhoneDemo({ copy, className }: AggressivePhoneDemoProps) {
  const phoneBookingCopy: PhoneBookingCopy = {
    appBarTitle: copy.phoneBooking.appBarTitle,
    stepService: copy.phoneBooking.stepService,
    stepTime: copy.phoneBooking.stepTime,
    stepComplete: copy.phoneBooking.stepComplete,
    continue: copy.phoneBooking.continue,
    back: copy.phoneBooking.back,
    doneTitle: copy.phoneBooking.doneTitle,
    doneSubtitle: copy.phoneBooking.doneSubtitle,
    dateLine: copy.phoneBooking.dateLine,
    bookAnother: copy.phoneBooking.bookAnother,
  };

  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center",
        className,
      )}
    >
      <div className="relative w-full max-w-[min(18rem,92vw)] sm:max-w-[19rem]">
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-[min(20rem,48vh)] w-[min(18rem,86vw)] max-w-full -translate-x-1/2 -translate-y-1/2"
          aria-hidden
        >
          <div className="h-full w-full rounded-full bg-nq-primary/14 blur-[64px] opacity-90 sm:blur-[80px]" />
        </div>
        <PhoneFrame
          className="!max-w-full py-0"
          statusLabel="9:41"
          serviceStrip={copy.phone.serviceStrip}
          timeSlots={[
            copy.phone.phoneTimeSlots[0]!,
            copy.phone.phoneTimeSlots[1]!,
            copy.phone.phoneTimeSlots[2]!,
          ]}
          activityFeed={copy.phone.phoneActivity}
          displayScene="hero"
          aiDemo={AI_DEMO_INACTIVE}
          phoneBookingCopy={phoneBookingCopy}
          phoneAiLabel={copy.phoneAiLabel}
          phoneAiHint={copy.phoneAiHint}
          menuDemoRows={copy.phoneMenuDemoRows}
          heroMicroLine={copy.phone.phoneHeroMicroLine}
        >
          <p className="p-0.5 text-center text-[10px] leading-relaxed text-nq-primary-soft/90 sm:text-xs">
            {copy.phone.screenBody}
          </p>
        </PhoneFrame>
      </div>
    </div>
  );
}
