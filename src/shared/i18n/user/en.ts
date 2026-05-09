/**
 * User-facing copy (home shell + owner dashboard): English (default).
 */
import { PHONE_INPUT_PLACEHOLDER_NANP } from "@/shared/lib/phoneFormat";
import { REGISTER_INVALID_PHONE_HINT_EN } from "@/shared/register/phone";

export type UserMessages = {
  brandName: string;
  /** sr-only and lightweight metadata-minded blurb */
  seoIntro: string;
  home: {
    headline: string;
    subline: string;
    ctaRegister: string;
    footerNote: string;
    navOwnerLogin: string;
    navOwnerLoginShort: string;
    alreadySalonPrefix: string;
    signInLink: string;
    /** Static landing (Landing.html parity) */
    landingUrgency: string;
    landingH1Line1: string;
    landingH1Gold: string;
    landingBody1: string;
    landingBody2: string;
    landingBody3: string;
    landingCta: string;
    landingMicrotrust: string;
    landingZap: string;
    /** Hero: one line under sub-headline */
    autoLine: string;
    /** Hero: muted line under CTA subtext */
    ctaSpeed: string;
    landingSectionEyebrow: string;
    landingSectionTitle: string;
    landingProblem1: string;
    landingProblem2: string;
    landingProblem3: string;
    landingClosingLine1: string;
    landingClosingLine2: string;
    landingClosingSub: string;
    landingClosingCta: string;
  };
  register: {
    /** Title on the phone-entry screen (`/register` step 1). */
    phoneEntryTitle: string;
    /** User-facing subtext on the phone-entry screen (production). */
    phoneAuthSubtext: string;
    /** User-facing subtext when SMS phone auth has not yet been configured. */
    phoneAuthDisabledSubtext: string;
    returningOwnerHint: string;
    /** Shown after “Send code” when this phone is already tied to a salon (before verify). */
    welcomeBackAfterSend: string;
    /** Enter-code screen when continuing as returning owner */
    welcomeBackVerifySubtext: string;
    /** Demo path (new signup) — short line beside DEMO MODE badge */
    newDemoOtpBadgeNote: string;
    /** Toast after "Send code" is clicked a second+ time on /register or after returning from /register/verify. */
    otpResentToast: string;
    /** Owner auth phone field — NANP-focused example (`/register`, `/login`). */
    phonePlaceholder: string;
    /** Inline validation before OTP send — Canada/US primary, Vietnam supported. */
    phoneDigitsInvalid: string;
  };
  /** Shared auth surfaces (login + register social buttons). Public booking is unaffected. */
  auth: {
    /** OR divider in social buttons block. */
    orDivider: string;
    continueWithGoogle: string;
    /** Toggle reveals magic-link form. */
    otherOptions: string;
    /** Toggle when magic-link form is open. */
    hideOptions: string;
    /** Submit button on /login (mode="login"). */
    sendLoginLink: string;
    /** Submit button on /register (mode="register"). */
    sendSignupLink: string;
    emailPlaceholder: string;
    emailInvalid: string;
    magicLinkSent: string;
    /** Generic Google sign-in failure copy. */
    googleSigninFailed: string;
    /** Generic magic-link send failure copy. */
    magicLinkSendFailed: string;
  };
  /** Multi-salon picker (`/choose-salon`). Shown when an authenticated user
   * has more than one `salon_members` row. Single-salon users skip it. */
  chooseSalon: {
    title: string;
    subtitle: string;
    signOut: string;
    roleBadge: {
      owner: string;
      senior: string;
      nail_tech: string;
    };
  };
  /** `/dashboard/[slug]` owner home — strings beyond the `salonDashboard`
   * section (banners, checklist, recovery-email banner, transient toasts).
   * Kept separate so the established `salonDashboard` keys don't drift. */
  ownerDashboard: {
    profileComplete: string;
    profileIncomplete: string;
    demoModeBadge: string;
    loadingText: string;
    retryText: string;
    /** Realtime toast when a new booking arrives. */
    newBookingToast: string;
    setupChecklist: {
      title: string;
      /** `{n}` is the integer percent complete (0-100). */
      percentComplete: string;
      addServices: string;
      addStaff: string;
      setHours: string;
      addAddress: string;
      addEmail: string;
      ariaLabel: string;
    };
    addEmailBanner: {
      emailPlaceholder: string;
      emailInvalid: string;
      saveFailed: string;
      saveButton: string;
      savingButton: string;
    };
  };
  salonDashboard: {
    title: string;
    slugLabel: string;
    bookingPageUrl: string;
    copyLink: string;
    copied: string;
    viewBookingPage: string;
    todaySummary: string;
    totalToday: string;
    pending: string;
    confirmed: string;
    completed: string;
    estRevenue: string;
    todayAppointments: string;
    upcomingConfirmed: string;
    noBookingsToday: string;
    noUpcoming: string;
    advanceStatus: string;
    client: string;
    service: string;
    salonStaffLabel: string;
    phone: string;
    /** Guest notes from the booking form (owner-visible). */
    clientNotes: string;
    loading: string;
    /** Manual dashboard refresh */
    refresh: string;
    /** Dashboard → /settings hub (gear button) */
    navSettings: string;
    /** Dashboard → Receptionist Center (`/center`) */
    navReceptionistCenter: string;
    lastUpdatedJustNow: string;
    lastUpdatedOneMinuteAgo: string;
    /** `{count}` = minutes */
    lastUpdatedMinutesAgo: string;
    emptyTodayTitle: string;
    emptyTodayHint: string;
    loadError: string;
    statusPending: string;
    statusConfirmed: string;
    statusCompleted: string;
    statusInProgress: string;
    statusWaiting: string;
    statusCancelled: string;
  };
  /** /dashboard/[slug]/settings hub */
  salonSettings: {
    pageTitle: string;
    pageIntro: string;
    sectionServices: string;
    sectionStaff: string;
    sectionHours: string;
    sectionAddress: string;
    hintRecoveryEmail: string;
    dashboardModules: {
      sectionTitle: string;
      sectionIntro: string;
      lockedHint: string;
      ownerOnlyHint: string;
      save: string;
      reset: string;
      saveError: string;
      forbidden: string;
      invalidKeys: string;
      coreTimeline: string;
      coreStaff: string;
      coreQueue: string;
      labels: {
        quickAdd: string;
        kpiBar: string;
        aiSuggestions: string;
        revenueToday: string;
        waitTime: string;
        alerts: string;
        vipIndicators: string;
        staffPerformance: string;
        timelineHeatmap: string;
        soundAlerts: string;
      };
    };
    dashboardPreset: {
      sectionTitle: string;
      sectionIntro: string;
      ownerOnlyHint: string;
      activeBadge: string;
      applying: string;
      saveError: string;
      forbidden: string;
      invalid: string;
      labels: {
        minimal: string;
        reception: string;
        rush_hour: string;
        owner: string;
        training: string;
        tv: string;
      };
      descriptions: {
        minimal: string;
        reception: string;
        rush_hour: string;
        owner: string;
        training: string;
        tv: string;
      };
    };
  };
  /** Setup CRUD error strings (services, etc.) */
  setupErrors: {
    serviceInUse: string;
    staffHasBookings: string;
    staffCannotPerformService: string;
  };
  /** F8 staff form (setup) */
  setupStaff: {
    servicesCapableLabel: string;
    servicesCapableHint: string;
    noServicesAvailable: string;
    /** Status selector label + per-value labels (B-03) */
    statusLabel: string;
    statusActive: string;
    statusPending: string;
    statusInactive: string;
    /** Inline badge shown on non-active rows in the list */
    pendingBadge: string;
    inactiveBadge: string;
    statusHint: string;
  };
  /** `/dashboard/[slug]/center` — operational receptionist workspace */
  receptionist: {
    title: string;
    loadingDay: string;
    navOwnerDashboard: string;
    loadError: {
      unauthorized: string;
      salon_not_found: string;
      invalid_date: string;
      server_error: string;
    };
    dateSwitcher: {
      yesterday: string;
      today: string;
      tomorrow: string;
    };
    /** Scroll timeline to current time (today). */
    jumpToNow: string;
    statusPill: {
      waitingLabel: string;
      inProgressLabel: string;
    };
    /** Salon-wide density slider — Simple ↔ Balanced ↔ Pro. */
    density: {
      label: string;
      simple: string;
      balanced: string;
      pro: string;
      /** sr-only on the radiogroup wrapper. */
      ariaLabel: string;
      /** Toast on successful update; takes the new level label. */
      updated: (label: string) => string;
      /** Toast on failure (any error). */
      updateFailed: string;
    };
    /** Role-adaptive top-bar labels. */
    roleBadge: {
      ownerView: string;
      nailTechView: string;
    };
    /** Realtime connection state (banner + mutation guards). */
    connection: {
      /** Amber banner when realtime channel errors / times out. */
      reconnecting: string;
      /** Red banner when realtime channel is closed; data is stale. */
      offline: string;
      /** Inline hint above walk-in submit when offline (mutation blocked). */
      offlineAddDisabled: string;
      /** Inline hint in booking drawer footer when offline (edit/cancel/start blocked). */
      offlineEditDisabled: string;
    };
    /** Hint shown next to top-bar icon when Web Audio is locked by autoplay policy. */
    soundUnlockHint: string;
    /** Top KPI band (gated by `dashboard_modules.kpi_bar`); revenue tile gated by `revenue_today`. */
    kpiBar: {
      waiting: string;
      avgWait: string;
      inService: string;
      comingUp: string;
      overdue: string;
      nextAvailable: string;
      revenueToday: string;
      /** "{n} min" — short minutes formatter for compact tile values. */
      minutesShort: (n: number) => string;
      /** "in {n} min" — appended to next-available staff name. */
      nextAvailableHint: (n: number) => string;
      /** "{name} now" when minutesUntilFree === 0. */
      nextAvailableNow: (name: string) => string;
      /** "—" placeholder when a tile has no data yet (e.g. no walk-in assigned today). */
      emptyDash: string;
      /** sr-only label announced by the skeleton. */
      loading: string;
    };
    setupIncompleteBanner: {
      title: string;
      message: string;
      cta: string;
    };
    queue: {
      title: string;
      emptyMessage: string;
      cancelButton: string;
      assignButton: string;
      urgentBadge: string;
      waitingHint: string;
      minutesAgo: (n: number) => string;
      sortLabel: string;
      sortFifo: string;
      sortLongestWait: string;
      priorityHigh: string;
      priorityMedium: string;
      priorityLow: string;
      partySizeLabel: (n: number) => string;
      sourceFallback: string;
      addForm: {
        namePlaceholder: string;
        phonePlaceholder: string;
        notePlaceholder: string;
        addButton: string;
        moreServices: string;
        submitting: string;
        errorRequired: string;
        sourceLabel: string;
        sourceOptions: {
          online: string;
          walk_in: string;
          instagram: string;
          google: string;
          phone: string;
          tiktok: string;
          repeat: string;
          vip: string;
        };
        priorityLabel: string;
        priorityOptions: {
          high: string;
          medium: string;
          low: string;
        };
        requestTagsLabel: string;
        requestTagsPlaceholder: string;
        requestTagAdd: string;
        requestTagRemove: (label: string) => string;
      };
    };
    walkin: {
      invalidPhone: string;
      phoneRequired: string;
      nameRequired: string;
      nameTooLong: string;
      invalidNameChars: string;
    };
    grid: {
      conflictWith: (clientName: string) => string;
      overflowMessage: string;
      conflictShake: string;
      /** Accessible labels for the booking-block icon stack. */
      bookingIcon: {
        vip: string;
        notes: string;
        late: string;
        design: string;
      };
    };
    undo: {
      undo: string;
      undoFailed: string;
      assignedPrefix: string;
      assignedMiddle: string;
    };
    drawer: {
      title: string;
      closeAria: string;
      /** Between start and visible service-end time on the Schedule line */
      scheduleTimeRangeSep: string;
      /** `+ {n} …` turnover note (interpolate `{n}` = buffer minutes) */
      bufferNote: string;
      durationMinutes: string;
      sourceWalkin: string;
      sourceAppointment: string;
      callGuest: (formattedDisplay: string) => string;
      startService: string;
      markComplete: string;
      cancelBooking: string;
      /** Pending / confirmed: open inline edit form */
      editBooking: string;
      cancelConfirm: (clientName: string) => string;
      none: string;
      scheduleSection: string;
      statusSection: string;
      priceSection: string;
      noNotesHint: string;
      /** Heading for the optional add-on service row in the booking drawer. */
      sectionAddon: string;
    };
    edit: {
      /** Section heading when editing from the drawer */
      modeTitle: string;
      timeLabel: string;
      staffLabel: string;
      serviceLabel: string;
      endTimePrefix: string;
      pricePrefix: string;
      saveButton: string;
      cancelButton: string;
      /** Copy shown with spinner during submit */
      saving: string;
      /** Brief success (e.g. future toast); not all surfaces use yet */
      successMessage: string;
      /** Optional: disabled-save affordance (`title`) */
      noChangesHint: string;
      /** Use `{name}` for conflict client name */
      conflictMessage: string;
      not_foundMessage: string;
      invalid_statusMessage: string;
      serverErrorMessage: string;
    };
    actionErrorFallback: string;
    actionErrors: {
      unauthorized: string;
      salon_mismatch: string;
      server_error: string;
      invalid_name: string;
      invalid_name_chars: string;
      invalid_service: string;
      service_not_found: string;
      note_too_long: string;
      invalid_booking: string;
      not_found: string;
      invalid_staff: string;
      invalid_time: string;
      staff_not_found: string;
      staff_cannot_perform_service: string;
      invalid_duration: string;
      invalid_buffer: string;
      slot_conflict: string;
      lost_race: string;
      invalid_transition: string;
      invalid_state: string;
      already_started: string;
      invalid_phone: string;
    };
    /** Permission-gated copy. Currently the UI hides the buttons entirely
     * for `nail_tech`; these strings are reserved for a future tooltip /
     * server-error fallback when a non-permitted action is attempted. */
    permissions: {
      noPermissionEdit: string;
      noPermissionCancel: string;
    };
    /** TV mode preset — full-screen read-only display. */
    tv: {
      title: string;
      guestsWaiting: string;
      estWait: string;
      exitTvMode: string;
      noBookings: string;
    };
    /** Quick Add: popular service shortcut chips above the service grid. */
    popularServices: {
      label: string;
    };
    /** Edit Booking: addon select copy. */
    editAddon: {
      label: string;
      none: string;
      add: string;
      remove: string;
    };
  };
};

