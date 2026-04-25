export type PhoneActivityItem = { label: string; line: string };

/** i18n bundle for the marketing phone booking flow (3 steps). */
export type PhoneBookingCopy = {
  appBarTitle: string;
  stepService: string;
  stepTime: string;
  stepComplete: string;
  continue: string;
  back: string;
  doneTitle: string;
  doneSubtitle: string;
  dateLine: string;
  bookAnother: string;
};

/** Scroll-linked + hero phone scene (AI demo overrides when active). */
export type PhoneFrameScene = "hero" | "booking" | "ai";

export type PhoneAiDemoStage = "scan" | "list";

export type PhoneAiDemoState =
  | { active: false }
  | { active: true; objectUrl: string; stage: PhoneAiDemoStage };
