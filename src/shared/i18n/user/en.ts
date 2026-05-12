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
    /** Subtext when demo OTP mode is active (replaces phoneAuthSubtext). */
    phoneAuthDemoSubtext: string;
    /** Dev-only helper hint shown under demo subtext. */
    phoneAuthDemoHelperHint: string;
    /** User-facing subtext when SMS phone auth has not yet been configured. */
    phoneAuthDisabledSubtext: string;
    returningOwnerHint: string;
    /** Shown after “Send code” when this phone is already tied to a salon (before verify). */
    welcomeBackAfterSend: string;
    /** Enter-code screen when continuing as returning owner */
    welcomeBackVerifySubtext: string;
    /** Demo path (new signup) — short line beside DEMO MODE badge */
    newDemoOtpBadgeNote: string;
    /** Demo-mode badge labels for /register and /register/verify. */
    demoBadgeReturning: string;
    demoBadgeNew: string;
    /** /register/verify demo-mode caption when not returning. */
    demoVerifyCaptionNew: string;
    /** Toast after "Send code" is clicked a second+ time on /register or after returning from /register/verify. */
    otpResentToast: string;
    /** Owner auth phone field — NANP-focused example (`/register`, `/login`). */
    phonePlaceholder: string;
    /** Inline validation before OTP send — Canada/US primary, Vietnam supported. */
    phoneDigitsInvalid: string;
    /** /register/setup wizard copy — added 2026-05-09 to make the
     * salon-name field unmistakable (QA report: users were typing
     * their own name as salon name). */
    wizardTitle: string;
    wizardSubtext: string;
    salonNameLabel: string;
    salonNamePlaceholder: string;
    salonNameHint: string;
    salonNameInvalid: string;
    slugLabel: string;
    slugHint: string;
    /** Aria label on the editable slug input. */
    slugAriaLabel: string;
    timezoneLabel: string;
    timezoneHint: string;
    submitCreate: string;
    submitCreating: string;
    /** Generic fallback when completeSalonRegistration server action
     * fails without a recognised error code. */
    submitErrorGeneric: string;
    /** Shown when the OTP-issued completion token has expired. */
    submitErrorExpiredToken: string;
    /** Submit button on /register before/while sending OTP. */
    sendCode: string;
    sendingCode: string;
    /** /register/verify screen */
    verifyTitle: string;
    verifyDefaultSubtext: string;
    /** "Number ending in ····{last4} — enter all 6 digits of the code." */
    verifyNumberEnding: string;
    verifyContinue: string;
    verifyChecking: string;
    verifyUseDifferentNumber: string;
    verifyRememberLabel: string;
    verifyRememberSubLabel: string;
    verifyErrorExpired: string;
    verifyErrorServer: string;
    verifyErrorInvalid: string;
    verifyErrorMissingToken: string;
    /** Email magic-link mode (sms_enabled=false, email_enabled=true) */
    emailEntryTitle: string;
    emailAuthSubtext: string;
    emailPlaceholder: string;
    emailInvalid: string;
    sendEmailLink: string;
    sendingEmailLink: string;
    /** Shown after magic link is dispatched — replaces the form. */
    emailLinkSentTitle: string;
    emailLinkSentBody: string;
    /** Shown when both sms_enabled and email_enabled are false. */
    registrationDisabledTitle: string;
    registrationDisabledBody: string;
  };
  /** Marketing landing page (`/`) — full copy across all sections.
   * Wired through `useUserLanguage` so the EN/VI toggle in the nav
   * actually re-renders the page content. */
  landing: {
    nav: {
      signIn: string;
      tryFree: string;
      langAriaLabel: string;
    };
    hero: {
      eyebrow: string;
      h1Line1: string;
      h1Gold: string;
      subline: string;
      ctaPrimary: string;
      ctaSecondary: string;
      microtrust: string;
    };
    pain: {
      eyebrow: string;
      h2: string;
      lede: string;
      stat1: { label: string; body: string };
      stat2: { label: string; body: string };
      stat3: { display: string; sub: string; label: string; body: string };
    };
    features: {
      eyebrow: string;
      h2: string;
      booking: { title: string; body: string };
      queue: { title: string; body: string };
      center: { title: string; body: string };
    };
    howItWorks: {
      eyebrow: string;
      h2: string;
      step1: { title: string; body: string; preview: string };
      step2: { title: string; body: string; preview: string };
      step3: { title: string; body: string; preview: string };
      bottomCta: string;
    };
    socialProof: {
      eyebrow: string;
      h2: string;
      sub: string;
    };
    pricing: {
      eyebrow: string;
      h2: string;
      sub: string;
      perMonth: string;
      taxNote: string;
      ccNotice: string;
      plans: ReadonlyArray<{
        /** "free" | "pro" | "studio" — component uses id to apply highlight + CTA logic */
        id: string;
        name: string;
        price: string;
        /** Badge text (e.g. "Most Popular"). Null means no badge, but a spacer is rendered for vertical alignment. */
        badge: string | null;
        features: ReadonlyArray<string>;
        cta: string;
      }>;
    };
    finalCta: {
      eyebrow: string;
      h2: string;
      sub: string;
      ctaPrimary: string;
      ctaSecondary: string;
    };
    footer: {
      privacy: string;
      terms: string;
      contact: string;
      builtIn: string;
    };
  };
  /** Dashboard app-shell navigation (sidebar + mobile bottom bar). */
  nav: {
    frontDesk: string;
    calendar: string;
    clients: string;
    services: string;
    staff: string;
    walkinQueue: string;
    messages: string;
    reports: string;
    marketing: string;
    settings: string;
    /** Quick-action button at the bottom of the nav rail. */
    quickAddWalkin: string;
    /** Static placeholder badge for the disabled Messages row. */
    messagesSoonBadge: string;
    collapseSidebar: string;
    expandSidebar: string;
    /** Aria label on the bottom-tab `<nav>`. */
    primaryNav: string;
    /** Sidebar footer trigger + dropdown header for the salon switcher
     * (rendered only when the owner has > 1 owner-memberships). */
    switchSalon: string;
  };
  /** Phone-OTP login flow (`/login`, `/login/verify`). Distinct from
   * `register.*` so the two flows can diverge without cross-talk. */
  login: {
    title: string;
    subtextSms: string;
    subtextDemo: string;
    /** Subtext shown when SMS is off but email magic-link is on. */
    subtextEmail: string;
    promptEnterPhone: string;
    sendCode: string;
    sendingCode: string;
    noSalonPrefix: string;
    signupLink: string;
    /** Email magic-link branch (sms_enabled=false, email_enabled=true). */
    emailEntryTitle: string;
    emailPlaceholder: string;
    emailInvalid: string;
    sendSigninLink: string;
    sendingSigninLink: string;
    emailLinkSentTitle: string;
    /** `{email}` placeholder gets replaced at render time. */
    emailLinkSentBody: string;
    emailLinkUseDifferent: string;
    /** Branch shown when both sms_enabled and email_enabled are false. */
    signinDisabledTitle: string;
    signinDisabledBody: string;
    /** /login/verify */
    verifyTitle: string;
    /** "Code sent to ending ····{last4}" */
    verifySubtextSent: string;
    verifySubtextLoading: string;
    verifyConfirm: string;
    verifyVerifying: string;
    verifyChangePhone: string;
    verifyErrorExpired: string;
    verifyErrorServer: string;
    verifyErrorInvalid: string;
    verifyErrorNoSalon: string;
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
      /** Headline copy on the banner (paired with the lock icon). */
      headline: string;
      /** Sub-line social-proof / urgency copy under the headline. */
      socialProof: string;
      /** Toggle button that expands the inline email form. */
      ctaAdd: string;
      /** Dismiss button (7-day snooze). */
      ctaLater: string;
      /** Success bubble shown for 3s after a successful save. */
      successMessage: string;
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
    /** Recovery-email verification status block (Settings hub). */
    emailVerification: {
      sectionTitle: string;
      noEmailHint: string;
      verifiedBadge: string;
      pendingBadge: string;
      pendingHint: string;
      verifiedToast: string;
      verifyErrorPrefix: string;
    };
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
    /** Brand color picker (PR #109). */
    brandColor: {
      sectionTitle: string;
      intro: string;
      colorPickerAria: string;
      presetsLabel: string;
      previewLabel: string;
      previewButton: string;
      save: string;
      saving: string;
      resetDefault: string;
      errorInvalid: string;
      errorGeneric: string;
      /** Light/dark toggle copy (booking page theme). */
      themeLabel: string;
      themeDark: string;
      themeLight: string;
      /** Brand-from-image-URL extractor (PR #114, pivoted in #117 from
       *  website-URL → direct image URL after CDN/bot-protection blocks).
       *  PR #118 adds two client-side upload buttons (logo / screenshot)
       *  that run entirely in the browser; the URL input is kept as a
       *  tertiary fallback. */
      extract: {
        sectionLabel: string;
        hint: string;
        placeholder: string;
        extract: string;
        extracting: string;
        apply: string;
        errorInvalidUrl: string;
        errorMissingKey: string;
        errorGeneric: string;
        /** Client-side upload UI keys. */
        matchYourBrand: string;
        uploadLogo: string;
        uploadScreenshot: string;
        extractedFromLogo: string;
        extractedFromScreenshot: string;
        applyColor: string;
        tryAnother: string;
        colorExtractionFailed: string;
      };
    };
  };
  /** Service category labels — IDs match `services.category` CHECK constraint. */
  serviceCategory: {
    manicure: string;
    pedicure: string;
    acrylic: string;
    gel: string;
    dip: string;
    waxing: string;
    other: string;
    /** Aria label / fallback for the setup-wizard category dropdown. */
    pickerLabel: string;
  };
  /** Service description + curation labels for the setup wizard form. */
  serviceForm: {
    /** Label on the description textarea in add/edit service form. */
    descriptionLabel: string;
    /** Placeholder text inside the description textarea. */
    descriptionPlaceholder: string;
    /** Inline hint under the textarea explaining length / purpose. */
    descriptionHint: string;
    /** Validation error when description exceeds DESCRIPTION_MAX_LEN. */
    descriptionTooLong: string;
    /** Toggle / checkbox label for the is_popular flag. */
    popularLabel: string;
    /** Helper line under the popular toggle. */
    popularHint: string;
    /** Live "{used}/{max}" counter rendered next to the description field. */
    characterCount: string;
    /** Toast shown for ~2s after save when the server auto-generated a
     *  description because the owner left the field blank. */
    descriptionGeneratedToast: string;
  };
  /** Setup CRUD error strings (services, etc.) */
  setupErrors: {
    serviceInUse: string;
    staffHasBookings: string;
    staffCannotPerformService: string;
    /** Hit when free-plan owner tries to add another staff past the limit. */
    staffLimitReached: string;
    /** Hit when free-plan owner tries to add another service past the limit. */
    serviceLimitReached: string;
    /** CTA copy on the inline upgrade link. */
    upgradeCta: string;
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
      /** Short label for the slide-over toggle button in the top bar. */
      toggleShort: string;
      /** Aria-label on the slide-over close (X) button. */
      closePanel: string;
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
      /** Hero-suffix below the wait number on the dispatch card. */
      waitHeroSuffix: string;
      /** Aria label for the gold VIP crown badge. */
      vipAria: string;
      /** "Ready ~{time}" template — interpolate {time}. */
      readyAroundShort: string;
      /** "❤️ Khách yêu cầu thợ này" full line. */
      requestedByClientLine: string;
      /** Overload banner template. */
      overloadBanner: (input: {
        name: string;
        queueAhead: number;
      }) => string;
      overloadBannerDismiss: string;
      /** Soft-hold copy (PR #104). */
      softHoldButton: string;
      softHoldClear: string;
      softHoldLabel: string;
      softHoldCountdown: (minutesLeft: number) => string;
      /** "{name}'s hold expired" — shown via the desk status line. */
      softHoldExpiredNotice: string;
      /** Customer wait-link share (PR #105). */
      waitLinkButton: string;
      waitLinkModal: {
        title: string;
        instruction: string;
        copyLink: string;
        copied: string;
        openLink: string;
        closeAria: string;
      };
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
        /** Walk-in form checkbox: "khách yêu cầu thợ này". Drives the
         * ❤️ icon on the resulting booking chip. */
        staffRequestedByClient: string;
        /** Phone-lookup card copy (PR #100). */
        returningCustomer: string;
        newCustomer: string;
        returningCustomerHeader: string;
        vipBadge: string;
        /** "{count} visits · {total} total" — interpolate {count} and {total}. */
        profileSummary: string;
        /** "Last visit: {date}" — interpolate {date}. */
        lastVisitLine: string;
        /** "Usual: {service}" — interpolate {service}. */
        usualServiceLine: string;
        /** "❤️ Often with {name}" — interpolate {name}. */
        favoriteStaffPrefix: string;
        favoriteStaffLine: string;
        notesLabel: string;
        lookupLoading: string;
        lookupLoadingAria: string;
        /** Smart-availability dropdown + card copy (PR #101). */
        requestedStaffLabel: string;
        bestMatchOption: string;
        bestMatchRecommendation: string;
        readyNow: string;
        waitMinutesShort: (n: number) => string;
        readyAroundTime: string;
        assignImmediately: string;
        waitForStaff: string;
        pickAnotherStaff: string;
        heavyLoad: string;
        heavyLoadDetail: string;
        availabilityHeader: string;
        availabilityChecking: string;
        queueAheadHint: (n: number) => string;
        confidenceMedium: string;
        confidenceLow: string;
        /** Inline error when auto-pick mode finds no available staff
         * (e.g. after-hours walk-in attempt). The form keeps all
         * existing values so the receptionist can pick a staff
         * member manually without re-entering data. */
        autoPickNoStaffAvailable: string;
        /** Sub-label under the unified "Add customer" button when the
         * recommended staff is free now. Template — interpolate `{name}`. */
        subLabelAssignNow: string;
        /** Sub-label when no staff is free now → falls back to queue. */
        subLabelQueue: string;
        /** Sub-label when a specific staff is picked but they are busy
         * — assignment is deferred until their queue clears. Template
         * — interpolate `{name}`. */
        subLabelAssignTo: string;
        relative: {
          justNow: string;
          today: string;
          daysAgo: (n: number) => string;
          weeksAgo: (n: number) => string;
          monthsAgo: (n: number) => string;
        };
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
        /** Heart icon shown when the booking has a non-empty
         * `staff_request_note` (e.g. "wants Tuong Vy"). */
        staffRequest: string;
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
    /** Rush hour banner (PR #104). */
    rushHour: {
      /** "⚡ Rush Hour — {n} customers waiting". Interpolate {n}. */
      bannerLabel: string;
      dismiss: string;
    };
    /** Edit Booking: addon select copy. */
    editAddon: {
      label: string;
      none: string;
      add: string;
      remove: string;
    };
    /** Audit / event log viewer (owner-only Settings section). */
    auditLog: {
      sectionTitle: string;
      sectionIntro: string;
      loading: string;
      empty: string;
      unknownGuest: string;
      errors: {
        unauthorized: string;
        forbidden: string;
        server_error: string;
      };
      actorRoles: Partial<Record<string, string>>;
      summaries: {
        booking_created: string;
        booking_edited: string;
        booking_cancelled: string;
        booking_status_changed: string;
        walkin_added: string;
        addon_added: string;
      };
    };
    /** Top-level error boundary fallback for the Receptionist Center. */
    errorBoundary: {
      title: string;
      message: string;
      retryButton: string;
    };
    /** Day/Week view toggle in the top bar. */
    viewMode: {
      day: string;
      week: string;
      ariaLabel: string;
    };
    /** Read-only week-overview grid. */
    weekView: {
      title: string;
      prevWeek: string;
      thisWeek: string;
      nextWeek: string;
      loading: string;
      dayError: string;
      emptyDay: string;
      /** "{n} bookings" — count badge per day. */
      bookingCount: string;
      /** "+{n} more" — overflow indicator. */
      moreCount: string;
      /** Aria label template for the day-header button. `{date}` = "Mon 9". */
      openDayAria: string;
    };
    /** Client profiles panel + page (`/dashboard/[slug]/clients`). */
    clientProfiles: {
      pageTitle: string;
      sectionTitle: string;
      sectionIntro: string;
      searchPlaceholder: string;
      loading: string;
      empty: string;
      unknownName: string;
      vipBadge: string;
      /** "{visits} visits · last {lastVisit}" — collapsed-row summary. */
      summaryLine: string;
      totalSpent: string;
      email: string;
      notes: string;
      noNotes: string;
      vipLabel: string;
      vipHint: string;
      errors: {
        unauthorized: string;
        forbidden: string;
        server_error: string;
      };
      vipUpdateErrors: {
        unauthorized: string;
        forbidden: string;
        not_found: string;
        server_error: string;
      };
    };
    /** Subscription pricing panel (`/dashboard/[slug]/settings`). */
    pricing: {
      sectionTitle: string;
      sectionIntro: string;
      currentBadge: string;
      perMonth: string;
      unlimited: string;
      featureMaxStaff: string;
      featureMaxServices: string;
      featureReports: string;
      featureAuditLog: string;
      upgrade: string;
      manageSubscription: string;
      upgradedToast: string;
      planBadgePro: string;
      planBadgePremium: string;
      planNames: {
        free: string;
        pro: string;
        premium: string;
      };
      errors: {
        unauthorized: string;
        forbidden: string;
        invalid_plan: string;
        no_stripe_client: string;
        server_error: string;
      };
      portalErrors: {
        unauthorized: string;
        forbidden: string;
        no_customer: string;
        no_stripe_client: string;
        server_error: string;
      };
    };
    /** Reports & analytics page (`/dashboard/[slug]/reports`). */
    reports: {
      pageTitle: string;
      navLinkLabel: string;
      loading: string;
      rangeAriaLabel: string;
      range: {
        today: string;
        week: string;
        month: string;
      };
      kpis: {
        totalRevenue: string;
        appointments: string;
        completed: string;
        cancelled: string;
        noShow: string;
      };
      tables: {
        topServices: string;
        topStaff: string;
        empty: string;
        serviceCol: string;
        staffCol: string;
        countCol: string;
        appointmentsCol: string;
        revenueCol: string;
      };
      busyHours: {
        title: string;
        empty: string;
        /** "{n} bookings in range" */
        totalBookings: string;
      };
      errors: {
        unauthorized: string;
        forbidden: string;
        server_error: string;
      };
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
    phoneAuthDemoSubtext:
      "Demo mode shows the OTP on screen. Production uses SMS from Supabase.",
    phoneAuthDemoHelperHint:
      "Dev: enable Phone Auth in Supabase (Auth → Providers → Phone) before disabling demo.",
    phoneAuthDisabledSubtext: "⚠️ SMS login is not configured yet.",
    returningOwnerHint:
      "Returning owner? Enter your number to sign back in.",
    welcomeBackAfterSend:
      "Welcome back! Enter the code to access your dashboard.",
    welcomeBackVerifySubtext:
      "Welcome back! Enter the code to access your dashboard.",
    newDemoOtpBadgeNote:
      "DEMO MODE · OTP appears below.",
    demoBadgeReturning: "Returning",
    demoBadgeNew: "Demo mode",
    demoVerifyCaptionNew: "Use the code from the demo modal or server log.",
    otpResentToast:
      "New code sent — previous code is no longer valid.",
    phonePlaceholder: PHONE_INPUT_PLACEHOLDER_NANP,
    phoneDigitsInvalid: REGISTER_INVALID_PHONE_HINT_EN,
    wizardTitle: "Name your salon",
    wizardSubtext:
      "Use the salon's business name — what guests will see on your booking page. Don't put your own name here.",
    salonNameLabel: "Salon name",
    salonNamePlaceholder: "e.g. Mai Nail Studio",
    salonNameHint:
      "Tip: this is the salon's business name (not your personal name). Guests will see this on the booking page.",
    salonNameInvalid: "Enter a salon name (max 120 characters).",
    slugLabel: "Booking URL",
    slugHint:
      "Letters and numbers only. Edit if you want a shorter URL.",
    slugAriaLabel: "Booking URL slug",
    timezoneLabel: "Time zone",
    timezoneHint:
      "We use this to show booking times correctly to you and your guests.",
    submitCreate: "Create your booking page",
    submitCreating: "Creating…",
    submitErrorGeneric: "Could not create your salon. Try again.",
    submitErrorExpiredToken:
      "Your verification expired — start again from phone entry.",
    sendCode: "Send code",
    sendingCode: "Sending…",
    verifyTitle: "Enter code",
    verifyDefaultSubtext: "We sent a 6-digit code to your number.",
    verifyNumberEnding:
      "Number ending in ····{last4} — enter all 6 digits of the code.",
    verifyContinue: "Continue",
    verifyChecking: "Checking…",
    verifyUseDifferentNumber: "Use a different number",
    verifyRememberLabel: "Keep me signed in on this device (90 days)",
    verifyRememberSubLabel: "Uncheck if this is a shared device",
    verifyErrorExpired: "Code expired — request a new one.",
    verifyErrorServer:
      "We could not verify your code. Check SUPABASE_SERVICE_ROLE_KEY and migrations.",
    verifyErrorInvalid: "Invalid code.",
    verifyErrorMissingToken: "Missing completion token. Try again.",
    emailEntryTitle: "Enter your email",
    emailAuthSubtext:
      "We'll send you a secure sign-in link — no code to type.",
    emailPlaceholder: "you@example.com",
    emailInvalid: "Enter a valid email address.",
    sendEmailLink: "Send sign-in link",
    sendingEmailLink: "Sending…",
    emailLinkSentTitle: "Check your inbox",
    emailLinkSentBody:
      "We sent a sign-in link to {email}. Click the link in the email to continue — it expires in 60 minutes.",
    registrationDisabledTitle: "Registration temporarily unavailable",
    registrationDisabledBody:
      "We're unable to accept new registrations at this time. Please try again later.",
  },
  landing: {
    nav: {
      signIn: "Sign in",
      tryFree: "Try free",
      langAriaLabel: "Language",
    },
    hero: {
      eyebrow: "Trusted by salons in Canada & Vietnam",
      h1Line1: "$29/month. Booking + walk-in queue,",
      h1Gold: "built for nail salons.",
      subline:
        "3–5× cheaper than Booksy. Vietnamese-first. No missed calls.",
      ctaPrimary: "Try free for 14 days",
      ctaSecondary: "See how it works ↓",
      microtrust: "No credit card · 14-day trial · Setup in 2 minutes",
    },
    pain: {
      eyebrow: "The Problem",
      h2: "You’re losing money right now",
      lede:
        "Every salon owner we’ve talked to has the same three holes in the bucket. Here’s the math.",
      stat1: {
        label: "Lost from missed calls",
        body:
          "Phones ring while staff are busy. Each unanswered call is a booking that walks down the block to your competitor.",
      },
      stat2: {
        label: "Don’t rebook after first visit",
        body:
          "Without an easy booking link, returning customers default to whoever has online slots — even if they loved you.",
      },
      stat3: {
        display: "Walk-ins",
        sub: "leave",
        label: "When you’re too busy to take them",
        body:
          "No queue means walk-ins guess at wait times, get frustrated, and leave. A live queue keeps them — and your revenue.",
      },
    },
    features: {
      eyebrow: "Features",
      h2: "Everything a nail salon needs",
      booking: {
        title: "Online Booking",
        body:
          "Your booking link, open 24/7. Clients pick service, staff, and time without calling — works on any phone, no app install.",
      },
      queue: {
        title: "Walk-in Queue",
        body:
          "Real-time queue management. No chaos during busy hours — see who’s next at a glance, and customers always know their wait.",
      },
      center: {
        title: "Receptionist Center",
        body:
          "Live grid showing all bookings and walk-ins. Reschedule, reassign staff, and resolve conflicts in seconds, not minutes.",
      },
    },
    howItWorks: {
      eyebrow: "Get Started",
      h2: "Live in 15 minutes",
      step1: {
        title: "Sign up with your phone",
        body: "OTP verification. No email required to start.",
        preview:
          "You’ll see — a 4-digit code in seconds, then your dashboard.",
      },
      step2: {
        title: "Add services and staff",
        body:
          "Pre-loaded templates speed it up. Most salons finish in 10 minutes.",
        preview:
          "You’ll see — your menu live and ready to take bookings.",
      },
      step3: {
        title: "Share your booking link",
        body:
          "Copy your nailiq.com/your-salon URL. Send to clients via Zalo, SMS, or stick on the front desk.",
        preview: "You’ll see — your first booking land within hours.",
      },
      bottomCta: "Ready when you are. Try free for 14 days",
    },
    socialProof: {
      eyebrow: "Trusted By",
      h2: "What salon owners say",
      sub: "Early access feedback",
    },
    pricing: {
      eyebrow: "Pricing",
      h2: "Simple, transparent pricing",
      sub: "No hidden fees. Upgrade or cancel anytime.",
      perMonth: "/month",
      taxNote: "+ applicable taxes. CAD pricing.",
      ccNotice: "No credit card required",
      plans: [
        {
          id: "free",
          name: "Free",
          price: "$0",
          badge: null,
          features: [
            "1 staff member",
            "Up to 10 services",
            "Online booking link",
            "Walk-in queue",
            "Vietnamese & English support",
          ],
          cta: "Get started free",
        },
        {
          id: "pro",
          name: "Pro",
          price: "$29",
          badge: "Most Popular",
          features: [
            "Up to 10 staff",
            "Up to 50 services",
            "Real-time receptionist center",
            "Owner reports & analytics",
            "Audit log",
            "Cancel anytime — no contract",
          ],
          cta: "Start 14-day free trial",
        },
        {
          id: "studio",
          name: "Studio",
          price: "$59",
          badge: null,
          features: [
            "Unlimited staff",
            "Unlimited services",
            "Everything in Pro",
            "Multi-location (coming soon)",
            "Priority support",
          ],
          cta: "Coming soon",
        },
      ],
    },
    finalCta: {
      eyebrow: "One last thing",
      h2: "Ready to stop losing bookings?",
      sub:
        "14-day free trial. No credit card. Cancel anytime. Setup in 2 minutes.",
      ctaPrimary: "Start your free trial",
      ctaSecondary: "See how it works ↓",
    },
    footer: {
      privacy: "Privacy",
      terms: "Terms",
      contact: "Contact",
      builtIn: "Built in Vancouver, BC 🇨🇦",
    },
  },
  nav: {
    frontDesk: "Live Board",
    calendar: "Calendar",
    clients: "Customers",
    services: "Services",
    staff: "Staff",
    walkinQueue: "Walk-in Queue",
    messages: "Messages",
    reports: "Reports",
    marketing: "Retention",
    settings: "Settings",
    quickAddWalkin: "+ Walk-in",
    messagesSoonBadge: "Soon",
    collapseSidebar: "Collapse sidebar",
    expandSidebar: "Expand sidebar",
    primaryNav: "Primary navigation",
    switchSalon: "Switch salon",
  },
  login: {
    title: "Sign in",
    subtextSms: "We'll send you an OTP via SMS.",
    subtextDemo: "Demo mode shows the OTP on screen.",
    subtextEmail: "We'll email you a sign-in link.",
    promptEnterPhone: "Enter the phone number registered to your salon.",
    sendCode: "Send code",
    sendingCode: "Sending…",
    noSalonPrefix: "No salon yet? ",
    signupLink: "Sign up",
    emailEntryTitle: "Enter your email",
    emailPlaceholder: "you@example.com",
    emailInvalid: "Enter a valid email address.",
    sendSigninLink: "Send sign-in link",
    sendingSigninLink: "Sending…",
    emailLinkSentTitle: "Check your email",
    emailLinkSentBody: "We sent a sign-in link to {email}.",
    emailLinkUseDifferent: "Use a different email",
    signinDisabledTitle: "Sign-in is temporarily unavailable",
    signinDisabledBody:
      "We've paused sign-in while platform maintenance is in progress. Please check back soon.",
    verifyTitle: "Enter OTP",
    verifySubtextSent: "Sent a 6-digit code to {masked}",
    verifySubtextLoading: "Loading…",
    verifyConfirm: "Confirm",
    verifyVerifying: "Verifying…",
    verifyChangePhone: "Change phone number",
    verifyErrorExpired: "Code expired.",
    verifyErrorServer: "Server error. Please try again.",
    verifyErrorInvalid: "Incorrect code.",
    verifyErrorNoSalon: "This number is not registered.",
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
      headline:
        "Secure your account — add email to never lose dashboard access",
      socialProof:
        "3 salons lost access this week from missing recovery email",
      ctaAdd: "Add email",
      ctaLater: "Maybe later",
      successMessage: "✓ Email saved! You're protected.",
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
    emailVerification: {
      sectionTitle: "Recovery email",
      noEmailHint:
        "No recovery email on file. Add one from your dashboard.",
      verifiedBadge: "Verified",
      pendingBadge: "Pending",
      pendingHint:
        "We sent a verification link to your inbox. Open it to confirm.",
      verifiedToast: "Email verified.",
      verifyErrorPrefix: "Verification failed: ",
    },
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
    brandColor: {
      sectionTitle: "Brand color",
      intro: "Your salon's primary color. Shows on the public booking page.",
      colorPickerAria: "Pick brand color",
      presetsLabel: "Suggested colors",
      previewLabel: "Preview",
      previewButton: "Book Now",
      save: "Save color",
      saving: "Saving…",
      resetDefault: "Reset to default",
      errorInvalid: "Use a 6-digit hex like #D4AF37.",
      errorGeneric: "Could not save. Try again.",
      themeLabel: "Theme",
      themeDark: "Dark",
      themeLight: "Light",
      extract: {
        sectionLabel: "Extract from image URL",
        hint: "Or paste a direct link to your logo or brand image.",
        placeholder: "https://your-logo-or-image-url.com/image.jpg",
        extract: "Extract",
        extracting: "Analyzing…",
        apply: "Apply",
        errorInvalidUrl: "That URL doesn't look right. Use https://…",
        errorMissingKey: "Vision API not configured. Contact NailIQ support.",
        errorGeneric: "Couldn't analyze that image. Try a different URL.",
        matchYourBrand: "Match your brand",
        uploadLogo: "📷 Upload logo",
        uploadScreenshot: "🖥 Upload screenshot",
        extractedFromLogo: "Extracted from logo",
        extractedFromScreenshot: "Extracted from screenshot",
        applyColor: "Apply color",
        tryAnother: "Try another",
        colorExtractionFailed:
          "Couldn't read a brand color from that image. Try a higher-contrast logo.",
      },
    },
  },
  serviceCategory: {
    manicure: "Manicure",
    pedicure: "Pedicure",
    acrylic: "Acrylic",
    gel: "Gel",
    dip: "Dip Powder",
    waxing: "Waxing",
    other: "Other",
    pickerLabel: "Category",
  },
  serviceForm: {
    descriptionLabel: "Description",
    descriptionPlaceholder: "e.g. Long-lasting shine, perfectly shaped nails.",
    descriptionHint:
      "One line shown under the service name on your booking page. Leave blank and we'll write one for you.",
    descriptionTooLong: "Keep the description to 100 characters or fewer.",
    popularLabel: "Popular",
    popularHint:
      "Shows a small gold badge on the public booking page — pick your busiest 1–3 services.",
    characterCount: "{used}/{max}",
    descriptionGeneratedToast: "✨ Description generated",
  },
  setupErrors: {
    serviceInUse:
      "Service is used in active bookings. Cancel or complete those bookings before deleting.",
    staffHasBookings:
      "Staff has upcoming bookings. Reassign or cancel before deleting.",
    staffCannotPerformService:
      "This staff member is not set up to perform that service.",
    staffLimitReached: "Free plan allows 3 staff. Upgrade to Pro for 10.",
    serviceLimitReached:
      "Free plan allows 10 services. Upgrade to Pro for 50.",
    upgradeCta: "Upgrade your plan",
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
      toggleShort: "Queue",
      closePanel: "Close queue panel",
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
      waitHeroSuffix: "waiting",
      vipAria: "VIP customer",
      readyAroundShort: "Ready ~{time}",
      requestedByClientLine: "Customer requested this staff",
      overloadBanner: ({ name, queueAhead }) =>
        `⚠️ ${name} — ${queueAhead} customer${queueAhead === 1 ? "" : "s"} waiting. Consider another staff.`,
      overloadBannerDismiss: "Dismiss",
      softHoldButton: "Hold seat",
      softHoldClear: "Customer returned",
      softHoldLabel: "Hold",
      softHoldCountdown: (n: number) => `${n} min left`,
      softHoldExpiredNotice: "{name}'s hold expired",
      waitLinkButton: "Send wait link",
      waitLinkModal: {
        title: "Customer wait link",
        instruction:
          "Show this QR to {name} or copy the link to send via SMS.",
        copyLink: "Copy link",
        copied: "Copied!",
        openLink: "Open link",
        closeAria: "Close",
      },
      addForm: {
        namePlaceholder: "Guest name",
        phonePlaceholder: PHONE_INPUT_PLACEHOLDER_NANP,
        notePlaceholder:
          "Note for staff — e.g. polish color, prefers window seat",
        addButton: "Add customer",
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
        staffRequestedByClient: "Customer requested this staff",
        returningCustomer: "Returning customer",
        newCustomer: "New customer",
        returningCustomerHeader: "Returning customer",
        vipBadge: "VIP",
        profileSummary: "{count} visits · {total} total",
        lastVisitLine: "Last visit: {date}",
        usualServiceLine: "Usual: {service}",
        favoriteStaffPrefix: "Often with {name}",
        favoriteStaffLine: "Often with {name}",
        notesLabel: "Note",
        lookupLoading: "Looking up…",
        lookupLoadingAria: "Searching customer history",
        requestedStaffLabel: "Requested staff",
        bestMatchOption: "Best Match (auto)",
        bestMatchRecommendation: "Best Match: {name} — {wait}",
        readyNow: "Ready now",
        waitMinutesShort: (n: number) => `~${n} min wait`,
        readyAroundTime: "Ready around {time}",
        assignImmediately: "Assign immediately",
        waitForStaff: "Wait for {name}",
        pickAnotherStaff: "Other staff",
        heavyLoad: "Heavy load",
        heavyLoadDetail: "Est. wait: 45+ min",
        availabilityHeader: "Availability",
        availabilityChecking: "Checking availability…",
        queueAheadHint: (n: number) =>
          `${n} ${n === 1 ? "customer" : "customers"} ahead`,
        confidenceMedium: "Running slightly over schedule",
        confidenceLow: "Multiple delays — wait may grow",
        autoPickNoStaffAvailable:
          "No staff available right now. Please select a staff member manually.",
        subLabelAssignNow: "→ Assign now to {name}",
        subLabelQueue: "→ Add to waiting list",
        subLabelAssignTo: "→ Assign to {name}",
        relative: {
          justNow: "Just now",
          today: "Today",
          daysAgo: (n: number) => `${n} day${n === 1 ? "" : "s"} ago`,
          weeksAgo: (n: number) => `${n} week${n === 1 ? "" : "s"} ago`,
          monthsAgo: (n: number) => `${n} month${n === 1 ? "" : "s"} ago`,
        },
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
        staffRequest: "Staff request",
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
    rushHour: {
      bannerLabel: "⚡ Rush Hour — {n} customers waiting",
      dismiss: "Dismiss",
    },
    editAddon: {
      label: "Add-on",
      none: "None",
      add: "Add extra service",
      remove: "Remove add-on",
    },
    auditLog: {
      sectionTitle: "Audit log",
      sectionIntro: "Last 50 booking changes for this salon. Owner-only.",
      loading: "Loading recent events…",
      empty: "No booking events yet.",
      unknownGuest: "guest",
      errors: {
        unauthorized: "Sign in is required.",
        forbidden: "Only the salon owner can view the audit log.",
        server_error: "Could not load the audit log. Try again shortly.",
      },
      actorRoles: {
        owner: "Owner",
        senior: "Senior",
        nail_tech: "Nail tech",
        manager: "Manager",
        trainee: "Trainee",
        viewer: "Viewer",
        accounting: "Accounting",
        public_guest: "Guest",
        demo_cookie: "Demo",
        system: "System",
      },
      summaries: {
        booking_created: "Created booking for {name}",
        booking_edited: "Edited booking for {name}",
        booking_cancelled: "Cancelled booking for {name}",
        booking_status_changed: "Status for {name}: {from} → {to}",
        walkin_added: "Added {name} to walk-in queue",
        addon_added: "Added an add-on to {name}'s booking",
      },
    },
    errorBoundary: {
      title: "Something went wrong at the desk",
      message:
        "The Receptionist Center hit an unexpected error. Try again, and tell the salon owner if it keeps happening.",
      retryButton: "Try again",
    },
    viewMode: {
      day: "Day",
      week: "Week",
      ariaLabel: "View mode",
    },
    weekView: {
      title: "Week",
      prevWeek: "Prev",
      thisWeek: "This week",
      nextWeek: "Next",
      loading: "Loading…",
      dayError: "Could not load this day.",
      emptyDay: "No bookings",
      bookingCount: "{n} bookings",
      moreCount: "+{n} more",
      openDayAria: "Open day view for {date}",
    },
    clientProfiles: {
      pageTitle: "Clients",
      sectionTitle: "Recent clients",
      sectionIntro:
        "Last 50 clients sorted by their most recent visit. Search by name or phone.",
      searchPlaceholder: "Search clients…",
      loading: "Loading clients…",
      empty: "No clients yet.",
      unknownName: "(unnamed)",
      vipBadge: "VIP",
      summaryLine: "{visits} visits · last {lastVisit}",
      totalSpent: "Total spent",
      email: "Email",
      notes: "Notes",
      noNotes: "No notes yet.",
      vipLabel: "VIP",
      vipHint:
        "VIP applies across salons (this client appears as VIP for any tenant).",
      errors: {
        unauthorized: "Sign in is required.",
        forbidden:
          "Only the salon owner or senior receptionist can view clients.",
        server_error: "Could not load clients. Try again shortly.",
      },
      vipUpdateErrors: {
        unauthorized: "Sign in is required.",
        forbidden: "Only the salon owner can change VIP status.",
        not_found: "Client profile not found.",
        server_error: "Could not save. Try again shortly.",
      },
    },
    pricing: {
      sectionTitle: "Subscription",
      sectionIntro:
        "Choose the plan that fits your salon. Upgrade or change anytime.",
      currentBadge: "Current",
      perMonth: "/ month",
      unlimited: "Unlimited",
      featureMaxStaff: "Up to {n} staff",
      featureMaxServices: "Up to {n} services",
      featureReports: "Owner reports",
      featureAuditLog: "Audit log",
      upgrade: "Upgrade",
      manageSubscription: "Manage subscription",
      upgradedToast: "Subscription updated. Welcome aboard!",
      planBadgePro: "Pro",
      planBadgePremium: "Premium",
      planNames: {
        free: "Free",
        pro: "Pro",
        premium: "Premium",
      },
      errors: {
        unauthorized: "Sign in is required.",
        forbidden: "Only the salon owner can change the subscription.",
        invalid_plan: "That plan is not available.",
        no_stripe_client: "Billing is not configured. Contact support.",
        server_error: "Could not start checkout. Try again shortly.",
      },
      portalErrors: {
        unauthorized: "Sign in is required.",
        forbidden: "Only the salon owner can manage billing.",
        no_customer: "No active subscription to manage.",
        no_stripe_client: "Billing is not configured. Contact support.",
        server_error: "Could not open the billing portal. Try again shortly.",
      },
    },
    reports: {
      pageTitle: "Reports",
      navLinkLabel: "Reports",
      loading: "Loading reports…",
      rangeAriaLabel: "Date range",
      range: {
        today: "Today",
        week: "This week",
        month: "This month",
      },
      kpis: {
        totalRevenue: "Total revenue",
        appointments: "Appointments",
        completed: "Completed",
        cancelled: "Cancelled",
        noShow: "No-show",
      },
      tables: {
        topServices: "Top services",
        topStaff: "Top staff",
        empty: "No data in this range yet.",
        serviceCol: "Service",
        staffCol: "Staff",
        countCol: "Count",
        appointmentsCol: "Appointments",
        revenueCol: "Revenue",
      },
      busyHours: {
        title: "Busy hours",
        empty: "No bookings in this range.",
        totalBookings: "{n} bookings",
      },
      errors: {
        unauthorized: "Sign in is required.",
        forbidden: "Only the salon owner can view reports.",
        server_error: "Could not load reports. Try again shortly.",
      },
    },
  },
};