export const userEn: UserMessages = {
  brandName: "NailIQ",
  seoIntro:
    "NailIQ is an AI-powered booking and operations system for nail salons.",
  home: {
    headline: "Run your salon with NailIQ",
    subline:
      "Set up your public booking link, manage today’s appointments, and grow from one place.",
    ctaRegister: "Get started free",
    footerNote: "New here? Create your salon in a few minutes.",
    navOwnerLogin: "Owner Login",
    navOwnerLoginShort: "Login",
    alreadySalonPrefix: "Already have a salon? ",
    signInLink: "Sign in →",
    landingUrgency:
      "⚠️ Most salons lose $50–$200 every day from missed calls",
    landingH1Line1:
      "$29/month.|Booking + walk-in queue,",
    landingH1Gold: "built for nail salons.",
    landingBody1:
      "3-5x cheaper than Booksy. Vietnamese-first. Walk-in queue included.",
    landingBody2: "That guest books somewhere else.",
    landingBody3: "You never know you lost them.",
    landingCta: "Try free for 14 days",
    landingMicrotrust: "14-day free trial. No credit card.",
    landingZap:
      "⚡ If you don’t fix this today, you’ll keep losing guests tomorrow",
    autoLine: "Works 24/7 — even when you're with clients.",
    ctaSpeed: "Sign up in 2 minutes.",
    landingSectionEyebrow:
      "You don’t see what you’re losing. But it happens every day.",
    landingSectionTitle: "Salons lose money in small moments",
    landingProblem1: "MISSED CALLS WHILE WITH A CLIENT",
    landingProblem2: "EMPTY SLOTS STAY EMPTY",
    landingProblem3: "GUESTS BOOK A DIFFERENT SALON",
    landingClosingLine1: "You’re losing guests",
    landingClosingLine2: "every day.",
    landingClosingSub:
      "If you don’t start today, you’ll keep losing them.",
    landingClosingCta: "Start winning them back now",
  },
  register: {
    phoneEntryTitle: "Enter your phone",
    phoneAuthSubtext:
      "We'll send a secure one-time verification code to your phone.",
    phoneAuthDisabledSubtext: "⚠️ SMS login is not configured yet.",
    returningOwnerHint:
      "Returning owner? Enter your number to sign back in.",
    welcomeBackAfterSend:
      "Welcome back! Enter the code to access your dashboard.",
    welcomeBackVerifySubtext:
      "Welcome back! Enter the code to access your dashboard.",
    newDemoOtpBadgeNote:
      "DEMO MODE · OTP appears below.",
    otpResentToast:
      "New code sent — previous code is no longer valid.",
    phonePlaceholder: PHONE_INPUT_PLACEHOLDER_NANP,
    phoneDigitsInvalid: REGISTER_INVALID_PHONE_HINT_EN,
  },
  auth: {
    orDivider: "or",
    continueWithGoogle: "Continue with Google",
    otherOptions: "Other options",
    hideOptions: "Hide options",
    sendLoginLink: "Send login link",
    sendSignupLink: "Send sign-up link",
    emailPlaceholder: "you@example.com",
    emailInvalid: "Enter a valid email address.",
    magicLinkSent: "Magic link sent. Check your email to continue.",
    googleSigninFailed: "Google sign-in failed.",
    magicLinkSendFailed: "Could not send link. Try again.",
  },
  chooseSalon: {
    title: "Choose your salon",
    subtitle: "Select which salon to manage",
    signOut: "Sign out",
    roleBadge: {
      owner: "Owner",
      senior: "Senior",
      nail_tech: "Nail Tech",
    },
  },
  ownerDashboard: {
    profileComplete: "✓ Profile complete — ready for bookings",
    profileIncomplete:
      "Complete your salon profile to start taking real bookings",
    demoModeBadge: "Demo mode",
    loadingText: "Loading…",
    retryText: "Try again",
    newBookingToast: "You have a new booking from a customer!",
    setupChecklist: {
      title: "Setup",
      percentComplete: "{n}% complete",
      addServices: "Add your services",
      addStaff: "Add your staff",
      setHours: "Set opening hours",
      addAddress: "Add salon address",
      addEmail: "Add recovery email",
      ariaLabel: "Salon setup checklist",
    },
    addEmailBanner: {
      emailPlaceholder: "Email address",
      emailInvalid: "Enter a valid email address.",
      saveFailed: "Could not save email. Try again.",
      saveButton: "Save email",
      savingButton: "Saving…",
    },
  },
  salonDashboard: {
    title: "Salon dashboard",
    slugLabel: "URL",
    bookingPageUrl: "Booking page",
    copyLink: "Copy link",
    copied: "Copied",
    viewBookingPage: "View booking page",
    todaySummary: "Today",
    totalToday: "Bookings",
    pending: "Pending",
    confirmed: "Confirmed",
    completed: "Completed",
    estRevenue: "Est. revenue",
    todayAppointments: "Today’s appointments",
    upcomingConfirmed: "Upcoming (confirmed)",
    noBookingsToday: "No bookings today.",
    noUpcoming: "No confirmed appointments in the next 7 days.",
    advanceStatus: "Update status",
    client: "Guest",
    service: "Service",
    salonStaffLabel: "Staff",
    phone: "Phone",
    clientNotes: "Guest notes",
    loading: "Loading…",
    refresh: "Refresh",
    navSettings: "Settings",
    navReceptionistCenter: "Front Desk",
    lastUpdatedJustNow: "Last updated: just now",
    lastUpdatedOneMinuteAgo: "Last updated: 1 minute ago",
    lastUpdatedMinutesAgo: "Last updated: {count} minutes ago",
    emptyTodayTitle: "No bookings today yet.",
    emptyTodayHint: "Share your booking link to get started.",
    loadError: "Could not load dashboard.",
    statusPending: "Pending",
    statusConfirmed: "Confirmed",
    statusCompleted: "Completed",
    statusInProgress: "In progress",
    statusWaiting: "Waiting",
    statusCancelled: "Cancelled",
  },
  salonSettings: {
    pageTitle: "Settings",
    pageIntro:
      "Manage your services, team, opening hours, and salon address—all in one place.",
    sectionServices: "Services & pricing",
    sectionStaff: "Staff",
    sectionHours: "Opening hours",
    sectionAddress: "Salon address",
    hintRecoveryEmail:
      "To add or change recovery email for your account, use the banner on your dashboard.",
    dashboardModules: {
      sectionTitle: "Dashboard modules",
      sectionIntro:
        "Choose what appears on the receptionist desk. Core layout stays on; optional modules can be hidden.",
      lockedHint: "Always on",
      ownerOnlyHint: "Only the salon owner can change desk modules.",
      save: "Save",
      reset: "Reset",
      saveError: "Could not save. Try again.",
      forbidden: "You do not have permission to change these settings.",
      invalidKeys: "Invalid module payload.",
      coreTimeline: "Timeline grid",
      coreStaff: "Staff columns",
      coreQueue: "Walk-in queue",
      labels: {
        quickAdd: "Quick add walk-in",
        kpiBar: "Today status (waiting / in progress)",
        aiSuggestions: "AI suggestions",
        revenueToday: "Prices & revenue hints on grid",
        waitTime: "Queue wait time & urgency",
        alerts: "Setup warnings on desk",
        vipIndicators: "Walk-in lane highlight",
        staffPerformance: "Staff role & busy ring",
        timelineHeatmap: "Dense timeline grid lines",
        soundAlerts: "Sound alerts",
      },
    },
    dashboardPreset: {
      sectionTitle: "Workspace preset",
      sectionIntro:
        "Pick the desk shape that matches today. Modules toggle on top of the preset.",
      ownerOnlyHint: "Only the salon owner can change the workspace preset.",
      activeBadge: "Active",
      applying: "Applying…",
      saveError: "Could not change preset. Try again.",
      forbidden: "You do not have permission to change the preset.",
      invalid: "That preset is not recognized.",
      labels: {
        minimal: "Minimal",
        reception: "Reception",
        rush_hour: "Rush hour",
        owner: "Owner",
        training: "Training",
        tv: "TV mode",
      },
      descriptions: {
        minimal: "Bare desk: queue only. Use on small screens or quiet shifts.",
        reception:
          "Default front-desk layout: queue, quick add, wait time, alerts.",
        rush_hour:
          "Busy-shift mode: adds today status and walk-in lane highlight.",
        owner: "Full instrumentation including KPIs, revenue, and AI hints.",
        training: "Stripped-down view for new staff: queue and quick add.",
        tv: "Read-only wall display: queue at a glance, no input chrome.",
      },
    },
  },
  setupErrors: {
    serviceInUse:
      "Service is used in active bookings. Cancel or complete those bookings before deleting.",
    staffHasBookings:
      "Staff has upcoming bookings. Reassign or cancel before deleting.",
    staffCannotPerformService:
      "This staff member is not set up to perform that service.",
  },
  setupStaff: {
    servicesCapableLabel: "Services this staff can perform",
    servicesCapableHint:
      "Leave all checked when unsure — you can narrow this later.",
    noServicesAvailable: "Add a service first to assign capabilities.",
    statusLabel: "Status",
    statusActive: "Active",
    statusPending: "Pending",
    statusInactive: "Inactive",
    pendingBadge: "Pending",
    inactiveBadge: "Inactive",
    statusHint:
      "Only active staff appear in the public booking flow and walk-in queue.",
  },
  receptionist: {
    title: "Front desk",
    loadingDay: "Loading day…",
    navOwnerDashboard: "Dashboard",
    loadError: {
      unauthorized: "Sign in is required.",
      salon_not_found: "Salon not found or not ready.",
      invalid_date: "That date does not resolve in the salon timezone.",
      server_error: "Something went wrong. Try again shortly.",
    },
    dateSwitcher: {
      yesterday: "Yesterday",
      today: "Today",
      tomorrow: "Tomorrow",
    },
    jumpToNow: "Now",
    statusPill: {
      waitingLabel: "WAIT",
      inProgressLabel: "ACTIVE",
    },
    density: {
      label: "Density",
      simple: "Simple",
      balanced: "Balanced",
      pro: "Pro",
      ariaLabel: "Dashboard density — Simple, Balanced, or Pro",
      updated: (label: string) => `Density set to ${label}`,
      updateFailed: "Could not change density. Try again shortly.",
    },
    roleBadge: {
      ownerView: "Owner view",
      nailTechView: "Tech view",
    },
    connection: {
      reconnecting: "Reconnecting to live updates…",
      offline: "Offline — showing last known data",
      offlineAddDisabled: "Offline — cannot add walk-ins",
      offlineEditDisabled: "Offline — editing unavailable",
    },
    soundUnlockHint: "Click anywhere to enable sound alerts",
    kpiBar: {
      waiting: "Waiting",
      avgWait: "Avg wait",
      inService: "In service",
      comingUp: "Coming up (30m)",
      overdue: "Overdue",
      nextAvailable: "Next available",
      revenueToday: "Revenue today",
      minutesShort: (n: number) => `${n} min`,
      nextAvailableHint: (n: number) => `in ${n} min`,
      nextAvailableNow: (name: string) => `${name} now`,
      emptyDash: "—",
      loading: "Loading desk metrics",
    },
    setupIncompleteBanner: {
      title: "Setup incomplete",
      message: "Add services and staff before accepting customers.",
      cta: "Go to Setup →",
    },
    queue: {
      title: "Walk-in queue",
      emptyMessage: "No walk-ins queued. Use the form above to add.",
      cancelButton: "Remove",
      assignButton: "Assign",
      urgentBadge: "URGENT",
      waitingHint: "Tap a slot on the timeline to seat this guest",
      minutesAgo: (n: number) =>
        n < 1 ? "just now" : `${n} min wait`,
      sortLabel: "Sort",
      sortFifo: "First in",
      sortLongestWait: "Longest wait",
      priorityHigh: "High",
      priorityMedium: "Medium",
      priorityLow: "Low",
      partySizeLabel: (n: number) => `Party of ${n}`,
      sourceFallback: "Walk-in",
      addForm: {
        namePlaceholder: "Guest name",
        phonePlaceholder: PHONE_INPUT_PLACEHOLDER_NANP,
        notePlaceholder:
          "Note for staff — e.g. polish color, prefers window seat",
        addButton: "Add to queue",
        moreServices: "More services",
        submitting: "Adding…",
        errorRequired: "Pick a service to continue.",
        sourceLabel: "Source",
        sourceOptions: {
          online: "Online",
          walk_in: "Walk-in",
          instagram: "Instagram",
          google: "Google",
          phone: "Phone",
          tiktok: "TikTok",
          repeat: "Repeat",
          vip: "VIP",
        },
        priorityLabel: "Priority",
        priorityOptions: {
          high: "High",
          medium: "Medium",
          low: "Low",
        },
        requestTagsLabel: "Request tags",
        requestTagsPlaceholder: "e.g. Wants Tina",
        requestTagAdd: "Add",
        requestTagRemove: (label: string) => `Remove ${label}`,
      },
    },
    walkin: {
      invalidPhone:
        "Phone number invalid. Examples: +1 (604) 555-1234 or +84901234567",
      phoneRequired: "Enter the guest phone number.",
      nameRequired: "Please enter the guest name.",
      nameTooLong: "Name cannot exceed 100 characters.",
      invalidNameChars:
        "Name contains invalid characters.",
    },
    grid: {
      conflictWith: (clientName: string) =>
        `${clientName.trim() ? `⚠ Busy — ${clientName}` : "⚠ Slot conflict"}`,
      overflowMessage: "⚠ Past closing hours",
      conflictShake:
        "That slot overlaps another booking. Choose another slot or time.",
      bookingIcon: {
        vip: "VIP",
        notes: "Has notes",
        late: "Late",
        design: "Design / nail art",
      },
    },
    undo: {
      undo: "Undo",
      undoFailed: "Service already started — undo is unavailable.",
      assignedPrefix: "Assigned:",
      assignedMiddle: "→",
    },
    drawer: {
      title: "Booking",
      closeAria: "Close details",
      /** Between two wall times in Schedule line (hour range). */
      scheduleTimeRangeSep: " → ",
      /** After `scheduleTimeRangeSep` end time; interpolates `{n}` = buffer minutes. */
      bufferNote: "+ {n} min buffer",
      durationMinutes: "{n} minutes",
      sourceWalkin: "Walk-in",
      sourceAppointment: "Appointment",
      callGuest: (formattedDisplay: string) => `📞 Call ${formattedDisplay}`,
      startService: "Start service",
      markComplete: "Mark complete",
      cancelBooking: "Cancel booking",
      editBooking: "Edit",
      cancelConfirm: (clientName: string) =>
        `Cancel booking for ${clientName.trim() ? clientName.trim() : "this guest"}?`,
      none: "—",
      scheduleSection: "Schedule",
      statusSection: "Status",
      priceSection: "Price",
      noNotesHint: "No notes",
      sectionAddon: "Add-on",
    },
    edit: {
      modeTitle: "Edit booking",
      timeLabel: "Time",
      staffLabel: "Staff",
      serviceLabel: "Service",
      endTimePrefix: "Ends at",
      pricePrefix: "Price",
      saveButton: "Save changes",
      cancelButton: "Cancel",
      saving: "Saving...",
      successMessage: "Booking updated",
      noChangesHint: "No changes",
      /** `{name}` is the other guest name from the server (`replace`, may be empty). */
      conflictMessage: "Slot taken by {name}. Pick another time.",
      not_foundMessage: "Booking not found",
      invalid_statusMessage: "Cannot edit this booking",
      serverErrorMessage: "Server error. Try again.",
    },
    actionErrorFallback: "Could not complete that action. Try again.",
    actionErrors: {
      unauthorized: "Sign in is required.",
      salon_mismatch: "Salon did not match your session.",
      server_error: "Something went wrong. Try again shortly.",
      invalid_name: "Enter a guest name.",
      invalid_name_chars: "Name contains invalid characters.",
      invalid_service: "Pick a valid service.",
      service_not_found: "That service could not be found.",
      note_too_long: "Staff note is too long.",
      invalid_booking: "Booking not found.",
      not_found: "That booking could not be found.",
      invalid_staff: "Staff not valid.",
      invalid_time: "Time is invalid.",
      staff_not_found: "Staff not found.",
      staff_cannot_perform_service:
        "This staff member is not set up to perform that service.",
      invalid_duration: "Service duration looks wrong.",
      invalid_buffer: "Service buffer looks wrong.",
      slot_conflict: "That slot overlaps another booking.",
      lost_race: "Someone else acted first. Reload and try again.",
      invalid_transition: "That status change is not allowed right now.",
      invalid_state: "That booking is no longer in the right status.",
      already_started: "Service already started — cannot undo.",
      invalid_phone: "Enter a valid guest phone number.",
    },
    permissions: {
      noPermissionEdit: "Contact your owner to edit bookings",
      noPermissionCancel: "Contact your owner to cancel bookings",
    },
    tv: {
      title: "Front Desk — Live View",
      guestsWaiting: "guests waiting",
      estWait: "Est. wait",
      exitTvMode: "Exit TV Mode",
      noBookings: "Available",
    },
    popularServices: {
      label: "Popular today",
    },
    editAddon: {
      label: "Add-on",
      none: "None",
      add: "Add extra service",
      remove: "Remove add-on",
    },
  },
};
