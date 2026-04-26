"use client";

import { PhoneFrame } from "@/components/ui/PhoneFrame";
import type { UserLanguage, UserMessages } from "@/shared/i18n/user";
import { useDocumentPhoneScene } from "@/shared/lib/useDocumentPhoneScene";
import { cn } from "@/shared/lib/cn";

/** Inactive AI file demo; upload flow removed from marketing aside. */
const AI_DEMO_INACTIVE = { active: false as const };

type MarketingPhoneAsideProps = {
  t: UserMessages;
  language: UserLanguage;
  parallaxY: number;
  className?: string;
};

/**
 * Landing hero phone: scroll-linked scenes, parallax shell.
 */
export function MarketingPhoneAside({
  t,
  language,
  parallaxY,
  className,
}: MarketingPhoneAsideProps) {
  const displayScene = useDocumentPhoneScene(language);

  return (
    <div
      className={cn(
        "relative z-0 flex w-full min-w-0 flex-col items-center",
        className,
      )}
      style={{
        transform: `translate3d(0, ${parallaxY}px, 0)`,
      }}
    >
      <div className="relative z-0 w-full max-w-[min(18rem,92vw)] shrink-0 sm:max-w-[19rem] lg:max-w-[22rem]">
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-[min(22rem,50vh)] w-[min(20rem,88vw)] max-w-full -translate-x-1/2 -translate-y-1/2 sm:h-[min(26rem,60vh)] sm:w-[min(26rem,90vw)]"
          aria-hidden
        >
          <div className="h-full w-full rounded-full bg-nq-primary/18 blur-[72px] opacity-90 sm:blur-[90px] lg:blur-[100px]" />
        </div>
        <PhoneFrame
          className="w-full py-0"
          statusLabel="9:41"
          serviceStrip={t.serviceStrip}
          timeSlots={t.phoneTimeSlots}
          activityFeed={t.phoneActivity}
          displayScene={displayScene}
          aiDemo={AI_DEMO_INACTIVE}
          phoneBookingCopy={{
            appBarTitle: t.phoneBookingSceneTitle,
            stepService: t.phoneBookingStepService,
            stepTime: t.phoneBookingStepTime,
            stepComplete: t.phoneBookingStepComplete,
            continue: t.phoneBookingContinue,
            back: t.phoneBookingBack,
            doneTitle: t.phoneBookingDoneTitle,
            doneSubtitle: t.phoneBookingDoneSubtitle,
            dateLine: t.phoneBookingDateLine,
            bookAnother: t.phoneBookingBookAnother,
          }}
          phoneAiLabel={t.phoneAiSceneLabel}
          phoneAiHint={t.phoneAiSceneHint}
          menuDemoRows={t.phoneMenuDemoRows}
          heroMicroLine={t.phoneHeroMicroLine}
        >
          <p className="p-0.5 text-center text-[10px] leading-relaxed text-nq-primary-soft/90 sm:text-xs">
            {t.phoneScreenBody}
          </p>
        </PhoneFrame>
      </div>
    </div>
  );
}
