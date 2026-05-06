/**
 * User-facing copy (home shell + owner dashboard): English (default).
 */
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
    returningOwnerHint: string;
    /** Shown after “Send code” when this phone is already tied to a salon (before verify). */
    welcomeBackAfterSend: string;
    /** Enter-code screen when continuing as returning owner */
    welcomeBackVerifySubtext: string;
    /** Demo path (new signup) — short line beside DEMO MODE badge */
    newDemoOtpBadgeNote: string;
    /** Toast after "Send code" is clicked a second+ time on /register or after returning from /register/verify. */
    otpResentToast: string;
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
    statusPill: {
      waitingLabel: string;
      inProgressLabel: string;
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
      addForm: {
        namePlaceholder: string;
        phonePlaceholder: string;
        notePlaceholder: string;
        addButton: string;
        moreServices: string;
        submitting: string;
        errorRequired: string;
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
    statusPill: {
      waitingLabel: "WAIT",
      inProgressLabel: "ACTIVE",
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
      minutesAgo: (n: number) => (n < 1 ? "just now" : `${n} min`),
      addForm: {
        namePlaceholder: "Guest name",
        phonePlaceholder: "Phone",
        notePlaceholder: "Note for staff — e.g. polish color, prefers window seat",
        addButton: "Add to queue",
        moreServices: "More services",
        submitting: "Adding…",
        errorRequired: "Pick a service to continue.",
      },
    },
    walkin: {
      invalidPhone:
        "Phone number invalid. Example: 604 123 4567",
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
  },
};
