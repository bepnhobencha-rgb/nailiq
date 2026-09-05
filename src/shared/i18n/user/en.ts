/**
 * User-facing copy (home shell + owner dashboard): English (default).
 */
import { PHONE_INPUT_PLACEHOLDER_NANP } from "@/shared/lib/phoneFormat";
import { REGISTER_INVALID_PHONE_HINT_EN } from "@/shared/register/phone";
import { formatPublicMonthlyPrice } from "@/shared/subscriptions/pricingCatalog";

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
    landingH1Gold: string;
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
    /** B3 (QA 2026-05-13) — email-path variant of `returningOwnerHint`.
     *  The phone-based hint reads as misleading on the magic-link
     *  screen (no phone field). This key swaps the noun for "email"
     *  so the hint still tells returning owners they can use the
     *  same flow to sign in. */
    returningOwnerEmailHint: string;
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
    /** P0.1 — localized fallback for SMS-send failures. The server
     * action returns the raw English string from Twilio; client
     * swaps it in when the raw matches. */
    sendSmsFailed: string;
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
    /** Post-signup confirmation page (`/register/success`). */
    success: {
      title: string;
      subtext: string;
      /** Rendered when `?adjusted=1` — the requested slug was taken and we
       *  reserved a different one. `{slug}` is substituted client-side. */
      slugAdjusted: string;
      callout: string;
      salonOwnerLabel: string;
      goToDashboard: string;
      dashboardHint: string;
      bookingLinkLabel: string;
      copyLink: string;
      copied: string;
      testBookingNow: string;
      homeBookmarkPrefix: string;
      homeBookmarkLinkText: string;
      homeBookmarkSuffix: string;
    };
  };
  /** Marketing landing page (`/`) — Founder Pilot positioning
   *  (multi-POS, Done-For-You salon setup). Wired through
   *  `useUserLanguage` so the EN/VI toggle in the nav actually
   *  re-renders the page content.
   *
   *  Restructured for the Founder Pilot launch: legacy keys
   *  (`pain`, `features`, `pricing.plans[]`, `trustStrip.pipeda`
   *  etc.) removed to keep i18n honest about what the page shows. */
  landing: {
    nav: {
      signIn: string;
      /** Primary nav CTA — now "Apply for Founder Pilot" (was "Try free"). */
      tryFree: string;
      langAriaLabel: string;
      openMenu: string;
      closeMenu: string;
    };
    hero: {
      eyebrow: string;
      h1Line1: string;
      h1Gold: string;
      subline: string;
      /** "Keep your current POS." trust line under the subline. */
      posSupport: string;
      /** "We set it up. We train your team. You stay focused on your clients." */
      valueStatement: string;
      ctaPrimary: string;
      ctaSecondary: string;
      microtrust: string;
    };
    problem: {
      eyebrow: string;
      h2: string;
      items: ReadonlyArray<string>;
      conclusion: string;
    };
    doneForYou: {
      eyebrow: string;
      h2: string;
      items: ReadonlyArray<{
        title: string;
        body: string;
        bullets: ReadonlyArray<string>;
      }>;
    };
    keepPos: {
      eyebrow: string;
      h2: string;
      intro: string;
      square: { title: string; body: string };
      other: { title: string; body: string };
      custom: { title: string; body: string };
      trustNote: string;
      /** Renders below the three cards to note POS names are shown as text (no logos). */
      logoNote: string;
    };
    howItWorks: {
      eyebrow: string;
      h2: string;
      step1: { title: string; body: string; list: ReadonlyArray<string> };
      step2: { title: string; body: string; list: ReadonlyArray<string> };
      step3: { title: string; body: string; list: ReadonlyArray<string> };
      step4: { title: string; body: string; list: ReadonlyArray<string> };
      timelineNote: string;
      bottomCta: string;
    };
    pricing: {
      eyebrow: string;
      h2: string;
      sub: string;
      perMonthLabel: string;
      setupLabel: string;
      plusLabel: string;
      /** Two Founder Pilot cards. Monthly + Annual. Included list is
       *  intentionally identical between them — different price shape,
       *  same service scope. */
      monthly: {
        name: string;
        setupPrice: string;
        monthlyPrice: string;
        commitment: string;
        included: ReadonlyArray<string>;
        cta: string;
        commitmentNote: string;
      };
      annual: {
        name: string;
        badge: string;
        price: string;
        description: string;
        included: ReadonlyArray<string>;
        cta: string;
        savingsLine: string;
      };
    };
    posScope: {
      eyebrow: string;
      h2: string;
      intro: string;
      includedTitle: string;
      includedItems: ReadonlyArray<string>;
      supportedTitle: string;
      supportedItems: ReadonlyArray<string>;
      notIncludedTitle: string;
      notIncludedItems: ReadonlyArray<string>;
      closing: string;
    };
    clearScope: {
      eyebrow: string;
      h2: string;
      notIncludedTitle: string;
      items: ReadonlyArray<string>;
      closing: string;
      supportPricingTitle: string;
      supportPricing: string;
    };
    smsFairUse: {
      eyebrow: string;
      h2: string;
      included: string;
      explanations: ReadonlyArray<string>;
    };
    paymentDisclaimer: {
      eyebrow: string;
      title: string;
      body: string;
      squareNote: string;
    };
    whyJoin: {
      eyebrow: string;
      h2: string;
      items: ReadonlyArray<string>;
      renewalNotice: string;
    };
    faq: {
      eyebrow: string;
      h2: string;
      sub: string;
      items: ReadonlyArray<{ q: string; a: string }>;
      footerText: string;
      footerCta: string;
    };
    trustStrip: {
      designed: string;
      keepPos: string;
      bilingual: string;
      made: string;
    };
    /** /contact page — extended with optional POS + package preference
     *  fields for the Founder Pilot apply/demo flow. Fields are optional;
     *  when set, they are serialized into the outbound email so we keep
     *  a single delivery pipeline (Resend → team inbox, no DB migration). */
    contact: {
      pageTitle: string;
      lede: string;
      /** Intent banners — rendered when `?intent=pilot|demo` is in the URL. */
      intentPilot: string;
      intentDemo: string;
      formHeading: string;
      nameLabel: string;
      namePlaceholder: string;
      emailLabel: string;
      emailPlaceholder: string;
      salonLabel: string;
      salonPlaceholder: string;
      posLabel: string;
      posOptions: {
        square: string;
        clover: string;
        toast: string;
        other: string;
        none: string;
      };
      posOtherLabel: string;
      posOtherPlaceholder: string;
      planLabel: string;
      planOptions: {
        monthly: string;
        annual: string;
        unsure: string;
      };
      messageLabel: string;
      messagePlaceholder: string;
      submit: string;
      submitting: string;
      successHeading: string;
      successBody: string;
      sendAnother: string;
      errors: {
        nameRequired: string;
        emailRequired: string;
        emailInvalid: string;
        messageRequired: string;
        rateLimited: string;
        serverError: string;
      };
      demoHeading: string;
      demoBody: string;
      demoCta: string;
      directEmailHeading: string;
      directEmailBody: string;
      backToHome: string;
    };
    finalCta: {
      eyebrow: string;
      h2: string;
      body: string;
      supportingLine: string;
      ctaPrimary: string;
      ctaSecondary: string;
      trustNote: string;
      finalLegalNote: string;
    };
    footer: {
      about: string;
      security: string;
      privacy: string;
      terms: string;
      contact: string;
      builtIn: string;
      followUs: string;
      instagramAriaLabel: string;
      tiktokAriaLabel: string;
    };
  };
  /** Dashboard app-shell navigation (sidebar + mobile bottom bar). */
  nav: {
    frontDesk: string;
    pulse: string;
    calendar: string;
    clients: string;
    services: string;
    staff: string;
    walkinQueue: string;
    noShowProtection: string;
    photos: string;
    combos: string;
    reviews: string;
    messages: string;
    reports: string;
    marketing: string;
    settings: string;
    /** Quick-action button at the bottom of the nav rail. */
    quickAddWalkin: string;
    loyalty: string;
    /** Static placeholder badge for the disabled Messages row. */
    messagesSoonBadge: string;
    collapseSidebar: string;
    expandSidebar: string;
    /** Aria label on the bottom-tab `<nav>`. */
    primaryNav: string;
    /** Sidebar footer trigger + dropdown header for the salon switcher
     * (rendered only when the owner has > 1 owner-memberships). */
    switchSalon: string;
    /** Card Disputes nav item (owner/admin only). */
    disputes: string;
    /** Activity / communications log nav item (owner only). */
    activity: string;
    /** Minh approval requests nav item (owner/admin only). */
    approvals: string;
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
    /** Banner shown when redirected with ?notice=confirm-email (email not yet confirmed). */
    confirmEmailNotice: string;
    pkceRestart: string;
    sessionError: string;
    /** Forgot password link on /login form. */
    forgotPasswordLink: string;
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
    /** Shown when the server-action fetch itself fails (Safari "Load failed" / Chrome "Failed to fetch"). */
    errorNetwork: string;
  };
  /** Shared auth surfaces (login + register social buttons). Public booking is unaffected. */
  auth: {
    /** Page title for the unified sign-in/sign-up screen on /register. */
    signInOrSignUpTitle: string;
    signInOrSignUpSubtext: string;
    /** OR divider in social buttons block. */
    orDivider: string;
    continueWithGoogle: string;
    /** Helper line under the Google button (open layout). */
    googleHelperText: string;
    /** Label above the email section in open layout. */
    emailSectionLabel: string;
    /** Registration-specific label above the email section. */
    emailSignupSectionLabel: string;
    /** Magic-link fallback link shown below the password form. */
    forgotPasswordLinkText: string;
    /** Toggle reveals magic-link form (legacy "compact" layout). */
    otherOptions: string;
    /** Toggle when magic-link form is open (legacy "compact" layout). */
    hideOptions: string;
    /** Submit button on /login (mode="login"). */
    sendLoginLink: string;
    /** Submit button on /register (mode="register"). */
    sendSignupLink: string;
    emailLabel: string;
    emailPlaceholder: string;
    emailInvalid: string;
    emailRequired: string;
    magicLinkSent: string;
    /** Generic Google sign-in failure copy. */
    googleSigninFailed: string;
    /** Generic magic-link send failure copy. */
    magicLinkSendFailed: string;
    /** Password section (collapsible under the magic-link button). */
    passwordLabel: string;
    passwordPlaceholder: string;
    passwordTooShort: string;
    passwordRequired: string;
    /** Password strength indicator labels. */
    passwordStrengthWeak: string;
    passwordStrengthMedium: string;
    passwordStrengthStrong: string;
    passwordRequirements: string;
    signInButton: string;
    signUpButton: string;
    /** Secondary sign-in action on the registration page. */
    existingAccountSignInButton: string;
    signingIn: string;
    signingUp: string;
    showPasswordToggle: string;
    hidePasswordToggle: string;
    signInFailed: string;
    signUpFailed: string;
    /** Shown when signUp is called but the email is already registered. */
    accountExists: string;
    /** Sign-up + email confirmation enabled: ask the user to check inbox. */
    signUpConfirmEmailTitle: string;
    /** {email} placeholder is substituted client-side. */
    signUpConfirmEmailBody: string;
    /** Magic-link confirmation screen (shared title/body). */
    magicLinkSentTitle: string;
    magicLinkSentBody: string;
    /** "Use a different email" button on confirmation screen. */
    useDifferentEmail: string;
    /** Top-left back link rendered by `RegisterStepShell` on every auth
     *  surface (/register, /register/setup, /login, /login/verify,
     *  /register/success). Includes the leading arrow glyph. */
    backHome: string;
    /** Trial reminder shown on /register below the auth form title. */
    registerMicrotrust: string;
    /** Forgot password page and flow. */
    forgotPasswordPageTitle: string;
    forgotPasswordPageSubtitle: string;
    forgotPasswordSubmit: string;
    forgotPasswordSubmitting: string;
    forgotPasswordSentTitle: string;
    forgotPasswordSentBody: string;
    forgotPasswordBackToSignIn: string;
    /** Reset password page. */
    resetPasswordPageTitle: string;
    resetPasswordNewPassword: string;
    resetPasswordConfirmPassword: string;
    resetPasswordSubmit: string;
    resetPasswordSubmitting: string;
    resetPasswordSuccess: string;
    resetPasswordMismatch: string;
    resetPasswordInvalidLink: string;
    resetPasswordServerError: string;
    resetPasswordStrengthHint: string;
    /** Desktop brand panel (left column on /login and /register entry). */
    brandTagline: string;
    brandBullet1: string;
    brandBullet2: string;
    brandBullet3: string;
    /** Shown in place of the Google button when the page is opened inside an
     *  in-app browser (Messenger, Instagram, etc.) where Google OAuth is blocked. */
    inAppBrowserWarning: string;
    /** CTA button label inside the in-app browser banner. */
    openInBrowser: string;
  };
  /** Multi-salon picker (`/choose-salon`). Shown when an authenticated user
   * has more than one `salon_members` row. Single-salon users skip it. */
  chooseSalon: {
    title: string;
    subtitle: string;
    signOut: string;
    roleBadge: {
      owner: string;
      admin: string;
      senior: string;
      nail_tech: string;
      receptionist: string;
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
    emptySetup: {
      title: string;
      subtitle: string;
    };
    emptyShare: {
      readyTitle: string;
      readySubtitle: string;
      copyButton: string;
      copiedButton: string;
      openButton: string;
      qrButton: string;
      qrModalTitle: string;
    };
    /** WOW home dashboard — kpis, sparkline, leaderboards. */
    home: {
      today: string;
      todaySubtitle: string;
      totalBookings: string;
      confirmed: string;
      completed: string;
      revenue: string;
      noShows: string;
      staffNowTitle: string;
      staffBusy: string;
      staffAvailable: string;
      staffNone: string;
      businessSummary: string;
      businessDetails: string;
      vsLastWeek: string;
      monthTitle: string;
      last30Days: string;
      /** `{n}` = booking count. */
      monthBookings: string;
      topServicesTitle: string;
      topServicesEmpty: string;
      /** `{n}` = count. */
      bookingsCount: string;
      staffTitle: string;
      staffEmpty: string;
      /** `{n}` = count. */
      appointments: string;
      healthTitle: string;
      newClients: string;
      clientsServed: string;
      noShowRate: string;
      thisMonth: string;
      thisWeek: string;
      tomorrowTitle: string;
      /** `{n}` = count. */
      tomorrowAppointments: string;
      tomorrowRevenue: string;
      tomorrowEmpty: string;
      minhTitle: string;
      /** `{n}` = count. */
      minhPendingApprovals: string;
      minhViewAll: string;
      /** Past appointments the desk never marked complete / no-show. */
      unclosedTitle: string;
      /** {n} = how many are waiting to be closed out. */
      unclosedSubtitle: string;
      /** {n} = how many more beyond the listed rows. */
      unclosedMore: string;
      bookingLink: string;
      refresh: string;
      openReceptionistCenter: string;
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
    /** 💕 badge — group/couple asked to be seated together. */
    seatTogether: string;
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
    sectionAiManager: string;
    sectionPromotions: string;
    /** Collapsible category headers that group the settings panels. */
    categories: {
      brand: { title: string; subtitle: string };
      booking: { title: string; subtitle: string };
      notifications: { title: string; subtitle: string };
      integrations: { title: string; subtitle: string };
      plan: { title: string; subtitle: string };
      jumpLabel: string;
    };
    /** Owner/admin email alerts for booking events. */
    ownerNotifications: {
      title: string;
      subtitle: string;
      loading: string;
      enabledLabel: string;
      recipientsHeading: string;
      notifyMembersLabel: string;
      customEmailsLabel: string;
      customEmailsPlaceholder: string;
      customEmailsHint: string;
      eventsHeading: string;
      eventLabels: {
        new: string;
        reschedule: string;
        cancel: string;
        no_show: string;
      };
      save: string;
      saved: string;
      saveError: string;
      sendTest: string;
      /** "{n}" = recipient count. */
      testSent: string;
      testErrorNotEnabled: string;
      testErrorNoRecipients: string;
      testErrorNoResend: string;
      testErrorGeneric: string;
    };
    /** Customer-notification defaults for STAFF actions (create/reschedule/cancel). */
    staffNotifications: {
      title: string;
      subtitle: string;
      loading: string;
      enabledLabel: string;
      channelsHeading: string;
      smsLabel: string;
      emailLabel: string;
      eventsHeading: string;
      eventsHint: string;
      eventLabels: { create: string; reschedule: string; cancel: string };
      languageHeading: string;
      languageHint: string;
      langEn: string;
      langVi: string;
      save: string;
      saved: string;
      saveError: string;
    };
    /** Recovery-email verification status block (Settings hub). */
    emailVerification: {
      sectionTitle: string;
      description: string;
      noEmailHint: string;
      verifiedBadge: string;
      pendingBadge: string;
      pendingHint: string;
      verifiedToast: string;
      verifyErrorPrefix: string;
      changeButton: string;
      cancelButton: string;
      saveButton: string;
      saving: string;
      resendButton: string;
      resendSent: string;
      saveSuccess: string;
      saveError: string;
      invalidEmail: string;
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
      /** P1.13 — header on the collapsible "Advanced" subsection that
       * hides the less-common toggles. Stays collapsed by default
       * so the owner only sees the high-frequency switches up top. */
      advancedSectionTitle: string;
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
    /** Salon logo shown on the public booking header. */
    salonLogo: {
      sectionTitle: string;
      intro: string;
      uploadCta: string;
      replaceCta: string;
      uploading: string;
      remove: string;
      removing: string;
      previewAlt: string;
      empty: string;
      hint: string;
      errorTooLarge: string;
      errorInvalidType: string;
      errorGeneric: string;
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
    /** Walk-in auto-assign toggle (PR #107). */
    walkinAutoAssign: {
      sectionTitle: string;
      toggleLabel: string;
      descriptionOn: string;
      descriptionOff: string;
      errorGeneric: string;
    };
    /** Queue display mode toggle (salons.queue_display_mode). */
    queueDisplayMode: {
      sectionTitle: string;
      labelFull: string;
      labelSimple: string;
      descriptionFull: string;
      descriptionSimple: string;
      errorGeneric: string;
    };
    /** SMS OTP phone verification toggle. */
    phoneOtp: {
      sectionTitle: string;
      toggleLabel: string;
      descriptionOn: string;
      descriptionOff: string;
      cost: string;
      errorGeneric: string;
    };
    /** Automated appointment reminders (email/SMS) settings card. */
    reminders: {
      autoTitle: string;
      autoHint: string;
      advancedToggle: string;
      email24h: string;
      email3h: string;
      sms3h: string;
      save: string;
      saving: string;
      saved: string;
    };
    /** Google review link settings card. */
    googleReview: {
      instruction: string;
      saveError: string;
      save: string;
      saving: string;
      saved: string;
    };
    /** Booking verification level selector. */
    bookingVerify: {
      title: string;
      subtitle: string;
      saveError: string;
      saved: string;
      neverLabel: string;
      neverHint: string;
      autoLabel: string;
      autoHint: string;
      otpLabel: string;
      otpHint: string;
      depositLabel: string;
      depositHint: string;
      depositThenOtpLabel: string;
      depositThenOtpHint: string;
    };
    /** Voice-AI settings save controls. */
    voiceAiSave: {
      saveError: string;
      save: string;
      saving: string;
      saved: string;
      invalidName: string;
      forbidden: string;
    };
  };
  /** Aria label for the setup-wizard category dropdown.
   *
   *  Display names for every category — booking surface, setup
   *  panel, SuperAdmin — now come from `service_categories.name_en`
   *  / `name_vi` via `loadServiceCategories()` (see
   *  `src/shared/booking/loadServiceCategories.ts`). The historical
   *  per-slug entries here (`manicure`, `pedicure`, `acrylic`,
   *  `gel`, `dip` / `dip_powder`, `waxing`, `other`) were already
   *  dead by the time the DB-driven loader landed; the table also
   *  carries `nail_art`, `removal`, `spa`, `kids` which were never
   *  added to this object. Verified zero call sites against
   *  `src/` before deleting. `pickerLabel` is the single
   *  remaining consumer (`ServicesSetupPanel.tsx`). */
  serviceCategory: {
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
    /** P1.1 — per-row Save button label. Unified explicit save replaces
     * the prior on-blur autosaves; the row now batches changes and
     * commits them in a single server call when this button is tapped. */
    saveButton: string;
    /** Pricing-model selector (fixed / from / range) on the service row. */
    priceTypeLabel: string;
    priceTypeFixed: string;
    priceTypeFrom: string;
    priceTypeRange: string;
    /** Short "From" prefix shown before a from-price value. */
    priceFromShort: string;
    /** Min/max inputs for the range pricing model. */
    priceMinLabel: string;
    priceMaxLabel: string;
    /** Validation error when max <= min in range mode. */
    priceValidation: string;
    /** Add/edit modal titles + cancel control. */
    addTitle: string;
    editTitle: string;
    cancel: string;
  };
  /** Setup CRUD error strings (services, etc.) */
  setupErrors: {
    serviceInUse: string;
    staffHasBookings: string;
    /** Shown when deactivating a staff who still has open/upcoming appointments. */
    staffHasUpcoming: string;
    staffCannotPerformService: string;
    /** Hit when free-plan owner tries to add another staff past the limit. */
    staffLimitReached: string;
    /** Hit when free-plan owner tries to add another service past the limit. */
    serviceLimitReached: string;
    /** CTA copy on the inline upgrade link. */
    upgradeCta: string;
  };
  /** P0.1 — shared labels across the four setup pages.
   * services, staff, hours, address all consume from this single
   * namespace so a label change ripples cleanly. */
  setupLabels: {
    name: string;
    save: string;
    saveAll: string;
    delete: string;
    cancel: string;
    servicesTitle: string;
    price: string;
    durationMin: string;
    bufferMin: string;
    deleteService: string;
    editService: string;
    addService: string;
    serviceSaved: string;
    serviceRemoved: string;
    saveFailed: string;
    deleteFailed: string;
    staffTitle: string;
    removeStaff: string;
    editStaff: string;
    addStaff: string;
    staffSaved: string;
    staffRemoved: string;
    hoursTitle: string;
    /** Day names indexed Mon..Sun for HoursSetupPanel. */
    days: {
      mon: string;
      tue: string;
      wed: string;
      thu: string;
      fri: string;
      sat: string;
      sun: string;
    };
    opens: string;
    closes: string;
    closed: string;
    extraClosedDates: string;
    hoursPreview: string;
    hoursSaved: string;
    hoursIntro: string;
    /** Default-hours row label and hint shown above the per-day overrides. */
    hoursDefaultLabel: string;
    hoursDefaultHint: string;
    /** Badge shown on a day row that still follows the default. */
    hoursFollowingDefault: string;
    /** CTA to break a day out of the default and set custom times. */
    hoursCustomize: string;
    /** Inline link to reset a customised day back to the default. */
    hoursResetToDefault: string;
    /** Section label for a day that has been individually customised. */
    hoursOverrideLabel: string;
    /** Closure banner shown on the public booking page (e.g. "closed for renovation"). */
    closureNoticeTitle: string;
    closureNoticeHint: string;
    closureNoticeEnLabel: string;
    closureNoticeViLabel: string;
    addressTitle: string;
    streetAddress: string;
    city: string;
    provinceState: string;
    postalCode: string;
    country: string;
    salonPhone: string;
    addressSaved: string;
    descriptionLabel: string;
    /** Task #04-B — required IANA-timezone picker in the address
     *  setup page. `timezone` is the dropdown label; `timezoneRequired`
     *  is the inline validation error when the field is blank or
     *  holds an unsupported value. */
    timezone: string;
    timezoneRequired: string;
    /** Search-filter placeholders on the services / staff setup lists. */
    searchServices: string;
    searchStaff: string;
    saveConnectionFailed: string;
    removeFailed: string;
    updateRowFailed: string;
    invalidName: string;
    minStaffRequired: string;
    minServiceRequired: string;
    removed: string;
    undo: string;
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
    /** P1.8 — localized job-role names for the role dropdown.
     * Replaces the previously hardcoded English `ROLE_OPTIONS`. */
    roleLabel: string;
    roleOptions: {
      owner: string;
      senior: string;
      nail_tech: string;
    };
  };
  /** AI Prefill Setup Wizard — import services from menu photo */
  aiPrefill: {
    /** Banner shown on Services page when list is empty */
    bannerTitle: string;
    bannerSubtitle: string;
    bannerCta: string;
    /** Step 1: pick input method */
    step1Title: string;
    uploadCard: string;
    uploadCardSub: string;
    urlCard: string;
    urlCardSub: string;
    manualCard: string;
    manualCardSub: string;
    urlPlaceholder: string;
    analyzeButton: string;
    /** Step 2: AI processing */
    processingTitle: string;
    processingSub: string;
    /** Step 3: review */
    reviewTitle: string;
    reviewSub: string;
    selectAll: string;
    deselectAll: string;
    priceLabel: string;
    durationLabel: string;
    importButton: string;
    importButtonN: string;
    manualFallback: string;
    /** Error messages */
    errorVisionFailed: string;
    errorNoServices: string;
    errorPlanLimit: string;
    errorPayloadTooLarge: string;
    errorInvalidUrl: string;
    /** Success */
    successToast: string;
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
    dateNavigator: {
      chooseDate: string;
      previous: { day: string; week: string; month: string };
      next: { day: string; week: string; month: string };
      current: { day: string; week: string; month: string };
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
    /** DRC color theme picker. */
    themePicker: {
      title: string;
      saved: string;
      saving: string;
      customLabel: string;
      applyButton: string;
      resetButton: string;
      openAria: string;
      colorPickerTitle: string;
      presets: {
        fire_red: { label: string; desc: string };
        fire_orange: { label: string; desc: string };
        metal_gold: { label: string; desc: string };
        wood_green: { label: string; desc: string };
        water_blue: { label: string; desc: string };
        water_purple: { label: string; desc: string };
        earth_brown: { label: string; desc: string };
        nailiq_gold: { label: string; desc: string };
      };
      bgTitle: string;
      bgReset: string;
      bgPresets: {
        charcoal: string;
        navy: string;
        teal: string;
        forest: string;
        purple: string;
        crimson: string;
      };
    };
    /** Basic Mode — Front Desk Cockpit (per-device view toggle). */
    basicMode: {
      toggle: string;
      toggleOnAria: string;
      toggleOffAria: string;
      /** Page title shown in Basic Mode header. */
      pageTitle: string;
      nextActionHeading: string;
      aiSuggestionHeading: string;
      aiAllClear: string;
      aiReasons: {
        overdue: string;
        online_waitlist: string;
        not_started: string;
        long_wait: string;
        no_staff_for_waiting: string;
        sms_failed: string;
        party_change: string;
        setup_incomplete: string;
        finish_overdue: string;
        assign_waiting: string;
        prepare_next: string;
        party_pending: string;
        suggest_walkin: string;
        all_clear: string;
      };
      alertsHeading: string;
      moreIssues: (n: number) => string;
      // Next Action texts
      longWaitGuest: (n: number) => string;
      finishOverdue: (n: number) => string;
      assignWaiting: (n: number) => string;
      assignWaitingNamed: (name: string) => string;
      prepareNext: (n: number) => string;
      partyPendingNamed: (time: string, name: string) => string;
      partyPendingCount: (time: string, n: number) => string;
      suggestWalkin: (name: string) => string;
      // Action button labels
      actionOpenQueue: string;
      actionOpenWaitlist: string;
      actionAddWalkin: string;
      actionOpenParty: string;
      actionOpenBooking: string;
      // Critical alert texts
      alertOverdue: (n: number) => string;
      alertOnlineWaitlist: (n: number, minutes: number) => string;
      alertOverdueNamed: (name: string, time: string) => string;
      alertNotStarted: (n: number) => string;
      alertNotStartedNamed: (name: string, time: string) => string;
      alertLongWait: (n: number) => string;
      alertNoStaffForWaiting: string;
      alertSmsFailed: (n: number) => string;
      alertSetupIncomplete: string;
      // Now Bar
      nowAvailableStaff: string;
      nowNoOneWaiting: string;
      nowNoStaffAvailable: string;
      /** Now Bar "Upcoming" tile label (simpler than KPI "Coming up (30m)"). */
      nowUpcoming: string;
      /** Hover title clarifying the upcoming window. */
      nowUpcomingTitle: string;
    };
    dailyBrief: {
      eyebrow: string;
      title: string;
      closingEyebrow: string;
      closingTitle: string;
      bookings: string;
      vip: string;
      staffReady: string;
      waiting: string;
      remaining: string;
      inService: string;
      completed: string;
      readyToClose: string;
      workRemaining: (count: number) => string;
      dayWindow: (start: string, end: string) => string;
      riskGuests: (count: number) => string;
      calmDay: string;
      collapse: string;
      expand: string;
    };
    /** Party Card strip labels (shared across Basic/Balanced/Advanced). */
    partyCard: {
      panelSummary: (n: number) => string;
      panelEmpty: string;
      emptyNext7: string;
      refresh: string;
      arriveTogether: string;
      finishTogether: string;
      changesRequested: (n: number) => string;
      wavesBadge: (n: number) => string;
      confirmedProgress: (claimed: number, total: number) => string;
      pendingSuffix: (n: number) => string;
      /** Hover help explaining what "pending/not confirmed" means. */
      pendingHelp: string;
      slotsCount: (n: number) => string;
      waveLabel: (n: number) => string;
      copyLink: string;
      copied: string;
      statusConfirmed: string;
      statusPending: string;
      statusExpired: string;
      /** Receptionist quick-claim: fill in a guest's name on their behalf. */
      claimOnBehalf: string;
      claimNameLabel: string;
      claimNamePlaceholder: string;
      claimPhoneLabel: string;
      claimPhonePlaceholder: string;
      claimSave: string;
      claimCancel: string;
      claimError: string;
      /** Cancel-whole-group action (owner/senior only). */
      cancelParty: string;
      cancelConfirm: (n: number) => string;
      cancelConfirmYes: string;
      cancelConfirmNo: string;
      cancelling: string;
      cancelError: string;
      /** Notify-the-organizer toggles shown in the cancel confirm box. */
      notifyLabel: string;
      notifySms: string;
      notifyEmail: string;
      cancelFeeLoading: string;
      cancelFeeDecision: (amount: string) => string;
      cancelFeeNoCharge: string;
      cancelFeeReview: string;
      cancelFeeWaive: string;
      cancelFeeNotApplicable: string;
      cancelSmsDisabled: string;
      cancelFeeQueued: (amount: string) => string;
      cancelFeeWaivedSuccess: string;
      cancelNotificationQueued: (sms: boolean, email: boolean) => string;
      cancelSuccess: (n: number, fee: string, notification: string) => string;
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
      /** "Updated {time}" — last successful server sync, shown while stale. */
      lastUpdated: (time: string) => string;
      /** One-click reload button in the disconnect banner. */
      reload: string;
    };
    /** Hint shown next to top-bar icon when Web Audio is locked by autoplay policy. */
    soundUnlockHint: string;
    /** Display label for a redacted/removed customer (raw name was "[removed]"). */
    removedGuest: string;
    /** Top KPI band (gated by `dashboard_modules.kpi_bar`); revenue tile gated by `revenue_today`. */
    kpiBar: {
      waiting: string;
      avgWait: string;
      avgWaitEmpty: string;
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
      sortCustom: string;
      avgWait: (n: number) => string;
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
      overloadBanner: (input: { name: string; queueAhead: number }) => string;
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
      contact: {
        openDetails: (name: string) => string;
        missingBadge: string;
        reachableBadge: string;
        steppedOutBadge: string;
        title: string;
        stepOutTitle: string;
        description: string;
        stepOutDescription: string;
        close: string;
        phone: string;
        email: string;
        phonePlaceholder: string;
        emailPlaceholder: string;
        noContact: string;
        stepOutContactRequired: string;
        contactReady: string;
        smsConsentYes: string;
        smsConsentNo: string;
        consentTruth: string;
        invalidPhone: string;
        invalidEmail: string;
        save: string;
        saveAndHold: string;
        saving: string;
        call: string;
        copyPhone: string;
        copyEmail: string;
        copied: string;
        saveFailed: string;
      };
      /** Short CTA in the header bar to open the add-walk-in panel. */
      addWalkinCta: string;
      addForm: {
        namePlaceholder: string;
        phonePlaceholder: string;
        phoneOptionalHint: string;
        notePlaceholder: string;
        addButton: string;
        incompleteHint: string;
        moreServices: string;
        submitting: string;
        errorRequired: string;
        actualTimeLabel: string;
        actualTimeHint: string;
        actualTimeInvalid: string;
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
        moreDetails: string;
        hideDetails: string;
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
        /** Task #04-D FIX 16 — warning when receptionist picks a
         *  staff with a group booking starting within
         *  `WALKIN_GROUP_BUFFER_MS` (30 min). `{name}` is the staff
         *  display name, `{time}` is the localized clock time. */
        walkinConflictsGroup: string;
        /** Affordance: keeps the staff selection and proceeds. */
        walkinContinueAnyway: string;
        /** Affordance: clears the staff back to Best-Match auto. */
        walkinChooseDifferent: string;
        walkinSaved: string;
        walkinSavedAssignmentPending: string;
        walkinRetrySafe: string;
        relative: {
          justNow: string;
          today: string;
          daysAgo: (n: number) => string;
          weeksAgo: (n: number) => string;
          monthsAgo: (n: number) => string;
        };
      };
    };
    /** Online waitlist panel in the Receptionist Center (next to the walk-in
     *  queue). Staff see online customers waiting for a full slot and invite
     *  one in a single tap (texts them the claim link via SMS). Shared by the
     *  No-Show hub's waitlist section. */
    waitlist: {
      title: string;
      inviteNow: string;
      inviteAgain: string;
      /** Status pill — already invited. */
      invited: string;
      /** Status pill — still waiting. */
      statusWaiting: string;
      /** Complex group/sequence demand that needs a complete capacity plan. */
      needsPlan: string;
      autonomy: {
        autoSafe: string;
        approvalRequired: string;
        humanException: string;
        watchingForExactSlot: string;
        customerResponsePending: string;
        exactPlanRequired: string;
        bookingCommitPending: string;
        unsafeStateCombination: string;
        approvalLocked: string;
      };
      groupRequest: (partySize: number, serviceCount: number) => string;
      sequenceRequest: (serviceCount: number) => string;
      callToArrange: string;
      deliveryHeading: string;
      smsChannel: string;
      emailChannel: string;
      deliveryStatus: {
        sent: string;
        sending: string;
        failed: string;
        unknown: string;
        channelDisabled: string;
        recipientMissing: string;
        recipientSuppressed: string;
        unavailable: string;
      };
      deliveryResultToast: (
        name: string,
        deliveredBy: string,
        needsAttention: boolean,
      ) => string;
      deliveryPendingToast: (name: string) => string;
      deliveryFailedToast: (name: string) => string;
      /** Persistent elapsed time for an unresolved online lead. */
      waitingMinutes: (minutes: number) => string;
      /** Status pill — customer grabbed the freed slot. */
      claimed: string;
      /** Primary action on a claimed row — open the prefilled desk form. */
      createBooking: string;
      /** Compact empty state. */
      empty: string;
      /** Toasts. `{name}` is the customer's name. */
      invitedToast: (name: string) => string;
      suppressedToast: (name: string) => string;
      errorToast: string;
      openCustomerDetails: (name: string) => string;
      detailsTitle: string;
      detailsDescription: string;
      closeDetails: string;
      fullName: string;
      statusLabel: string;
      phoneLabel: string;
      emailLabel: string;
      serviceLabel: string;
      dateLabel: string;
      timeLabel: string;
      staffLabel: string;
      joinedAtLabel: string;
      waitingLabel: string;
      requestKindLabel: string;
      sourceLabel: string;
      anyTime: string;
      anyStaff: string;
      individualRequest: string;
      source: {
        slot_unavailable: string;
        booking_conflict: string;
      };
      callCustomer: string;
      copyPhone: string;
      copyEmail: string;
      phoneCopied: string;
      emailCopied: string;
      copyFailed: string;
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
      /** Label on the display-only closing-time marker at the right edge of the grid. */
      closingLabel: string;
      conflictShake: string;
      /** Toast shown when a drag-to-reschedule is rejected, keyed by reason. */
      rescheduleFailed: {
        past_date: string;
        outside_hours: string;
        slot_conflict: string;
        staff_cannot_perform_service: string;
        generic: string;
      };
      /** Accessible labels for the booking-block icon stack. */
      bookingIcon: {
        vip: string;
        notes: string;
        late: string;
        design: string;
        /** Heart icon shown when the booking has a non-empty
         * `staff_request_note` (e.g. "wants Tuong Vy"). */
        staffRequest: string;
        /** HeartHandshake icon shown when a group/couple asked to be
         * seated next to each other (adjacent beds + shared curtain). */
        seatTogether: string;
      };
    };
    undo: {
      undo: string;
      undoFailed: string;
      assignedPrefix: string;
      assignedMiddle: string;
      cancelledPrefix: string;
      cancelUndoFailed: string;
    };
    /** "Notify the customer?" panel + cancel-confirm copy. */
    notify: {
      heading: string;
      sms: string;
      email: string;
      previewTitle: string;
      willNotNotify: string;
      noPhone: string;
      noEmail: string;
      unavailable: string;
      langEn: string;
      langVi: string;
      cancelTitle: string;
      cancelDesc: string;
      confirmCancel: string;
      keep: string;
      /** Group-aware cancel: shown when the booking is one member of a party. */
      groupBanner: (n: number) => string;
      cancelThisOne: string;
      cancelWholeParty: (n: number) => string;
      confirmCancelGroup: (n: number) => string;
      groupFeeLoading: string;
      groupFeeLoadFailed: string;
      groupFeeRetry: string;
      groupFeeDecisionRequired: (amount: string) => string;
      groupFeeNoChargeToday: string;
      groupFeeReview: string;
      groupFeeWaive: string;
      groupFeeQueuedForReview: (amount: string) => string;
      groupFeeWaived: string;
      groupFeeNotApplicable: string;
      groupSmsDisabledWarning: string;
      groupNotificationQueued: (sms: boolean, email: boolean) => string;
      groupCancelSuccess: (n: number, fee: string, notification: string) => string;
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
      /** P0.8: phone-privacy block. Phone is masked by default
       * ("***-***-7890") with a toggle to reveal. Section heading,
       * toggle labels, and a short "Call" CTA that does not embed
       * the number in its label (the call still dials the real
       * number via `tel:`). */
      phoneSection: string;
      revealPhone: string;
      hidePhone: string;
      callGuestShort: string;
      startService: string;
      markComplete: string;
      cancelBooking: string;
      /** Wix-origin pending: approve (→ confirm on Wix) / decline (→ decline on Wix). */
      approveWix: string;
      declineWix: string;
      /** Mark a confirmed/in-progress booking as a no-show (customer didn't attend). */
      noShow: string;
      /** Pending / confirmed: open inline edit form */
      editBooking: string;
      restoreBooking: string;
      cancelConfirm: (clientName: string) => string;
      restoreConfirm: (clientName: string) => string;
      restoreConflict: string;
      restorePast: string;
      none: string;
      scheduleSection: string;
      statusSection: string;
      priceSection: string;
      noNotesHint: string;
      /** Heading for the optional add-on service row in the booking drawer. */
      sectionAddon: string;
      /** Party/group composition section. */
      groupSectionTitle: (n: number) => string;
      groupOrganizedBy: (name: string) => string;
      groupOrganizerBadge: string;
      groupSeatTogether: string;
      viewPartyCard?: string;
    };
    edit: {
      /** Section heading when editing from the drawer */
      modeTitle: string;
      /** Date picker label (edit form supports changing the day). */
      dateLabel: string;
      timeLabel: string;
      /** Spinner copy while the availability grid loads. */
      slotsLoading: string;
      /** Empty state when no open times exist for the chosen day. */
      noSlots: string;
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
      pastDateMessage: string;
      outsideHoursMessage: string;
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
      invalid_actual_time: string;
      actual_time_too_old: string;
      actual_time_in_future: string;
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
      monthly_booking_limit_reached: string;
      feature_not_enabled: string;
      invalid_recovery: string;
      invalid_recovery_source: string;
      already_recovered: string;
      immutable_terminal_state: string;
      external_calendar_not_supported: string;
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
        /** P0.9 — operational event summaries (no booking-status
         * transition; the action itself is the verb). Receptionist
         * mostly cares about queue lifecycle. */
        queue_joined: string;
        queue_assigned: string;
        queue_left: string;
        soft_hold_set: string;
        soft_hold_expired: string;
      };
      /** P0.9 — localized booking status names. Used by the audit log
       * viewer to render `booking_status_changed` rows in human
       * terms ("Confirmed → In progress" rather than the raw
       * `confirmed → in_progress` codes). */
      statusNames: Partial<Record<string, string>>;
      /** P0.9 — transition-specific phrasing, indexed by
       * `${from}_to_${to}`. When a key matches, the summary uses
       * this phrase instead of the generic "X → Y" template; falls
       * back to `booking_status_changed` for unknown transitions. */
      statusTransitions: Partial<Record<string, string>>;
    };
    /** Top-level error boundary fallback for the Receptionist Center. */
    errorBoundary: {
      title: string;
      message: string;
      retryButton: string;
    };
    /** Day/Week/Month view toggle in the top bar. */
    viewMode: {
      day: string;
      week: string;
      month: string;
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
      /** Aria label for a clickable booking card. `{client}` = client name. */
      openBookingAria: string;
    };
    /** Read-only month-overview calendar grid. */
    monthView: {
      title: string;
      prevMonth: string;
      thisMonth: string;
      nextMonth: string;
      loading: string;
      dayError: string;
      emptyDay: string;
      /** "{n} bookings" — count badge per day. */
      bookingCount: string;
      /** "+{n} more" — overflow indicator. */
      moreCount: string;
      /** Aria label for a clickable booking card. `{client}` = client name. */
      openBookingAria: string;
      // ── Day-detail split panel ──────────────────────────────────────────────
      /** Close button label/aria for the day-detail panel. */
      closeDayPanel: string;
      /** Button that switches from month view to full day view. */
      openDayView: string;
      /** Empty state inside the day-detail panel. */
      panelEmpty: string;
      /** Loading state inside the day-detail panel. */
      panelLoading: string;
      /** Status labels used by booking chips in the day-detail panel. */
      statusNames: Partial<Record<string, string>>;
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
      /** "{visits} visit(s) · last {lastVisit}" — collapsed-row summary. */
      summaryLine: (visits: number, lastVisit: string) => string;
      /** Segment filter chips + per-card status badges. */
      segments: {
        all: string;
        vip: string;
        new: string;
        regular: string;
        atRisk: string;
      };
      /** "{n} of {total}" footer when results are filtered/paginated. */
      countLabel: (shown: number, total: number) => string;
      loadMore: string;
      /** Total directory count label — e.g. "9,496 clients". */
      totalCountLabel: (total: number) => string;
      /** Pagination: "Page X of Y". */
      pageLabel: (page: number, totalPages: number) => string;
      prevPage: string;
      nextPage: string;
      /** Shown when an imported-only client has no bookings yet. */
      noVisitsYet: string;
      /** Compact stat labels on the card. */
      statVisits: string;
      statSpent: string;
      statLastVisit: string;
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
      /** View-mode toggle labels. */
      viewModes: {
        cards: string;
        list: string;
        details: string;
      };
      /** Column header labels for the "details" table view. */
      tableColumns: {
        name: string;
        phone: string;
        visits: string;
        lastVisit: string;
        spent: string;
        vip: string;
      };
      /** Customer 360 full-profile drawer. */
      profile360: {
        title: string;
        close: string;
        loading: string;
        error: string;
        /** Hero KPIs */
        lifetimeSpent: string;
        visits: string;
        avgTicket: string;
        lastVisit: string;
        clientSince: (date: string) => string;
        /** AI summary card */
        aiSummaryTitle: string;
        aiGenerating: string;
        aiNextAction: string;
        bookAgain: string;
        /** Reliability */
        reliabilityTitle: string;
        completed: string;
        noShow: string;
        cancelled: string;
        noShowRate: (pct: number) => string;
        /** Favorites & pattern */
        favoritesTitle: string;
        topService: string;
        topStaff: string;
        patternTitle: string;
        usualPattern: (weekday: string, hour: number, days: number) => string;
        nextPredicted: string;
        /** Preferences */
        preferencesTitle: string;
        allergiesWarning: string;
        favoriteColors: string;
        favoriteStyles: string;
        language: string;
        commChannel: string;
        consentsTitle: string;
        consentSms: string;
        consentEmail: string;
        consentAi: string;
        /** Money */
        moneyTitle: string;
        loyaltyStamps: string;
        loyaltyRewards: string;
        activeVouchers: string;
        expiresOn: (date: string) => string;
        /** Timeline */
        timelineTitle: string;
        upcomingTitle: string;
        showMore: string;
        /** Engagement */
        reviewsTitle: string;
        notificationsTitle: string;
        aiEngagementTitle: string;
        chatCount: string;
        voiceCount: string;
        lastInteraction: string;
        /** Footer actions */
        actionBookAgain: string;
        actionMessage: string;
        actionEdit: string;
        actionClose: string;
        /** Weekday names (Sun=0) */
        weekdays: [string, string, string, string, string, string, string];
        /** Channel icon labels */
        channelOnline: string;
        channelWalkin: string;
        channelVoice: string;
        channelDesk: string;
        /** Status labels */
        statusCompleted: string;
        statusCancelled: string;
        statusNoShow: string;
        statusConfirmed: string;
        statusInProgress: string;
        /** In-app SMS composer */
        composePlaceholder: string;
        composeSend: string;
        composeCancel: string;
        composeCharCount: (used: number, max: number) => string;
        composeSent: string;
        composeSentSuppressed: string;
        composeError: (msg: string) => string;
        /** AI card — regenerate button */
        regenerateSummary: string;
        /** Rebook-invite message template — parameters are optional, omitted when null */
        rebookInviteTemplate: (opts: {
          firstName: string;
          service: string | null;
          staff: string | null;
          bookingUrl: string;
        }) => string;
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
        phase_2_not_available: string;
        no_stripe_client: string;
        server_error: string;
      };
      portalErrors: {
        unauthorized: string;
        forbidden: string;
        no_customer: string;
        phase_2_not_available: string;
        no_stripe_client: string;
        server_error: string;
      };
    };
    /** Reports & analytics page (`/dashboard/[slug]/insights`). */
    reports: {
      pageTitle: string;
      navLinkLabel: string;
      loading: string;
      estimatedValueNotice: string;
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
        /** "Bookings by source" section heading. */
        bySource: string;
        empty: string;
        serviceCol: string;
        staffCol: string;
        /** "Source" column header in the by-source table. */
        sourceCol: string;
        countCol: string;
        appointmentsCol: string;
        /** "Share" (% of bookings) column header. */
        shareCol: string;
        revenueCol: string;
      };
      /** Display labels for each booking origin channel. */
      channelLabels: {
        online: string;
        square: string;
        wix: string;
        voice: string;
        walkin: string;
        desk: string;
      };
      busyHours: {
        title: string;
        empty: string;
        /** "{n} bookings in range" */
        totalBookings: string;
      };
      /** Studio-tier per-staff performance drill-down. Pro/Free
       *  salons see the upsell card instead of the table. */
      staffPerformance: {
        title: string;
        empty: string;
        upsellTitle: string;
        upsellBody: string;
        upsellCta: string;
        col: {
          staff: string;
          appointments: string;
          completion: string;
          cancellation: string;
          noShow: string;
          revenue: string;
          repeatClients: string;
          topServices: string;
        };
      };
      errors: {
        unauthorized: string;
        forbidden: string;
        server_error: string;
        feature_not_enabled: string;
      };
    };
    /** Free-tier monthly booking-cap upsell banner. Rendered at the top
     *  of Receptionist Center when usage is ≥ 80% of cap. */
    bookingLimitBanner: {
      warningTitle: string;
      blockingTitle: string;
      /** Uses `{used}` and `{cap}` placeholders. */
      usageText: string;
      upgradeCta: string;
      manageCtaSettings: string;
      upgradeError: string;
    };
    /** No-show fee charge/waive modal (shown when booking has a card on file). */
    noShowFeeModal: {
      title: string;
      desc: (amount: string) => string;
      charge: (amount: string) => string;
      chargeFailed: string;
      waive: string;
      cancel: string;
    };
    /** Reversible attendance decision. Money is outside NailIQ V1. */
    noShowSafety: {
      title: string;
      desc: (name: string) => string;
      groupOnly: string;
      confirm: string;
      keep: string;
      pending: string;
      pendingDetail: string;
      finalizeFailed: string;
    };
    /** Grid lateness/tombstone labels. */
    latenessGrid: {
      /** Inline Start button aria-label and visible label. */
      startShort: string;
      /** "No-show review due at {time}" when automatic review is ON. */
      autoNoShowAt: (time: string) => string;
      /** Badge label when auto is OFF and tier=late. */
      late: string;
      /** Badge label when auto is OFF and tier=critical. */
      veryLate: string;
      /** Persisted candidate flag requiring a human decision. */
      noShowDecisionNeeded: string;
      /** Tombstone aria-label template. */
      tombstoneAria: (clientName: string) => string;
      /** Tombstone popover: undo action label. */
      tombstoneUndo: string;
      /** Tombstone popover: charge action. */
      tombstoneCharge: (amount: string) => string;
      /** Tombstone popover: waive fee. */
      tombstoneWaive: string;
      /** Tombstone status: "Charged {amount}". */
      tombstoneCharged: (amount: string) => string;
      /** Tombstone status: "Waived". */
      tombstoneWaived: string;
      /** Tombstone status: charge failed. */
      tombstoneFailed: string;
      /** Tombstone status: "Unpaid {amount} — tap to charge". */
      tombstoneUnpaid: (amount: string) => string;
      /** Tombstone status: "No-show" (no card). */
      tombstoneNoCard: string;
    };
  };
  /** Shown when a NailIQ booking is blocked because the Wix-connected
   *  staff resource already has an overlapping active booking on Wix
   *  (created within the 2-minute polling window). */
  wixSlotTaken: string;
  /** `/dashboard/[slug]/disputes` — Card Disputes report (owner/admin only). */
  disputes: {
    /** Page <h1> + sidebar nav label. */
    pageTitle: string;
    /** One-line intro under the heading. */
    intro: string;
    /** Nav label (sidebar). */
    navLabel: string;
    /** Alert when needsResponse > 0. {n} = count. */
    needsResponseAlert: (n: number) => string;
    /** Empty state (good news). */
    emptyTitle: string;
    emptyBody: string;
    /** Loading / error states. */
    loading: string;
    errorGeneric: string;
    /** Status pill labels. */
    status: {
      needs_response: string;
      under_review: string;
      won: string;
      lost: string;
      warning_needs_response: string;
      warning_closed: string;
    };
    /** Evidence-due countdown. {n} = days remaining. */
    evidenceDueIn: (n: number) => string;
    evidenceOverdue: string;
    /** Evidence bundle section headings. */
    evidenceTitle: string;
    evidenceLoading: string;
    evidenceError: string;
    sectionConsent: string;
    sectionCharge: string;
    sectionBooking: string;
    sectionCustomer: string;
    sectionNoShow: string;
    sectionNotifications: string;
    /** No consent warning. */
    noConsentWarning: string;
    /** Field labels inside the evidence bundle. */
    fields: {
      consentAt: string;
      chargeAmount: string;
      paymentRef: string;
      service: string;
      staff: string;
      time: string;
      bookingStatus: string;
      price: string;
      clientName: string;
      phone: string;
      email: string;
      visitCount: string;
      noShowAt: string;
      noShowBy: string;
      notifType: string;
      notifChannel: string;
      notifStatus: string;
      notifSentAt: string;
    };
    /** "Copy evidence bundle" button. */
    copyEvidence: string;
    copiedEvidence: string;
    /** Provider badge. */
    providerStripe: string;
    providerSquare: string;
    /** Column/row labels in the list. */
    labelClient: string;
    labelAmount: string;
    labelReason: string;
    labelStatus: string;
    labelOpened: string;
    labelEvidenceDue: string;
    noInfo: string;
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
    landingUrgency: "⚠️ Most salons lose $50–$200 every day from missed calls",
    landingH1Gold: "built for nail salons.",
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
    landingClosingSub: "If you don’t start today, you’ll keep losing them.",
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
    returningOwnerHint: "Returning owner? Enter your number to sign back in.",
    returningOwnerEmailHint:
      "Returning owner? Enter your email to sign back in.",
    welcomeBackAfterSend:
      "Welcome back! Enter the code to access your dashboard.",
    welcomeBackVerifySubtext:
      "Welcome back! Enter the code to access your dashboard.",
    newDemoOtpBadgeNote: "DEMO MODE · OTP appears below.",
    demoBadgeReturning: "Returning",
    demoBadgeNew: "Demo mode",
    demoVerifyCaptionNew: "Use the code from the demo modal or server log.",
    otpResentToast: "New code sent — previous code is no longer valid.",
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
    slugHint: "Letters and numbers only. Edit if you want a shorter URL.",
    slugAriaLabel: "Booking URL slug",
    timezoneLabel: "Time zone",
    timezoneHint:
      "We use this to show booking times correctly to you and your guests.",
    submitCreate: "Create your booking page",
    submitCreating: "Creating…",
    submitErrorGeneric: "Could not create your salon. Try again.",
    sendSmsFailed: "Could not send SMS. Try again.",
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
    emailAuthSubtext: "We'll send you a secure sign-in link — no code to type.",
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
    success: {
      title: "Salon created!",
      subtext: "Complete a quick setup to activate your booking page.",
      slugAdjusted:
        "Your first-choice URL was taken, so we reserved {slug} for you.",
      callout:
        "Coco asks one clear question at a time, checks all 15 capabilities, and shows only the next action.",
      salonOwnerLabel: "Salon owner",
      goToDashboard: "Start Coco Setup →",
      dashboardHint: "You can leave anytime; Coco resumes at the right step when you return.",
      bookingLinkLabel: "Public booking link",
      copyLink: "Copy link",
      copied: "Copied",
      testBookingNow: "Test booking now",
      homeBookmarkPrefix: "Home later? Bookmark ",
      homeBookmarkLinkText: "NailIQ home",
      homeBookmarkSuffix: ".",
    },
  },
  landing: {
    nav: {
      signIn: "Sign in",
      tryFree: "Start free trial",
      langAriaLabel: "Language",
      openMenu: "Open menu",
      closeMenu: "Close menu",
    },
    hero: {
      eyebrow: "14 DAYS FREE · NO CREDIT CARD",
      h1Line1: "Take Bookings 24/7 and Run Your Nail Salon —",
      h1Gold: "Without the Busywork",
      subline:
        "NailIQ gives your salon online booking, staff scheduling and a live front desk in one simple place.",
      posSupport:
        "Keep your current POS. NailIQ can work alongside Square, Clover, Toast or another payment system.",
      valueStatement:
        "Start on your own in minutes, or ask our team to set it up for you.",
      ctaPrimary: "Start Your Free Trial",
      ctaSecondary: "Watch a Free Demo",
      microtrust:
        "Ready in about 2 minutes · Keep your existing POS · English and Vietnamese support",
    },
    problem: {
      eyebrow: "Why NailIQ",
      h2: "Technology Should Save You Time — Not Create More Work",
      items: [
        "Too many phone calls to book or reschedule appointments.",
        "Staff schedules change frequently and are hard to keep in sync.",
        "Services, prices and durations are difficult to keep organized.",
        "Generic booking tools still require owners to configure everything themselves.",
        "Website, booking and salon operations often feel disconnected.",
        "Owners may already have a POS but still need a better booking workflow.",
        "Busy salon owners do not have time to manage complicated software.",
      ],
      conclusion:
        "NailIQ provides both the platform and the implementation support needed to get your salon running without forcing you to replace your current POS.",
    },
    doneForYou: {
      eyebrow: "What’s Included",
      h2: "More Than Software — A Done-For-You Salon Setup",
      items: [
        {
          title: "Branded Website",
          body: "A professional online presence that reflects your salon.",
          bullets: [
            "Template-based website with up to five pages",
            "Mobile-friendly design",
            "Services, contact information and booking access",
            "One language",
            "Up to two consolidated revision rounds",
          ],
        },
        {
          title: "Online Booking",
          body: "A booking flow your clients can complete on any phone.",
          bullets: [
            "Services, prices and durations",
            "Booking policies",
            "Customer booking flow",
            "OTP verification when enabled",
            "Booking dashboard access",
          ],
        },
        {
          title: "Staff and Scheduling",
          body: "Staff, skills and availability configured on your behalf.",
          bullets: [
            "Staff profiles",
            "Skills and eligible services",
            "Working hours",
            "Breaks",
            "Days off",
            "Booking availability",
          ],
        },
        {
          title: "POS-Compatible Workflow",
          body: "Keep the payment system your salon already runs.",
          bullets: [
            "Continue using the salon’s current POS",
            "NailIQ manages website, booking and salon scheduling",
            "Payments may continue through Square, Clover, Toast or another POS",
            "V1 does not synchronize external calendars, Square Loyalty or Square Gift Card balances and transactions",
          ],
        },
        {
          title: "Square Setup Assistance",
          body: "Where eligible, we help configure the V1 payment handoff while Square remains the independent money, Loyalty and Gift Card system.",
          bullets: [
            "Connect one eligible existing Square account where supported",
            "Square payment and hardware handoff guidance",
            "Square Loyalty stays directly in Square",
            "Square Gift Cards stay directly in Square",
            "No Square Loyalty or Gift Card synchronization in V1",
            "Subject to Square eligibility and technical availability",
          ],
        },
        {
          title: "Training and Launch",
          body: "A guided go-live so your team is ready on day one.",
          bullets: [
            "One 60-minute online training session",
            "Guided test booking",
            "Up to 90 minutes of remote go-live support",
          ],
        },
        {
          title: "Ongoing Support",
          body: "Small updates and Vietnamese-friendly support included.",
          bullets: [
            "Vietnamese-friendly support",
            "Up to 30 minutes of small updates per month",
            "Additional work available after written approval and quote",
          ],
        },
      ],
    },
    keepPos: {
      eyebrow: "Multi-POS",
      h2: "Keep the POS You Already Use",
      intro:
        "NailIQ does not require your salon to replace its current POS system.",
      square: {
        title: "Square Connection Support",
        body: "Eligible Square users may receive payment-handoff guidance. NailIQ V1 does not synchronize Square Loyalty or Square Gift Card balances and transactions; salons continue operating those products directly in Square.",
      },
      other: {
        title: "Use NailIQ Alongside Your Existing POS",
        body: "Salons using Clover, Toast or another POS can still use NailIQ for their website, online booking, staff schedules, booking policies, OTP and salon operations while continuing to process payments through their current POS.",
      },
      custom: {
        title: "Need a Direct Integration?",
        body: "Direct synchronization with Clover, Toast or another POS is not included in the Founder Pilot. It requires technical review, API availability, platform permissions, partner approval where required and separate pricing.",
      },
      trustNote:
        "No POS change is required to use NailIQ’s core website, booking and scheduling features.",
      logoNote:
        "POS provider names are shown as text. NailIQ is not affiliated with Square, Clover or Toast and does not display third-party logos without verified usage rights.",
    },
    howItWorks: {
      eyebrow: "Process",
      h2: "From Setup to Go-Live in Four Steps",
      step1: {
        title: "Share Your Salon Information",
        body: "You provide the details we need to configure NailIQ for your salon.",
        list: [
          "Logo",
          "Business information",
          "Services",
          "Prices",
          "Durations",
          "Staff",
          "Skills",
          "Working schedules",
          "Policies",
          "Current POS",
        ],
      },
      step2: {
        title: "We Configure NailIQ",
        body: "NailIQ builds and configures your salon workspace end-to-end.",
        list: [
          "Website",
          "Booking",
          "Staff schedules",
          "Booking policies",
          "OTP when enabled",
          "Supported POS workflow",
        ],
      },
      step3: {
        title: "Review and Test",
        body: "You review the setup and confirm everything works with your POS.",
        list: [
          "Review the website",
          "Review services and staff",
          "Complete an approved test booking",
          "Verify the dashboard",
          "Confirm how NailIQ works alongside the existing POS",
        ],
      },
      step4: {
        title: "Training and Go-Live",
        body: "We train your team and support the launch.",
        list: [
          "Train the salon owner or designated manager",
          "Support the planned go-live remotely",
          "Help address initial usage issues within the included scope",
        ],
      },
      timelineNote:
        "Typical setup takes approximately 7–14 business days after all required information, approvals and third-party access have been received.",
      bottomCta: "Apply for Founder Pilot",
    },
    pricing: {
      eyebrow: "Founder Pilot Pricing",
      h2: "Founder Pilot Pricing",
      sub: "Special introductory pricing for the first five participating salons.",
      perMonthLabel: "/month",
      setupLabel: "setup",
      plusLabel: "plus",
      monthly: {
        name: "Founder Pilot Monthly",
        setupPrice: "$499 CAD",
        monthlyPrice: "$99 CAD",
        commitment: "Minimum six-month commitment",
        included: [
          "One salon",
          "One location",
          "One brand",
          "Up to 10 staff members",
          "Up to 75 services",
          "One language",
          "Template-based website with up to 5 pages",
          "Up to two consolidated website revision rounds",
          "Online booking setup",
          "Staff schedules, breaks and days off",
          "Booking policies",
          "OTP setup when enabled",
          "Use NailIQ alongside the salon’s existing POS",
          "One eligible Square connection where supported",
          "Square payment and hardware handoff guidance",
          "Booking QR code",
          "One 60-minute online training session",
          "Up to 90 minutes remote go-live support",
          "Up to 30 minutes of small updates per month",
          "Up to 250 SMS segments per month under fair-use terms",
        ],
        cta: "Apply for Monthly Pilot",
        commitmentNote:
          "Minimum six-month total: $1,093 CAD before applicable taxes and third-party fees.",
      },
      annual: {
        name: "Founder Pilot Annual",
        badge: "BEST VALUE",
        price: "$1,399 CAD",
        description: "Setup and 12 months included",
        included: [
          "One salon",
          "One location",
          "One brand",
          "Up to 10 staff members",
          "Up to 75 services",
          "One language",
          "Template-based website with up to 5 pages",
          "Up to two consolidated website revision rounds",
          "Online booking setup",
          "Staff schedules, breaks and days off",
          "Booking policies",
          "OTP setup when enabled",
          "Use NailIQ alongside the salon’s existing POS",
          "One eligible Square connection where supported",
          "Square payment and hardware handoff guidance",
          "Booking QR code",
          "One 60-minute online training session",
          "Up to 90 minutes remote go-live support",
          "Up to 30 minutes of small updates per month",
          "Up to 250 SMS segments per month under fair-use terms",
        ],
        cta: "Apply for Annual Pilot",
        savingsLine:
          "Save $288 compared with paying the setup fee plus 12 monthly payments.",
      },
    },
    posScope: {
      eyebrow: "POS Compatibility",
      h2: "POS Compatibility",
      intro:
        "NailIQ’s core website, booking and scheduling features can be used alongside Square, Clover, Toast or other POS systems.",
      includedTitle: "Included for all eligible Founder Pilot salons",
      includedItems: [
        "NailIQ website",
        "NailIQ online booking",
        "NailIQ staff scheduling",
        "NailIQ booking policies",
        "NailIQ OTP where enabled",
        "Continued use of the salon’s current POS for payment processing",
      ],
      supportedTitle: "Included only where currently supported",
      supportedItems: [
        "One eligible Square account connection",
        "Selected Square setup assistance",
        "Square payment and hardware handoff guidance",
      ],
      notIncludedTitle: "Not included",
      notIncludedItems: [
        "Direct Clover synchronization",
        "Direct Toast synchronization",
        "Direct integration with another POS",
        "POS inventory synchronization",
        "POS payment synchronization",
        "POS order synchronization",
        "Google, Outlook or Wix Calendar synchronization",
        "Square Loyalty synchronization",
        "Square Gift Card synchronization",
        "POS data migration",
        "Custom connector development",
      ],
      closing:
        "Direct non-Square POS integrations require separate technical review, written scope approval and pricing.",
    },
    clearScope: {
      eyebrow: "Scope",
      h2: "Clear Pricing. No Hidden Promises.",
      notIncludedTitle: "Not included in Founder Pilot pricing",
      items: [
        "Domain registration",
        "Third-party hosting fees where applicable",
        "Square processing fees or hardware",
        "Clover processing fees or hardware",
        "Toast processing fees or hardware",
        "Fees charged by another POS provider",
        "Physical Gift Card printing",
        "Gift Card load or processing fees",
        "SMS usage above included limits",
        "SMS phone-number fees",
        "A2P, sender-registration or compliance fees",
        "Photography",
        "Video production",
        "Logo design",
        "Advanced image editing",
        "Advanced copywriting",
        "Translation",
        "Additional languages",
        "Advanced SEO",
        "Paid advertising",
        "Social media management",
        "Complex data migration",
        "Custom reports",
        "New software features",
        "New third-party integrations",
        "Direct Clover integration",
        "Direct Toast integration",
        "Other POS connector development",
        "Work beyond included support limits",
      ],
      closing:
        "Additional work is estimated, quoted and approved in writing before it begins.",
      supportPricingTitle: "Additional support",
      supportPricing:
        "Additional support starts at $95 CAD per hour with a 30-minute minimum. After the first 30 minutes, time may be billed in 15-minute increments.",
    },
    smsFairUse: {
      eyebrow: "SMS Included",
      h2: "SMS Fair Use",
      included: "Up to 250 SMS segments per month under fair-use terms.",
      explanations: [
        "One customer message may use multiple SMS segments.",
        "Message length, emoji, Unicode and special characters may increase segment usage.",
        "Additional usage may be billed separately.",
        "OTP or transactional consent does not automatically constitute marketing consent.",
      ],
    },
    paymentDisclaimer: {
      eyebrow: "Notice",
      title: "Payment Provider Notice",
      body: "Square, Clover, Toast and other POS or payment platforms are independent third-party service providers. Each salon maintains its own provider account and is responsible for provider fees, transactions, disputes, chargebacks, hardware, account approval and Gift Card obligations. NailIQ provides website, booking and technical setup assistance within its supported scope but does not hold salon funds, approve transactions or control third-party service availability.",
      squareNote:
        "NailIQ V1 does not synchronize Square Loyalty or Square Gift Card balances and transactions. Salons continue operating those products directly in Square.",
    },
    whyJoin: {
      eyebrow: "Founder Pilot Benefits",
      h2: "Why Join the Founder Pilot?",
      items: [
        "Founder pricing protected for the first 12 months",
        "Direct onboarding assistance",
        "Keep your existing POS",
        "Early access to selected workflow improvements",
        "Opportunity to provide product feedback",
        "Priority attention during the initial rollout",
        "Vietnamese-friendly support",
        "Limited to five salons to maintain onboarding quality",
      ],
      renewalNotice:
        "Renewal pricing after the first 12 months may change based on the current pricing schedule. Salons will receive at least 30 days’ written notice.",
    },
    faq: {
      eyebrow: "FAQ",
      h2: "Questions Salon Owners Ask",
      sub: "If your question isn't here, message us — we reply within one business day.",
      items: [
        {
          q: "Is NailIQ only booking software?",
          a: "No. NailIQ combines software with implementation support. We help configure the website, services, staff schedules, booking rules and currently supported integrations.",
        },
        {
          q: "Do I have to enter everything myself?",
          a: "No. The salon provides complete and accurate information, and NailIQ performs the initial configuration within the Founder Pilot scope.",
        },
        {
          q: "Do I need to replace my current POS?",
          a: "No. You may continue using Square, Clover, Toast or another POS for payments while using NailIQ for your website, booking, staff schedules and salon operations.",
        },
        {
          q: "Does NailIQ integrate with Clover?",
          a: "You can use NailIQ alongside Clover without replacing Clover. Direct Clover synchronization is not included in the Founder Pilot and requires a separate technical review and quote.",
        },
        {
          q: "Does NailIQ integrate with Toast?",
          a: "You can use NailIQ alongside Toast or another POS for booking and salon operations. Direct Toast synchronization is not included and may depend on platform access, technical feasibility and separate pricing.",
        },
        {
          q: "Does NailIQ replace Square?",
          a: "No. Square remains the salon’s independent payment provider. NailIQ may connect with supported Square features but does not replace Square or hold salon funds.",
        },
        {
          q: "What Square assistance is included?",
          a: "For eligible salons, NailIQ may provide payment and hardware handoff guidance for one supported Square account. Square remains the independent system for money, Loyalty and Gift Cards; NailIQ V1 does not synchronize Loyalty or Gift Card balances and transactions.",
        },
        {
          q: "Can NailIQ integrate with any POS?",
          a: "NailIQ’s core booking, website and scheduling features can operate alongside most POS systems. Direct data synchronization depends on the POS provider’s API, permissions, partner requirements and technical compatibility.",
        },
        {
          q: "Are SMS messages unlimited?",
          a: "No. Founder Pilot includes up to 250 SMS segments per month under fair-use terms. A message may use multiple segments depending on its length and characters. Additional usage may be billed separately.",
        },
        {
          q: "Can I request custom features?",
          a: "New features, custom reports and new integrations are outside the Founder Pilot scope and require separate review and pricing.",
        },
        {
          q: "How long does setup take?",
          a: "Typical setup takes approximately 7–14 business days after NailIQ receives all required salon information, approvals and third-party access.",
        },
        {
          q: "Can I cancel?",
          a: "The Monthly Pilot has a minimum six-month commitment. The Annual Pilot covers 12 months. The full service scope and terms are provided before enrollment.",
        },
        {
          q: "Does the package include a website?",
          a: "Yes. Founder Pilot includes a template-based website with up to five pages, one language and up to two consolidated revision rounds.",
        },
        {
          q: "Can NailIQ support multiple locations?",
          a: "Founder Pilot pricing covers one salon and one location. Multi-location businesses require a separate assessment and quote.",
        },
        {
          q: "Is tax included?",
          a: "Published prices are in Canadian dollars and exclude applicable taxes and third-party fees unless stated otherwise.",
        },
        {
          q: "What information does NailIQ need before setup begins?",
          a: "The salon must provide complete business information, services, prices, durations, staff details, schedules, policies, branding materials and relevant third-party access. The setup timeline begins after the required information has been received.",
        },
      ],
      footerText: "Still have questions?",
      footerCta: "Contact us →",
    },
    trustStrip: {
      designed: "Designed for nail salons",
      keepPos: "Keep your existing POS",
      bilingual: "Vietnamese-friendly support",
      made: "Made in Vancouver, BC 🇨🇦",
    },
    contact: {
      pageTitle: "Contact us",
      lede: "Based in Vancouver, BC, Canada. We aim to respond within one business day.",
      intentPilot:
        "Founder Pilot application. Tell us about your salon and current POS — we’ll follow up to schedule onboarding.",
      intentDemo:
        "Demo request. Share your salon details and preferred language — we’ll follow up to schedule a 15-minute screen-share.",
      formHeading: "Send us a message",
      nameLabel: "Your name",
      namePlaceholder: "Jane Nguyen",
      emailLabel: "Email",
      emailPlaceholder: "jane@yoursalon.com",
      salonLabel: "Salon name (optional)",
      salonPlaceholder: "Saigon Nail Studio",
      posLabel: "Current POS (optional)",
      posOptions: {
        square: "Square",
        clover: "Clover",
        toast: "Toast",
        other: "Other",
        none: "None",
      },
      posOtherLabel: "POS name",
      posOtherPlaceholder: "e.g. Boulevard, Vagaro…",
      planLabel: "Preferred option (optional)",
      planOptions: {
        monthly: "Monthly Pilot",
        annual: "Annual Pilot",
        unsure: "Not sure",
      },
      messageLabel: "Message",
      messagePlaceholder:
        "Tell us about your salon, current tools, and what you’d like NailIQ to help you set up…",
      submit: "Send message",
      submitting: "Sending…",
      successHeading: "Message sent",
      successBody:
        "Thanks — we've got it and will reply within one business day. Check your inbox (and spam folder) just in case.",
      sendAnother: "Send another",
      errors: {
        nameRequired: "Please enter your name.",
        emailRequired: "Please enter your email.",
        emailInvalid: "That email doesn't look valid.",
        messageRequired: "Please enter a message.",
        rateLimited:
          "Too many submissions from this network. Please try again in a few minutes.",
        serverError:
          "Something went wrong. Please try again or email hello@nailiq.ca directly.",
      },
      demoHeading: "Rather see it live?",
      demoBody:
        "Book a 15-minute screen-share with the founding team. We'll walk through booking, walk-in queue, and receptionist center on a real salon.",
      demoCta: "Book a 15-minute demo →",
      directEmailHeading: "Prefer email?",
      directEmailBody:
        "General: hello@nailiq.ca · Support: support@nailiq.ca · Privacy: privacy@nailiq.ca",
      backToHome: "← Back to home",
    },
    finalCta: {
      eyebrow: "Start today",
      h2: "Let Your Next Booking Happen While You Are Serving a Client",
      body: "Create your salon workspace in about two minutes. Explore NailIQ free for 14 days with no credit card.",
      supportingLine:
        "Keep your current POS. Let NailIQ handle your website, online booking and salon setup.",
      ctaPrimary: "Start Your Free Trial",
      ctaSecondary: "Book a Free Demo",
      trustNote: "No credit card required. Your salon data remains yours.",
      finalLegalNote: `The self-service plan is ${formatPublicMonthlyPrice("pro", { includeCurrency: true })} per month after the trial, plus applicable taxes. Optional setup services and direct POS integrations are quoted separately.`,
    },
    footer: {
      about: "About",
      security: "Security",
      privacy: "Privacy",
      terms: "Terms",
      contact: "Contact",
      builtIn: "Built in Vancouver, BC 🇨🇦",
      followUs: "Follow us",
      instagramAriaLabel: "NailIQ on Instagram",
      tiktokAriaLabel: "NailIQ on TikTok",
    },
  },
  nav: {
    frontDesk: "Live Board",
    pulse: "Pulse",
    calendar: "Calendar",
    clients: "Customers",
    services: "Services",
    staff: "Staff",
    walkinQueue: "Walk-in Queue",
    noShowProtection: "No-Show Protection",
    photos: "Photos",
    combos: "Bundles",
    reviews: "Reviews",
    messages: "Messages",
    reports: "Reports",
    marketing: "Marketing",
    settings: "Settings",
    quickAddWalkin: "+ Walk-in",
    messagesSoonBadge: "Soon",
    collapseSidebar: "Collapse sidebar",
    expandSidebar: "Expand sidebar",
    primaryNav: "Primary navigation",
    switchSalon: "Switch salon",
    loyalty: "Loyalty & Gifts",
    disputes: "Card Disputes",
    activity: "Activity",
    approvals: "Việc chờ duyệt",
  },
  login: {
    title: "Sign in",
    subtextSms: "We'll send you an OTP via SMS.",
    subtextDemo: "Demo mode shows the OTP on screen.",
    subtextEmail: "Sign in to your NailIQ account.",
    promptEnterPhone: "Enter the phone number registered to your salon.",
    sendCode: "Send code",
    sendingCode: "Sending…",
    noSalonPrefix: "No salon yet? ",
    signupLink: "Sign up",
    emailEntryTitle: "Welcome back",
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
    confirmEmailNotice:
      "Please confirm your email before continuing. Check your inbox for the confirmation link we sent you.",
    pkceRestart:
      "This sign-in link was opened in a different browser or has expired. Start sign-in again in this browser.",
    sessionError: "We couldn't complete sign-in. Please try again.",
    forgotPasswordLink: "Forgot password?",
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
    errorNetwork: "Connection lost — check your network and try again.",
  },
  auth: {
    signInOrSignUpTitle: "Get started with NailIQ",
    signInOrSignUpSubtext:
      "Free 14 days · No credit card required · Ready in 2 minutes",
    orDivider: "or",
    continueWithGoogle: "Continue with Google",
    googleHelperText: "Fastest · No password needed",
    emailSectionLabel: "Sign in with email",
    emailSignupSectionLabel: "Create an account with email",
    forgotPasswordLinkText: "Forgot password? Send a login link",
    otherOptions: "Other options",
    hideOptions: "Hide options",
    sendLoginLink: "Send login link",
    sendSignupLink: "Send login link",
    emailLabel: "Email address",
    emailPlaceholder: "you@example.com",
    emailInvalid: "Enter a valid email address.",
    emailRequired: "Enter your email above first.",
    magicLinkSent: "Magic link sent. Check your email to continue.",
    googleSigninFailed: "Google sign-in failed.",
    magicLinkSendFailed: "Could not send link. Try again.",
    passwordLabel: "Password",
    passwordPlaceholder: "Enter your password",
    passwordTooShort: "Password must be at least 8 characters.",
    passwordRequired: "Enter your password.",
    passwordStrengthWeak: "Weak",
    passwordStrengthMedium: "Medium",
    passwordStrengthStrong: "Strong",
    passwordRequirements: "8+ characters, 1 uppercase, 1 number recommended",
    signInButton: "Sign in",
    signUpButton: "Sign up",
    existingAccountSignInButton: "Already have an account? Sign in",
    signingIn: "Signing in…",
    signingUp: "Creating account…",
    showPasswordToggle: "Sign in with email & password",
    hidePasswordToggle: "Send a login link instead",
    signInFailed: "Email or password is incorrect. Please try again.",
    signUpFailed: "Could not create your account. Please try again.",
    accountExists: "This email is already registered. Try signing in instead.",
    signUpConfirmEmailTitle: "Confirm your email",
    signUpConfirmEmailBody:
      "We sent a confirmation link to {email}. Click it to activate your account.",
    magicLinkSentTitle: "Check your inbox",
    magicLinkSentBody:
      "We sent a sign-in link to {email}. Click it to continue — the link expires in 60 minutes.",
    useDifferentEmail: "Use a different email",
    backHome: "← Home",
    registerMicrotrust: "14-day free trial · No credit card required",
    forgotPasswordPageTitle: "Reset your password",
    forgotPasswordPageSubtitle:
      "Enter your email address and we'll send you a link to reset your password.",
    forgotPasswordSubmit: "Send reset link",
    forgotPasswordSubmitting: "Sending…",
    forgotPasswordSentTitle: "Check your inbox",
    forgotPasswordSentBody:
      "If an account exists with that email, we've sent a password reset link. Links expire in one hour.",
    forgotPasswordBackToSignIn: "Back to sign in",
    resetPasswordPageTitle: "Create a new password",
    resetPasswordNewPassword: "New password",
    resetPasswordConfirmPassword: "Confirm password",
    resetPasswordSubmit: "Set new password",
    resetPasswordSubmitting: "Setting password…",
    resetPasswordSuccess:
      "Password reset successfully. Redirecting to sign in…",
    resetPasswordMismatch: "Passwords don't match.",
    resetPasswordInvalidLink: "This reset link has expired. Request a new one.",
    resetPasswordServerError: "Something went wrong. Try again.",
    resetPasswordStrengthHint: "Password strength: ",
    brandTagline: "Smart salon management — built for you",
    brandBullet1: "Free 14 days · No credit card needed",
    brandBullet2: "Up and running in under 2 minutes",
    brandBullet3: "Made for Vietnamese-owned salons in North America",
    inAppBrowserWarning:
      "Google sign-in is blocked inside Messenger and other in-app browsers. Open this page in Safari or Chrome to continue.",
    openInBrowser: "Open in browser",
  },
  chooseSalon: {
    title: "Choose your salon",
    subtitle: "Select which salon to manage",
    signOut: "Sign out",
    roleBadge: {
      owner: "Owner",
      admin: "Admin",
      senior: "Senior",
      nail_tech: "Nail Tech",
      receptionist: "Receptionist",
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
      socialProof: "3 salons lost access this week from missing recovery email",
      ctaAdd: "Add email",
      ctaLater: "Maybe later",
      successMessage: "✓ Email saved! You're protected.",
    },
    emptySetup: {
      title: "Set up your salon",
      subtitle: "Complete these steps to start accepting bookings",
    },
    emptyShare: {
      readyTitle: "Your booking page is live!",
      readySubtitle:
        "Share your booking link with customers to receive your first booking",
      copyButton: "Copy link",
      copiedButton: "Copied!",
      openButton: "Open page",
      qrButton: "QR Code",
      qrModalTitle: "Booking QR Code",
    },
    home: {
      today: "Today",
      todaySubtitle: "At a glance",
      totalBookings: "Total Bookings",
      confirmed: "Confirmed",
      completed: "Completed",
      revenue: "Revenue",
      noShows: "No-shows",
      staffNowTitle: "Staff right now",
      staffBusy: "Busy",
      staffAvailable: "Available",
      staffNone: "No active staff yet",
      businessSummary: "Business details",
      businessDetails:
        "Open revenue trends, services, staff performance, and customer health",
      vsLastWeek: "vs last week",
      monthTitle: "This Month",
      last30Days: "Last 30 days",
      monthBookings: "{n} bookings",
      topServicesTitle: "Top Services",
      topServicesEmpty: "No service data yet",
      bookingsCount: "{n} bookings",
      staffTitle: "Staff Performance",
      staffEmpty: "No staff data yet",
      appointments: "{n} appts",
      healthTitle: "Customer Health",
      newClients: "New",
      clientsServed: "Served",
      noShowRate: "No-show",
      thisMonth: "This month",
      thisWeek: "This week",
      tomorrowTitle: "Tomorrow",
      tomorrowAppointments: "{n} appointments",
      tomorrowRevenue: "Est. revenue",
      tomorrowEmpty: "No appointments tomorrow",
      minhTitle: "AI Manager Minh",
      minhPendingApprovals: "{n} items need your review",
      minhViewAll: "Review",
      unclosedTitle: "Appointments not closed out",
      unclosedSubtitle:
        "{n} past appointments still have no final status — they're missing from your revenue and no-show numbers. Tap one to fix it.",
      unclosedMore: "and {n} more",
      bookingLink: "Booking page",
      refresh: "Refresh",
      openReceptionistCenter: "Open Receptionist Center",
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
    seatTogether: "Seat together",
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
    sectionAiManager: "AI Manager setup",
    sectionPromotions: "Promotions & discounts",
    categories: {
      brand: {
        title: "Brand & booking page",
        subtitle: "How your salon looks to customers",
      },
      booking: {
        title: "Booking & queue",
        subtitle: "Rules for how appointments are made",
      },
      notifications: {
        title: "Notifications & reminders",
        subtitle: "Emails, reminders & no-show follow-ups",
      },
      integrations: {
        title: "Integrations",
        subtitle: "Domain, Google, Wix & Voice AI",
      },
      plan: {
        title: "Plan & advanced",
        subtitle: "Subscription and power-user settings",
      },
      jumpLabel: "Jump to",
    },
    ownerNotifications: {
      title: "Manager email alerts",
      subtitle:
        "Email the owner & admins when a booking is created, rescheduled, cancelled, or marked no-show.",
      loading: "Loading…",
      enabledLabel: "Turn on manager email alerts",
      recipientsHeading: "Recipients",
      notifyMembersLabel: "Email all owners & admins",
      customEmailsLabel: "Also send to (optional)",
      customEmailsPlaceholder: "manager@salon.com, owner2@salon.com",
      customEmailsHint: "Separate multiple emails with a comma. Up to 10.",
      eventsHeading: "Notify me when…",
      eventLabels: {
        new: "New booking",
        reschedule: "Booking rescheduled",
        cancel: "Booking cancelled",
        no_show: "No-show",
      },
      save: "Save",
      saved: "Saved.",
      saveError: "Could not save. Please try again.",
      sendTest: "Send test email",
      testSent: "Test email sent to {n} recipient(s).",
      testErrorNotEnabled: "Turn on alerts first, then save.",
      testErrorNoRecipients:
        "No recipients yet — add an email or enable owners/admins.",
      testErrorNoResend: "Email service not configured.",
      testErrorGeneric: "Could not send the test email.",
    },
    staffNotifications: {
      title: "Customer notifications",
      subtitle:
        "When staff create, reschedule, or cancel a booking, choose whether the customer is notified — and in which language.",
      loading: "Loading…",
      enabledLabel: "Offer the “notify customer?” step on staff actions",
      channelsHeading: "Channels offered",
      smsLabel: "Text (SMS)",
      emailLabel: "Email",
      eventsHeading: "Notify the customer by default when…",
      eventsHint: "Staff can still toggle this per booking.",
      eventLabels: {
        create: "Booking created at the desk",
        reschedule: "Booking rescheduled",
        cancel: "Booking cancelled",
      },
      languageHeading: "Default language",
      languageHint:
        "Online bookings always use the language the customer chose on the site.",
      langEn: "English",
      langVi: "Vietnamese",
      save: "Save",
      saved: "Saved.",
      saveError: "Could not save. Please try again.",
    },
    emailVerification: {
      sectionTitle: "Notification email",
      description:
        "Receives booking confirmations, owner alerts and daily AI digest.",
      noEmailHint: "No email on file.",
      verifiedBadge: "Verified",
      pendingBadge: "Pending",
      pendingHint: "Verification link sent — check your inbox (and spam).",
      verifiedToast: "Email verified.",
      verifyErrorPrefix: "Verification failed: ",
      changeButton: "Change email",
      cancelButton: "Cancel",
      saveButton: "Save",
      saving: "Saving…",
      resendButton: "Resend link",
      resendSent: "Verification email sent",
      saveSuccess: "Saved — check your inbox to verify",
      saveError: "Could not save. Please try again.",
      invalidEmail: "Enter a valid email address.",
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
      advancedSectionTitle: "Advanced",
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
    salonLogo: {
      sectionTitle: "Salon logo",
      intro:
        "Shown at the top of your public booking page, so a guest arriving from your website knows they are still booking with you.",
      uploadCta: "Upload logo",
      replaceCta: "Replace logo",
      uploading: "Uploading…",
      remove: "Remove",
      removing: "Removing…",
      previewAlt: "Salon logo preview",
      empty: "No logo yet — the booking page shows your salon name only.",
      hint: "PNG, JPG, WebP or SVG. Up to 2 MB. A transparent background looks best.",
      errorTooLarge: "That file is over 2 MB. Please upload a smaller image.",
      errorInvalidType: "Use a PNG, JPG, WebP or SVG image.",
      errorGeneric: "Couldn't save the logo. Please try again.",
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
    walkinAutoAssign: {
      sectionTitle: "Walk-in queue",
      toggleLabel: "Auto-assign available staff",
      descriptionOn:
        "Walk-ins are assigned directly to the timeline when staff is free. Faster.",
      descriptionOff:
        "All walk-ins enter the queue first for receptionist review.",
      errorGeneric: "Could not save. Try again.",
    },
    queueDisplayMode: {
      sectionTitle: "Queue card view",
      labelFull: "Full",
      labelSimple: "Simple",
      descriptionFull:
        "Show all details: priority, party size, staff dispatch, and request tags.",
      descriptionSimple:
        "Small salons: hide priority, party size, and request tags. Keep wait time and actions.",
      errorGeneric: "Could not save. Try again.",
    },
    phoneOtp: {
      sectionTitle: "Phone verification (SMS OTP)",
      toggleLabel: "Require SMS code to confirm booking",
      descriptionOn:
        "Customers must verify their phone with a 6-digit SMS code before booking is confirmed. Reduces no-shows and fake numbers. ~$0.05 per verification via Twilio Verify.",
      descriptionOff:
        "Phone number is collected but not verified by SMS. Turn on to reduce fake bookings.",
      cost: "Requires Twilio Verify configured in environment.",
      errorGeneric: "Could not save. Try again.",
    },
    reminders: {
      autoTitle: "Auto reminders",
      autoHint: "Email 24h + SMS 3h before the appointment",
      advancedToggle: "Advanced options",
      email24h: "Email 24h before",
      email3h: "Email 3h before",
      sms3h: "SMS 3h before",
      save: "Save",
      saving: "Saving…",
      saved: "✓ Saved",
    },
    googleReview: {
      instruction:
        'Find the link on Google Maps → the "Write a review" button → copy the URL',
      saveError: "Save failed",
      save: "Save",
      saving: "Saving…",
      saved: "✓ Saved",
    },
    bookingVerify: {
      title: "Booking verification",
      subtitle: "Choose the verification level that fits your salon",
      saveError: "Save failed — try again",
      saved: "✓ Saved",
      neverLabel: "Trust everyone",
      neverHint: "No verification — lowest friction, highest risk.",
      autoLabel: "Smart auto (recommended)",
      autoHint:
        "Risk-based: regulars skip, risky bookings need OTP or a deposit.",
      otpLabel: "Always require OTP",
      otpHint: "Every booking needs phone verification. Free for customers.",
      depositLabel: "Always require a deposit",
      depositHint:
        "Every booking needs a deposit. Premium, maximum commitment.",
      depositThenOtpLabel: "Prefer deposit, OTP if declined",
      depositThenOtpHint:
        "Ask for a deposit first; if skipped, fall back to OTP.",
    },
    voiceAiSave: {
      saveError: "Save failed, try again.",
      save: "Save",
      saving: "Saving…",
      saved: "✓ Saved",
      invalidName: "Invalid name — letters, spaces, or hyphens only.",
      forbidden: "Only the owner can change this name.",
    },
  },
  serviceCategory: {
    pickerLabel: "Category",
  },
  serviceForm: {
    descriptionLabel: "Description",
    descriptionPlaceholder: "e.g. Women only; not offered to male guests.",
    descriptionHint:
      "Shown on the booking page and used by AI as the source of truth for eligibility, scope, and inclusions.",
    descriptionTooLong: "Keep the description to 250 characters or fewer.",
    popularLabel: "Popular",
    popularHint:
      "Shows a small gold badge on the public booking page — pick your busiest 1–3 services.",
    characterCount: "{used}/{max}",
    descriptionGeneratedToast: "✨ Description generated",
    saveButton: "Save",
    priceTypeLabel: "Pricing model",
    priceTypeFixed: "Fixed",
    priceTypeFrom: "From",
    priceTypeRange: "Range",
    priceFromShort: "From",
    priceMinLabel: "Minimum price",
    priceMaxLabel: "Maximum price",
    priceValidation: "Maximum price must be greater than minimum price.",
    addTitle: "Add service",
    editTitle: "Edit service",
    cancel: "Cancel",
  },
  setupErrors: {
    serviceInUse:
      "Service is used in active bookings. Cancel or complete those bookings before deleting.",
    staffHasBookings:
      "Staff has upcoming bookings. Reassign or cancel before deleting.",
    staffHasUpcoming:
      "This staff has upcoming appointments. Reassign them to another staff member before deactivating.",
    staffCannotPerformService:
      "This staff member is not set up to perform that service.",
    staffLimitReached: "Free plan allows 3 staff. Upgrade to Pro for 10.",
    serviceLimitReached: "Free plan allows 10 services. Upgrade to Pro for 50.",
    upgradeCta: "Upgrade your plan",
  },
  setupLabels: {
    name: "Name",
    save: "Save",
    saveAll: "Save all",
    delete: "Delete",
    cancel: "Cancel",
    servicesTitle: "Services",
    price: "Price",
    durationMin: "Duration (min)",
    bufferMin: "Buffer (min)",
    deleteService: "Delete service",
    editService: "Edit service",
    addService: "Add service",
    serviceSaved: "✓ Service saved",
    serviceRemoved: "✓ Service removed",
    saveFailed: "Could not save. Try again.",
    deleteFailed: "Could not delete. Try again.",
    staffTitle: "Staff",
    removeStaff: "Offboard staff member",
    editStaff: "Edit staff",
    addStaff: "Add staff",
    staffSaved: "✓ Staff member saved",
    staffRemoved: "✓ Staff member removed",
    hoursTitle: "Opening hours",
    days: {
      mon: "Monday",
      tue: "Tuesday",
      wed: "Wednesday",
      thu: "Thursday",
      fri: "Friday",
      sat: "Saturday",
      sun: "Sunday",
    },
    opens: "Opens",
    closes: "Closes",
    closed: "Closed",
    extraClosedDates: "Extra closed dates",
    hoursPreview: "Preview",
    hoursSaved: "✓ Hours saved",
    hoursIntro:
      "Set when clients can book. Weekly closed days won't show slots. Add extra closed dates (holidays) one per line as YYYY-MM-DD.",
    hoursDefaultLabel: "Default hours for all days",
    hoursDefaultHint: "Change these times to update all days at once",
    hoursFollowingDefault: "default",
    hoursCustomize: "Customize",
    hoursResetToDefault: "reset",
    hoursOverrideLabel: "Custom hours",
    closureNoticeTitle: "Closure notice (optional)",
    closureNoticeHint:
      'Shown as a banner on your public booking page — e.g. "Closed for renovation Mon Aug 17 & Tue Aug 18, reopening Wed Aug 19." Fill in both languages to show it, or clear both to hide it. It disappears automatically once every date above has passed.',
    closureNoticeEnLabel: "Message (English)",
    closureNoticeViLabel: "Message (Vietnamese)",
    addressTitle: "Salon address",
    streetAddress: "Street address",
    city: "City",
    provinceState: "Province/State",
    postalCode: "Postal code",
    country: "Country",
    salonPhone: "Salon phone",
    addressSaved: "✓ Address saved",
    descriptionLabel: "Salon description",
    timezone: "Timezone",
    timezoneRequired: "Timezone is required",
    searchServices: "Search services…",
    searchStaff: "Search staff…",
    saveConnectionFailed: "✗ Could not save. Check your connection.",
    removeFailed: "Could not remove. Try again.",
    updateRowFailed: "Could not update that row.",
    invalidName: "Fix the name and try again.",
    minStaffRequired:
      "You need more than one staff member before you can remove someone.",
    minServiceRequired: "You need more than one service before you can delete.",
    removed: "Removed",
    undo: "Undo",
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
    roleLabel: "Role",
    roleOptions: {
      owner: "Owner",
      senior: "Senior",
      nail_tech: "Nail tech",
    },
  },
  aiPrefill: {
    bannerTitle: "Import your menu in seconds",
    bannerSubtitle:
      "Take a photo of your price list and AI will fill in your services automatically.",
    bannerCta: "Import from photo",
    step1Title: "How would you like to add your services?",
    uploadCard: "Upload menu photo",
    uploadCardSub: "Photo of your price list, wall menu, or price sheet",
    urlCard: "Paste image link",
    urlCardSub: "Link to a photo of your menu (Facebook, website, etc.)",
    manualCard: "Enter manually",
    manualCardSub: "I'll type my services in one by one",
    urlPlaceholder: "https://...",
    analyzeButton: "Read menu",
    processingTitle: "Reading your menu…",
    processingSub: "AI is extracting your services. This takes a few seconds.",
    reviewTitle: "Review extracted services",
    reviewSub:
      "Select the services you'd like to import. You can edit prices and durations.",
    selectAll: "Select all",
    deselectAll: "Deselect all",
    priceLabel: "Price",
    durationLabel: "Min",
    importButton: "Import services",
    importButtonN: "Import {n} services",
    manualFallback: "Enter manually instead",
    errorVisionFailed:
      "Couldn't read the menu. Please try a clearer photo or enter manually.",
    errorNoServices:
      "No services found in this image. Try a closer photo of the price list.",
    errorPlanLimit: "You've reached your plan's service limit.",
    errorPayloadTooLarge:
      "Image is too large. Please resize to under 4MB and try again.",
    errorInvalidUrl: "Invalid image URL. Please check the link and try again.",
    successToast: "Services imported successfully!",
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
    dateNavigator: {
      chooseDate: "Choose date",
      previous: {
        day: "Previous day",
        week: "Previous week",
        month: "Previous month",
      },
      next: {
        day: "Next day",
        week: "Next week",
        month: "Next month",
      },
      current: {
        day: "Today",
        week: "This week",
        month: "This month",
      },
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
    themePicker: {
      title: "DRC Color",
      saved: "Saved",
      saving: "Saving…",
      customLabel: "Custom color",
      applyButton: "Apply",
      resetButton: "Reset to NailIQ default",
      openAria: "Change DRC color",
      colorPickerTitle: "Pick a custom color",
      presets: {
        fire_red: { label: "Fire — Red 🔴", desc: "Passion, good luck" },
        fire_orange: { label: "Fire — Orange 🟠", desc: "Energy, brightness" },
        metal_gold: { label: "Metal — Gold ⭐", desc: "Wealth, prosperity" },
        wood_green: { label: "Wood — Green 🟢", desc: "Growth, vitality" },
        water_blue: { label: "Water — Blue 🔵", desc: "Peace, wisdom" },
        water_purple: { label: "Water — Purple 🟣", desc: "Spirit, nobility" },
        earth_brown: {
          label: "Earth — Brown 🟤",
          desc: "Stability, resilience",
        },
        nailiq_gold: { label: "NailIQ Gold ✦", desc: "Default" },
      },
      bgTitle: "DRC Background",
      bgReset: "Reset to NailIQ dark",
      bgPresets: {
        charcoal: "Charcoal (default)",
        navy: "Deep Navy",
        teal: "Dark Teal",
        forest: "Dark Forest",
        purple: "Dark Purple",
        crimson: "Dark Crimson",
      },
    },
    basicMode: {
      toggle: "Basic",
      toggleOnAria: "Switch to Basic Mode — simplified front-desk cockpit",
      toggleOffAria: "Exit Basic Mode — back to the full board",
      pageTitle: "Receptionist",
      nextActionHeading: "Next action",
      aiSuggestionHeading: "NailIQ suggests",
      aiAllClear: "The desk is on track — no urgent action right now",
      aiReasons: {
        overdue: "Because the scheduled service end time has passed.",
        online_waitlist:
          "Because an online customer is waiting for the salon to respond.",
        not_started:
          "Because the appointment time passed and service has not started.",
        long_wait:
          "Because this guest has waited longer than the salon’s target.",
        no_staff_for_waiting:
          "Because guests are waiting and no staff member is available.",
        sms_failed: "Because a guest may not have received their confirmation.",
        party_change: "Because this group still has unconfirmed guests.",
        setup_incomplete:
          "Because missing setup details can block daily operations.",
        finish_overdue:
          "Because an active service is running beyond its planned time.",
        assign_waiting: "Because a guest is waiting and can be served next.",
        prepare_next: "Because the next guest is arriving within 30 minutes.",
        party_pending: "Because the group booking is not fully confirmed yet.",
        suggest_walkin:
          "Because staff capacity is open and no guest is waiting.",
        all_clear:
          "Because no urgent delay, wait, or service issue is detected.",
      },
      alertsHeading: "Needs attention",
      moreIssues: (n: number) => `+${n} more issue${n === 1 ? "" : "s"}`,
      longWaitGuest: (n: number) => `1 guest has waited over ${n} min`,
      finishOverdue: (n: number) =>
        n === 1
          ? "1 booking is overdue — wrap up or extend"
          : `${n} bookings overdue — wrap up or extend`,
      assignWaiting: (n: number) =>
        n === 1
          ? "1 guest is waiting. Assign them to an available staff member."
          : `${n} guests are waiting. Assign the next guest to an available staff member.`,
      assignWaitingNamed: (name: string) =>
        `${name} is waiting. Assign them to an available staff member.`,
      prepareNext: (n: number) =>
        n === 1
          ? "1 guest arriving in the next 30 min"
          : `${n} guests arriving in the next 30 min`,
      partyPendingNamed: (time: string, name: string) =>
        `${name}'s party · ${time}: 1 guest hasn't claimed`,
      partyPendingCount: (time: string, n: number) =>
        `${n} guests haven't claimed their slot · ${time}`,
      suggestWalkin: (name: string) =>
        `${name} is available. You can add a walk-in.`,
      actionOpenQueue: "Open queue",
      actionOpenWaitlist: "View and respond",
      actionAddWalkin: "+ Walk-in",
      actionOpenParty: "Open party bookings",
      actionOpenBooking: "Open booking",
      alertOverdue: (n: number) =>
        n === 1 ? "1 booking overdue" : `${n} bookings overdue`,
      alertOnlineWaitlist: (n: number, minutes: number) =>
        n === 1
          ? `New online customer waiting · ${minutes} min`
          : `${n} online customers waiting · oldest ${minutes} min`,
      alertOverdueNamed: (name: string, time: string) =>
        `${name} overdue · ${time}`,
      alertNotStarted: (n: number) =>
        n === 1 ? "1 guest overdue to start" : `${n} guests overdue to start`,
      alertNotStartedNamed: (name: string, time: string) =>
        `${name} not started · ${time}`,
      alertLongWait: (n: number) => `Guest waiting over ${n} min`,
      alertNoStaffForWaiting: "Guests waiting — no staff available",
      alertSmsFailed: (n: number) =>
        n === 1 ? "1 confirmation SMS failed" : `${n} confirmation SMS failed`,
      alertSetupIncomplete: "Setup incomplete — add services & staff",
      nowAvailableStaff: "Available staff",
      nowNoOneWaiting: "No one waiting",
      nowNoStaffAvailable: "None",
      nowUpcoming: "Upcoming",
      nowUpcomingTitle: "Arriving in the next 30 min",
    },
    dailyBrief: {
      eyebrow: "NailIQ morning brief",
      title: "Today at a glance",
      closingEyebrow: "NailIQ closing brief",
      closingTitle: "Finish the day with confidence",
      bookings: "Bookings",
      vip: "VIP",
      staffReady: "Staff ready",
      waiting: "Waiting",
      remaining: "Remaining",
      inService: "In service",
      completed: "Finished",
      readyToClose: "Everything is clear — ready to close",
      workRemaining: (count: number) =>
        count === 1
          ? "1 item still needs attention"
          : `${count} items still need attention`,
      dayWindow: (start: string, end: string) => `Schedule ${start}–${end}`,
      riskGuests: (count: number) =>
        count === 1
          ? "1 guest needs no-show attention"
          : `${count} guests need no-show attention`,
      calmDay: "No high-risk guests on today’s schedule",
      collapse: "Mark today’s brief as reviewed",
      expand: "Open today’s NailIQ brief",
    },
    partyCard: {
      panelSummary: (n: number) =>
        `${n} group booking${n !== 1 ? "s" : ""} · next 7 days`,
      panelEmpty: "No upcoming group bookings",
      emptyNext7: "No group bookings in the next 7 days.",
      refresh: "Refresh party cards",
      arriveTogether: "Arrive together",
      finishTogether: "Finish together",
      changesRequested: (n: number) =>
        `${n} change${n !== 1 ? "s" : ""} requested`,
      wavesBadge: (n: number) => `${n} waves`,
      confirmedProgress: (claimed: number, total: number) =>
        `${claimed}/${total} confirmed`,
      pendingSuffix: (n: number) => `${n} pending`,
      pendingHelp:
        "Guests who haven't confirmed their name/phone via the group link.",
      slotsCount: (n: number) => `${n} slot${n !== 1 ? "s" : ""}`,
      waveLabel: (n: number) => `Wave ${n}`,
      copyLink: "Copy group link",
      copied: "✓ Copied!",
      statusConfirmed: "Confirmed",
      statusPending: "Pending",
      statusExpired: "Expired",
      claimOnBehalf: "Assign name",
      claimNameLabel: "Name",
      claimNamePlaceholder: "Guest's name",
      claimPhoneLabel: "Phone (optional)",
      claimPhonePlaceholder: "+1 604 000 0000",
      claimSave: "Save",
      claimCancel: "Cancel",
      claimError: "Couldn't save — please try again",
      cancelParty: "Cancel party",
      cancelConfirm: (n: number) =>
        `Cancel all ${n} booking${n !== 1 ? "s" : ""} in this party?`,
      cancelConfirmYes: "Yes, cancel all",
      cancelConfirmNo: "Keep",
      cancelling: "Cancelling…",
      cancelError: "Couldn't cancel — please try again",
      notifyLabel: "Notify the organizer",
      notifySms: "SMS",
      notifyEmail: "Email",
      cancelFeeLoading: "Checking cancellation policy…",
      cancelFeeDecision: (amount) => `${amount} requires owner/admin review.`,
      cancelFeeNoCharge: "This action will not collect money.",
      cancelFeeReview: "Cancel and send for review",
      cancelFeeWaive: "Cancel and waive fee",
      cancelFeeNotApplicable: "No cancellation fee applies.",
      cancelSmsDisabled: "SMS is OFF. The organizer will not receive a text.",
      cancelFeeQueued: (amount) => `${amount} queued for owner/admin review; not charged.`,
      cancelFeeWaivedSuccess: "Fee waived; no charge.",
      cancelNotificationQueued: (sms, email) => {
        const channels = [sms ? "SMS" : null, email ? "email" : null].filter(Boolean);
        return channels.length > 0
          ? `${channels.join(" + ")} queued (delivery not yet confirmed).`
          : "No organizer notification requested.";
      },
      cancelSuccess: (n, fee, notification) =>
        `Cancelled ${n} appointments. ${fee} ${notification}`,
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
      lastUpdated: (time: string) => `Updated ${time}`,
      reload: "Reload",
    },
    soundUnlockHint: "Click anywhere to enable sound alerts",
    removedGuest: "Removed guest",
    kpiBar: {
      waiting: "Waiting",
      avgWait: "Avg wait",
      avgWaitEmpty: "No queue",
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
      addWalkinCta: "+ Walk-in",
      emptyMessage: "No walk-ins queued. Use the form above to add.",
      cancelButton: "Remove",
      assignButton: "Assign",
      urgentBadge: "URGENT",
      waitingHint: "Tap a slot on the timeline to seat this guest",
      minutesAgo: (n: number) => (n < 1 ? "just now" : `${n} min wait`),
      sortLabel: "Sort",
      sortFifo: "First in",
      sortLongestWait: "Longest wait",
      sortCustom: "Custom order",
      avgWait: (n: number) => `Avg wait · ${n} min`,
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
      softHoldButton: "Customer steps out",
      softHoldClear: "Customer returned",
      softHoldLabel: "Stepped out",
      softHoldCountdown: (n: number) => `${n} min left`,
      softHoldExpiredNotice: "{name}'s hold expired",
      waitLinkButton: "Send wait link",
      waitLinkModal: {
        title: "Customer wait link",
        instruction: "Show this QR to {name} or copy the link to send via SMS.",
        copyLink: "Copy link",
        copied: "Copied!",
        openLink: "Open link",
        closeAria: "Close",
      },
      contact: {
        openDetails: (name) => `Open contact details for ${name}`,
        missingBadge: "At salon",
        reachableBadge: "Reachable",
        steppedOutBadge: "Stepped out",
        title: "Walk-in details",
        stepOutTitle: "Customer is stepping out",
        description: "Contact stays private to this salon booking.",
        stepOutDescription: "Add one contact method, then NailIQ will hold their place for 10 minutes.",
        close: "Close walk-in details",
        phone: "Phone (optional)",
        email: "Email (optional)",
        phonePlaceholder: PHONE_INPUT_PLACEHOLDER_NANP,
        emailPlaceholder: "customer@example.com",
        noContact: "No contact needed while the customer stays here",
        stepOutContactRequired: "Add a phone number or email before the customer steps out.",
        contactReady: "Contact ready",
        smsConsentYes: "SMS consent already verified",
        smsConsentNo: "SMS consent not verified",
        consentTruth: "Staff-entered contact is saved but never treated as customer SMS consent and sends nothing automatically. Use the customer QR/link for live wait updates.",
        invalidPhone: "Enter a valid phone number.",
        invalidEmail: "Enter a valid email address.",
        save: "Save contact",
        saveAndHold: "Save & hold 10 min",
        saving: "Saving…",
        call: "Call",
        copyPhone: "Copy phone",
        copyEmail: "Copy email",
        copied: "Copied",
        saveFailed: "Could not save contact. Try again.",
      },
      addForm: {
        namePlaceholder: "Guest name",
        phonePlaceholder: `${PHONE_INPUT_PLACEHOLDER_NANP} (optional)`,
        phoneOptionalHint: "Optional now · add contact if the customer steps out",
        notePlaceholder:
          "Note for staff — e.g. polish color, prefers window seat",
        addButton: "Add customer",
        incompleteHint: "Enter a name and pick a service to add",
        moreServices: "More services",
        submitting: "Adding…",
        errorRequired: "Pick a service to continue.",
        actualTimeLabel: "Customer arrived at",
        actualTimeHint: "Now by default · adjust back up to 30 minutes",
        actualTimeInvalid: "Choose now or a time within the last 30 minutes.",
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
        moreDetails: "More details (optional)",
        hideDetails: "Hide details",
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
        walkinConflictsGroup: "{name} has a group booking at {time}. Continue?",
        walkinContinueAnyway: "Continue anyway",
        walkinChooseDifferent: "Choose different staff",
        walkinSaved: "Customer added successfully.",
        walkinSavedAssignmentPending:
          "Customer saved to the waiting list. The schedule changed before assignment — no need to enter them again.",
        walkinRetrySafe:
          "The connection was interrupted. Tap again to check safely — NailIQ will not create a duplicate.",
        relative: {
          justNow: "Just now",
          today: "Today",
          daysAgo: (n: number) => `${n} day${n === 1 ? "" : "s"} ago`,
          weeksAgo: (n: number) => `${n} week${n === 1 ? "" : "s"} ago`,
          monthsAgo: (n: number) => `${n} month${n === 1 ? "" : "s"} ago`,
        },
      },
    },
    waitlist: {
      title: "Waitlist",
      inviteNow: "Invite now",
      inviteAgain: "Invite again",
      invited: "Invitation open",
      statusWaiting: "Waiting",
      needsPlan: "Needs plan",
      autonomy: {
        autoSafe: "NailIQ autopilot",
        approvalRequired: "One-tap approval",
        humanException: "Staff exception",
        watchingForExactSlot:
          "NailIQ is watching for a matching opening and will invite the customer through the protected offer flow.",
        customerResponsePending:
          "The exact offer is open. NailIQ is waiting for the customer and tracking delivery by channel.",
        exactPlanRequired:
          "NailIQ must prove staff, resource, timing and policy fit before approval becomes available.",
        bookingCommitPending:
          "The customer claimed the opening. Confirm the final appointment so the slot cannot be lost or duplicated.",
        unsafeStateCombination:
          "This request is outside the safe automation contract and needs staff review.",
        approvalLocked: "Approval unlocks only after an executable plan is ready.",
      },
      groupRequest: (partySize, serviceCount) =>
        `${partySize} guests · ${serviceCount} services`,
      sequenceRequest: (serviceCount) =>
        `${serviceCount} service${serviceCount === 1 ? "" : "s"} in sequence`,
      callToArrange: "Call to arrange",
      deliveryHeading: "Notification status",
      smsChannel: "SMS",
      emailChannel: "Email",
      deliveryStatus: {
        sent: "Sent",
        sending: "Sending",
        failed: "Failed",
        unknown: "Not verified",
        channelDisabled: "Turned off",
        recipientMissing: "Contact missing",
        recipientSuppressed: "Customer opted out",
        unavailable: "Unavailable",
      },
      deliveryResultToast: (name, deliveredBy, needsAttention) =>
        needsAttention
          ? `Invited ${name} by ${deliveredBy}. Check the other channel below.`
          : `Invited ${name} by ${deliveredBy}.`,
      deliveryPendingToast: (name) =>
        `Opened the spot for ${name}. Notification delivery is still being verified.`,
      deliveryFailedToast: (name) =>
        `Opened the spot for ${name}, but no notification was delivered.`,
      waitingMinutes: (minutes) =>
        minutes === 0 ? "Waiting now" : `Waiting ${minutes} min`,
      claimed: "✅ Claimed",
      createBooking: "Create booking",
      empty: "No one on the waitlist",
      invitedToast: (name) => `Invited ${name} by SMS`,
      suppressedToast: (name) =>
        `Marked ${name} invited — SMS disabled in this environment`,
      errorToast: "Could not send the invite. Please try again.",
      openCustomerDetails: (name) => `Open details for ${name}`,
      detailsTitle: "Waitlist customer",
      detailsDescription: "Private contact and scheduling details for salon staff.",
      closeDetails: "Close customer details",
      fullName: "Full name",
      statusLabel: "Waitlist status",
      phoneLabel: "Phone",
      emailLabel: "Email",
      serviceLabel: "Service",
      dateLabel: "Preferred date",
      timeLabel: "Preferred time",
      staffLabel: "Staff preference",
      joinedAtLabel: "Joined waitlist",
      waitingLabel: "Waiting time",
      requestKindLabel: "Request",
      sourceLabel: "Reason",
      anyTime: "Any time",
      anyStaff: "Any staff",
      individualRequest: "Individual appointment",
      source: {
        slot_unavailable: "Requested time was verified full",
        booking_conflict: "Slot was taken during booking",
      },
      callCustomer: "Call customer",
      copyPhone: "Copy phone",
      copyEmail: "Copy email",
      phoneCopied: "Phone copied.",
      emailCopied: "Email copied.",
      copyFailed: "Could not copy. Please try again.",
    },
    walkin: {
      invalidPhone:
        "Phone number invalid. Examples: +1 (604) 555-1234 or +84901234567",
      phoneRequired: "Enter the guest phone number.",
      nameRequired: "Please enter the guest name.",
      nameTooLong: "Name cannot exceed 100 characters.",
      invalidNameChars: "Name contains invalid characters.",
    },
    grid: {
      conflictWith: (clientName: string) =>
        `${clientName.trim() ? `⚠ Busy — ${clientName}` : "⚠ Slot conflict"}`,
      overflowMessage: "⚠ Past closing hours",
      closingLabel: "Close",
      conflictShake:
        "That slot overlaps another booking. Choose another slot or time.",
      rescheduleFailed: {
        past_date: "Can't move a booking into the past.",
        outside_hours: "The service would finish after the salon closes.",
        slot_conflict: "That slot overlaps another booking.",
        staff_cannot_perform_service:
          "That staff member doesn't perform this service.",
        generic: "Couldn't move the booking. Try again.",
      },
      bookingIcon: {
        vip: "VIP",
        notes: "Has notes",
        late: "Late",
        design: "Design / nail art",
        staffRequest: "Staff request",
        seatTogether: "Seat together",
      },
    },
    undo: {
      undo: "Undo",
      undoFailed: "Service already started — undo is unavailable.",
      assignedPrefix: "Assigned:",
      assignedMiddle: "→",
      cancelledPrefix: "Cancelled:",
      cancelUndoFailed:
        "Cannot undo — appointment already past or staff just booked.",
    },
    notify: {
      heading: "Notify customer",
      sms: "Text (SMS)",
      email: "Email",
      previewTitle: "Preview",
      willNotNotify: "Customer won't be notified.",
      noPhone: "no phone",
      noEmail: "no email",
      unavailable: "disabled in salon settings",
      langEn: "in English",
      langVi: "in Vietnamese",
      cancelTitle: "Cancel appointment?",
      cancelDesc: "Choose whether to let the customer know.",
      confirmCancel: "Cancel appointment",
      keep: "Keep",
      groupBanner: (n) => `👥 This guest is part of a party of ${n}.`,
      cancelThisOne: "Just this person",
      cancelWholeParty: (n) => `Whole party (${n})`,
      confirmCancelGroup: (n) => `Cancel whole party (${n})`,
      groupFeeLoading: "Checking the cancellation policy…",
      groupFeeLoadFailed: "The fee decision could not be loaded. Nothing has been cancelled.",
      groupFeeRetry: "Try again",
      groupFeeDecisionRequired: (amount) => `${amount} requires an owner/admin decision.`,
      groupFeeNoChargeToday: "No payment will be collected by this cancellation.",
      groupFeeReview: "Cancel and send for review",
      groupFeeWaive: "Cancel and waive fee",
      groupFeeQueuedForReview: (amount) => `${amount} queued for owner/admin review; not charged.`,
      groupFeeWaived: "Fee waived; no charge.",
      groupFeeNotApplicable: "No cancellation fee applies.",
      groupSmsDisabledWarning: "SMS is OFF for this salon. The customer will not receive a text unless SMS is enabled before this action.",
      groupNotificationQueued: (sms, email) => {
        const channels = [sms ? "SMS" : null, email ? "email" : null].filter(Boolean);
        return channels.length > 0
          ? `${channels.join(" + ")} queued (delivery not yet confirmed).`
          : "No customer notification requested.";
      },
      groupCancelSuccess: (n, fee, notification) =>
        `Cancelled ${n} appointments. ${fee} ${notification}`,
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
      phoneSection: "Phone",
      revealPhone: "Show number",
      hidePhone: "Hide number",
      callGuestShort: "📞 Call",
      startService: "Start service",
      markComplete: "Mark complete",
      cancelBooking: "Cancel booking",
      approveWix: "Approve",
      declineWix: "Decline",
      noShow: "No-show",
      editBooking: "Edit",
      restoreBooking: "Restore booking",
      cancelConfirm: (clientName: string) =>
        `Cancel booking for ${clientName.trim() ? clientName.trim() : "this guest"}?`,
      restoreConfirm: (clientName: string) =>
        `Restore booking for ${clientName.trim() ? clientName.trim() : "this guest"}?`,
      restoreConflict: "Cannot restore — that time slot is now taken.",
      restorePast: "Cannot restore — the appointment time has passed.",
      none: "—",
      scheduleSection: "Schedule",
      statusSection: "Status",
      priceSection: "Price",
      noNotesHint: "No notes",
      sectionAddon: "Add-on",
      groupSectionTitle: (n: number) => `👥 Party of ${n}`,
      groupOrganizedBy: (name: string) => `Organized by ${name}`,
      groupOrganizerBadge: "Organizer",
      groupSeatTogether: "Seated together 💕",
      viewPartyCard: "View group card →",
    },
    edit: {
      modeTitle: "Edit booking",
      dateLabel: "Date",
      timeLabel: "Time",
      slotsLoading: "Finding open times…",
      noSlots: "No open times this day — pick another date.",
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
      pastDateMessage: "Can't move a booking to the past.",
      outsideHoursMessage:
        "Choose a time that lets the service finish before closing.",
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
      invalid_actual_time: "Choose a valid arrival time.",
      actual_time_too_old: "Arrival time can be adjusted back up to 30 minutes.",
      actual_time_in_future: "Arrival time cannot be in the future.",
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
      monthly_booking_limit_reached:
        "This salon hit its plan's monthly booking limit. Upgrade to continue.",
      feature_not_enabled:
        "Archived booking recovery is not enabled for this salon.",
      invalid_recovery:
        "This recovery request is invalid. Close it and try again.",
      invalid_recovery_source:
        "The original booking is no longer eligible for recovery.",
      already_recovered:
        "A replacement booking was already created from this record.",
      immutable_terminal_state:
        "Cancelled and no-show records stay locked. Create a new linked booking instead.",
      external_calendar_not_supported:
        "Archived recovery is not available while this salon is connected to Wix.",
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
        queue_joined: "{name} joined the waiting queue",
        queue_assigned: "{name} was assigned a slot",
        queue_left: "{name} left the queue",
        soft_hold_set: "Held a slot for {name}",
        soft_hold_expired: "Hold expired for {name}",
      },
      statusNames: {
        pending: "Pending",
        confirmed: "Confirmed",
        in_progress: "In progress",
        completed: "Completed",
        cancelled: "Cancelled",
        waiting: "Waiting",
        no_show: "No-show",
      },
      statusTransitions: {
        confirmed_to_in_progress: "Started service for {name}",
        in_progress_to_completed: "Completed service for {name}",
        pending_to_confirmed: "Confirmed booking for {name}",
        waiting_to_confirmed: "Confirmed booking for {name}",
        confirmed_to_cancelled: "Cancelled booking for {name}",
        pending_to_cancelled: "Cancelled booking for {name}",
        in_progress_to_cancelled: "Cancelled in-progress booking for {name}",
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
      month: "Month",
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
      openBookingAria: "View booking for {client}",
    },
    monthView: {
      title: "Month",
      prevMonth: "Prev",
      thisMonth: "This month",
      nextMonth: "Next",
      loading: "Loading…",
      dayError: "Error",
      emptyDay: "No bookings",
      bookingCount: "{n} bookings",
      moreCount: "+{n} more",
      openBookingAria: "View booking for {client}",
      closeDayPanel: "Close",
      openDayView: "Full day view →",
      panelEmpty: "No bookings this day",
      panelLoading: "Loading…",
      statusNames: {
        pending: "Pending",
        confirmed: "Confirmed",
        in_progress: "In progress",
        completed: "Done",
      },
    },
    clientProfiles: {
      pageTitle: "Clients",
      sectionTitle: "Recent clients",
      sectionIntro: "Full client directory — search by name or phone number.",
      searchPlaceholder: "Search by name or phone number…",
      loading: "Loading clients…",
      empty: "No clients yet.",
      unknownName: "(unnamed)",
      vipBadge: "VIP",
      summaryLine: (visits, lastVisit) =>
        `${visits} ${visits === 1 ? "visit" : "visits"} · last ${lastVisit}`,
      segments: {
        all: "All",
        vip: "VIP",
        new: "New",
        regular: "Regular",
        atRisk: "At-risk",
      },
      countLabel: (shown, total) => `${shown} of ${total}`,
      loadMore: "Show more",
      totalCountLabel: (total) =>
        `${total.toLocaleString()} ${total === 1 ? "client" : "clients"}`,
      pageLabel: (page, totalPages) => `Page ${page} of ${totalPages}`,
      prevPage: "Previous",
      nextPage: "Next",
      noVisitsYet: "No visits yet",
      statVisits: "Visits",
      statSpent: "Spent",
      statLastVisit: "Last visit",
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
      viewModes: {
        cards: "Cards",
        list: "List",
        details: "Details",
      },
      tableColumns: {
        name: "Name",
        phone: "Phone",
        visits: "Visits",
        lastVisit: "Last visit",
        spent: "Spent",
        vip: "VIP",
      },
      profile360: {
        title: "Customer Profile",
        close: "Close",
        loading: "Loading profile…",
        error: "Could not load profile. Try again.",
        lifetimeSpent: "Lifetime",
        visits: "Visits",
        avgTicket: "Avg ticket",
        lastVisit: "Last visit",
        clientSince: (date: string) => `Client since ${date}`,
        aiSummaryTitle: "AI Summary",
        aiGenerating: "Generating summary…",
        aiNextAction: "Suggested action",
        bookAgain: "Book again",
        reliabilityTitle: "Reliability",
        completed: "Completed",
        noShow: "No-show",
        cancelled: "Cancelled",
        noShowRate: (pct: number) => `${pct}% no-show rate`,
        favoritesTitle: "Favorites",
        topService: "Favourite service",
        topStaff: "Favourite staff",
        patternTitle: "Visit pattern",
        usualPattern: (weekday: string, hour: number, days: number) =>
          `Usually ${weekday} ~${hour}:00, every ${days} days`,
        nextPredicted: "Next predicted visit",
        preferencesTitle: "Preferences",
        allergiesWarning: "⚠ Allergies / sensitivities",
        favoriteColors: "Favourite colours",
        favoriteStyles: "Favourite styles",
        language: "Language",
        commChannel: "Preferred contact",
        consentsTitle: "Consents",
        consentSms: "SMS",
        consentEmail: "Email",
        consentAi: "AI",
        moneyTitle: "Money",
        loyaltyStamps: "Stamps",
        loyaltyRewards: "Rewards",
        activeVouchers: "Active vouchers",
        expiresOn: (date: string) => `Expires ${date}`,
        timelineTitle: "Visit history",
        upcomingTitle: "Upcoming",
        showMore: "Show more",
        reviewsTitle: "Reviews",
        notificationsTitle: "Notifications",
        aiEngagementTitle: "AI engagement",
        chatCount: "Chats",
        voiceCount: "Voice calls",
        lastInteraction: "Last interaction",
        actionBookAgain: "Book again",
        actionMessage: "Message",
        actionEdit: "Edit",
        actionClose: "Close",
        weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        channelOnline: "Online",
        channelWalkin: "Walk-in",
        channelVoice: "Voice AI",
        channelDesk: "Desk",
        statusCompleted: "Completed",
        statusCancelled: "Cancelled",
        statusNoShow: "No-show",
        statusConfirmed: "Confirmed",
        statusInProgress: "In progress",
        composePlaceholder: "Type your message…",
        composeSend: "Send",
        composeCancel: "Cancel",
        composeCharCount: (used: number, max: number) => `${used} / ${max}`,
        composeSent: "Message sent ✓",
        composeSentSuppressed: "Sent (test environment — not billed)",
        composeError: (msg: string) => `Failed to send: ${msg}`,
        regenerateSummary: "Regenerate",
        rebookInviteTemplate: ({ firstName, service, staff, bookingUrl }) => {
          const parts = [
            `Hi ${firstName}! We'd love to see you again at Hi-Lite.`,
          ];
          if (service) parts.push(`Your favourite service: ${service}.`);
          if (staff) parts.push(`Book with ${staff}.`);
          parts.push(`Book here: ${bookingUrl}`);
          return parts.join(" ");
        },
      },
    },
    pricing: {
      sectionTitle: "Subscription",
      sectionIntro:
        "Choose the plan that fits your salon. V1 billing changes are handled manually by NailIQ support.",
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
        phase_2_not_available:
          "Automatic subscription billing arrives in Phase 2. Contact NailIQ support for a manual V1 plan change.",
        no_stripe_client: "Billing is not configured. Contact support.",
        server_error: "Could not start checkout. Try again shortly.",
      },
      portalErrors: {
        unauthorized: "Sign in is required.",
        forbidden: "Only the salon owner can manage billing.",
        no_customer: "No active subscription to manage.",
        phase_2_not_available:
          "Automatic subscription management arrives in Phase 2. Contact NailIQ support for V1 billing help.",
        no_stripe_client: "Billing is not configured. Contact support.",
        server_error: "Could not open the billing portal. Try again shortly.",
      },
    },
    reports: {
      pageTitle: "Reports",
      navLinkLabel: "Reports",
      loading: "Loading reports…",
      estimatedValueNotice:
        "Estimated values use stored booking or catalog prices for completed appointments. They are not collected-payment, tax, tip, commission, or refund totals, and unsupported historical or integration rows may be incomplete.",
      rangeAriaLabel: "Date range",
      range: {
        today: "Today",
        week: "This week",
        month: "This month",
      },
      kpis: {
        totalRevenue: "Estimated completed service value",
        appointments: "Appointments",
        completed: "Completed",
        cancelled: "Cancelled",
        noShow: "No-show",
      },
      tables: {
        topServices: "Top services",
        topStaff: "Top staff",
        bySource: "Bookings by source",
        empty: "No data in this range yet.",
        serviceCol: "Service",
        staffCol: "Staff",
        sourceCol: "Source",
        countCol: "Count",
        appointmentsCol: "Appointments",
        shareCol: "Share",
        revenueCol: "Estimated value",
      },
      channelLabels: {
        online: "Online",
        square: "Square",
        wix: "Wix",
        voice: "Voice AI",
        walkin: "Walk-in",
        desk: "Front desk",
      },
      busyHours: {
        title: "Busy hours",
        empty: "No bookings in this range.",
        totalBookings: "{n} bookings",
      },
      staffPerformance: {
        title: "Staff performance",
        empty: "No staff activity in this range yet.",
        upsellTitle: "Detailed staff metrics on Studio",
        upsellBody:
          "See per-staff cancellation rate, no-show rate, service mix, and repeat clients. Available on the Studio plan.",
        upsellCta: "Upgrade to Studio",
        col: {
          staff: "Staff",
          appointments: "Appts",
          completion: "Completion",
          cancellation: "Cancel",
          noShow: "No-show",
          revenue: "Revenue",
          repeatClients: "Repeat clients",
          topServices: "Top services",
        },
      },
      errors: {
        unauthorized: "Sign in is required.",
        forbidden: "Only the salon owner can view reports.",
        server_error: "Could not load reports. Try again shortly.",
        feature_not_enabled: "Advanced reports aren't enabled for this salon.",
      },
    },
    bookingLimitBanner: {
      warningTitle: "Approaching your monthly booking limit",
      blockingTitle: "Monthly booking limit reached",
      usageText:
        "{used} / {cap} bookings this month. Upgrade to Pro to remove the cap.",
      upgradeCta: "Upgrade to Pro",
      manageCtaSettings: "Manage in Settings",
      upgradeError:
        "Couldn't start checkout. Try again from Settings → Billing.",
    },
    noShowFeeModal: {
      title: "No-show fee",
      desc: (amount: string) =>
        `A fee of ${amount} is saved on this booking's card.`,
      charge: (amount: string) => `Charge ${amount} now`,
      chargeFailed:
        "The appointment was marked no-show, but the card was not charged. Check the no-show record before contacting the guest.",
      waive: "Waive fee",
      cancel: "Cancel (mark no-show, decide later)",
    },
    noShowSafety: {
      title: "Confirm no-show",
      desc: (name: string) =>
        `Confirm ${name} did not arrive. The booking will remain unchanged for 60 seconds.`,
      groupOnly: "This affects only this guest, not the rest of the group.",
      confirm: "Start 60-second review",
      keep: "Keep booking",
      pending: "No-show pending — booking still holds the slot",
      pendingDetail:
        "Undo within 60 seconds. No history, waitlist, notification, or fee runs before commit.",
      finalizeFailed:
        "The no-show was not committed. The booking remains the source of truth; refresh and review it.",
    },
    latenessGrid: {
      startShort: "Start",
      autoNoShowAt: (time: string) => `No-show review due at ${time}`,
      late: "Late",
      veryLate: "Very late",
      noShowDecisionNeeded: "No-show decision needed",
      tombstoneAria: (clientName: string) => `No-show: ${clientName}`,
      tombstoneUndo: "Undo no-show",
      tombstoneCharge: (amount: string) => `Charge ${amount}`,
      tombstoneWaive: "Waive fee",
      tombstoneCharged: (amount: string) => `Charged ${amount}`,
      tombstoneWaived: "Waived",
      tombstoneFailed: "Charge failed",
      tombstoneUnpaid: (amount: string) => `Unpaid ${amount} — tap to charge`,
      tombstoneNoCard: "No-show",
    },
  },
  wixSlotTaken:
    "Sorry, this time slot was just booked by someone else. Please choose a different time.",
  disputes: {
    pageTitle: "Card Disputes",
    intro: "Review and respond to card disputes filed by your customers.",
    navLabel: "Card Disputes",
    needsResponseAlert: (n: number) =>
      `${n} dispute${n === 1 ? "" : "s"} require${n === 1 ? "s" : ""} your response`,
    emptyTitle: "No disputes — great news!",
    emptyBody: "No card disputes have been filed against your salon.",
    loading: "Loading disputes…",
    errorGeneric: "Could not load disputes. Please try again.",
    status: {
      needs_response: "Needs Response",
      under_review: "Under Review",
      won: "Won",
      lost: "Lost",
      warning_needs_response: "Action required",
      warning_closed: "Closed",
    },
    evidenceDueIn: (n: number) =>
      `${n} day${n === 1 ? "" : "s"} left to respond`,
    evidenceOverdue: "Response deadline passed",
    evidenceTitle: "Evidence Bundle",
    evidenceLoading: "Loading evidence…",
    evidenceError: "Could not load evidence. Please try again.",
    sectionConsent: "Policy Consent",
    sectionCharge: "Charge",
    sectionBooking: "Booking",
    sectionCustomer: "Customer",
    sectionNoShow: "No-Show Record",
    sectionNotifications: "Notifications Sent",
    noConsentWarning: "No consent on file — difficult to win without this",
    fields: {
      consentAt: "Agreed at",
      chargeAmount: "Amount",
      paymentRef: "Payment ref",
      service: "Service",
      staff: "Staff",
      time: "Time",
      bookingStatus: "Status",
      price: "Price",
      clientName: "Name",
      phone: "Phone",
      email: "Email",
      visitCount: "Visit count",
      noShowAt: "Marked at",
      noShowBy: "Marked by",
      notifType: "Type",
      notifChannel: "Channel",
      notifStatus: "Status",
      notifSentAt: "Sent at",
    },
    copyEvidence: "Copy evidence bundle",
    copiedEvidence: "Copied!",
    providerStripe: "Stripe",
    providerSquare: "Square",
    labelClient: "Client",
    labelAmount: "Amount",
    labelReason: "Reason",
    labelStatus: "Status",
    labelOpened: "Opened",
    labelEvidenceDue: "Evidence due",
    noInfo: "—",
  },
};
