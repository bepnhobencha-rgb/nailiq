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
  /** Marketing landing page (`/`) — full copy across all sections.
   * Wired through `useUserLanguage` so the EN/VI toggle in the nav
   * actually re-renders the page content. */
  landing: {
    nav: {
      signIn: string;
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
      /** B4 (QA 2026-05-13) — testimonial quotes were hardcoded
       *  EN strings in `LandingSocialProof.tsx`, so VI visitors
       *  saw English copy. Moving them to i18n so they participate
       *  in the locale switch. Two entries is the current count;
       *  add to the array to render more cards without touching
       *  the component. */
      quotes: ReadonlyArray<{
        initials: string;
        body: string;
        author: string;
        venue: string;
      }>;
    };
    trustStrip: {
      made: string;
      pipeda: string;
      freeToStart: string;
      bilingual: string;
    };
    pricing: {
      eyebrow: string;
      h2: string;
      sub: string;
      perMonth: string;
      taxNote: string;
      ccNotice: string;
      /** Migration note rendered under the Pro CTA (below `ccNotice`).
       *  Task #10 — pricing v2: "Switching from another tool? First 3
       *  months free." Calls out the migration discount inline so it
       *  doesn't get lost in the FAQ. */
      proMigrationNote: string;
      plans: ReadonlyArray<{
        /** "free" | "pro" | "studio" | "enterprise" — component keys on this
         *  for the Pro glow + Enterprise contact-CTA path. */
        id: string;
        name: string;
        price: string;
        /** Badge text (e.g. "Most Popular"). Null means no badge, but a spacer is rendered for vertical alignment. */
        badge: string | null;
        features: ReadonlyArray<string>;
        cta: string;
      }>;
      /** Add-ons rail rendered below the four pricing cards. Three cards:
       *  extra SMS credits, extra location, and the one-time branded
       *  digital-card design package. */
      addons: {
        sectionTitle: string;
        sms: { name: string; price: string; description: string };
        location: { name: string; price: string; description: string };
        branding: { name: string; price: string; description: string };
      };
    };
    /** FAQ accordion — addresses pre-purchase friction from
     *  salon owner conversations. Click each Q to reveal A. */
    faq: {
      eyebrow: string;
      h2: string;
      sub: string;
      items: ReadonlyArray<{ q: string; a: string }>;
      footerText: string;
      footerCta: string;
    };
    /** /contact page (extends from `landing.footer.contact` label). */
    contact: {
      pageTitle: string;
      lede: string;
      formHeading: string;
      nameLabel: string;
      namePlaceholder: string;
      emailLabel: string;
      emailPlaceholder: string;
      salonLabel: string;
      salonPlaceholder: string;
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
      /** Demo-request CTA box rendered below the form. */
      demoHeading: string;
      demoBody: string;
      demoCta: string;
      /** Direct-email fallback rendered below the demo CTA. */
      directEmailHeading: string;
      directEmailBody: string;
      backToHome: string;
    };
    finalCta: {
      eyebrow: string;
      h2: string;
      sub: string;
      ctaPrimary: string;
      ctaSecondary: string;
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
    /** Basic Mode — Front Desk Cockpit (per-device view toggle). */
    basicMode: {
      toggle: string;
      toggleOnAria: string;
      toggleOffAria: string;
      /** Page title shown in Basic Mode header. */
      pageTitle: string;
      nextActionHeading: string;
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
      actionAddWalkin: string;
      actionOpenParty: string;
      actionOpenBooking: string;
      // Critical alert texts
      alertOverdue: (n: number) => string;
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
      /** Short CTA in the header bar to open the add-walk-in panel. */
      addWalkinCta: string;
      addForm: {
        namePlaceholder: string;
        phonePlaceholder: string;
        notePlaceholder: string;
        addButton: string;
        incompleteHint: string;
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
        /** Task #04-D FIX 16 — warning when receptionist picks a
         *  staff with a group booking starting within
         *  `WALKIN_GROUP_BUFFER_MS` (30 min). `{name}` is the staff
         *  display name, `{time}` is the localized clock time. */
        walkinConflictsGroup: string;
        /** Affordance: keeps the staff selection and proceeds. */
        walkinContinueAnyway: string;
        /** Affordance: clears the staff back to Best-Match auto. */
        walkinChooseDifferent: string;
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
      monthly_booking_limit_reached: string;
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
      waive: string;
      cancel: string;
    };
    /** Grid lateness/tombstone labels. */
    latenessGrid: {
      /** Inline Start button aria-label and visible label. */
      startShort: string;
      /** "Auto no-show at {time}" for late/critical badge when auto is ON. */
      autoNoShowAt: (time: string) => string;
      /** Badge label when auto is OFF and tier=late. */
      late: string;
      /** Badge label when auto is OFF and tier=critical. */
      veryLate: string;
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
    returningOwnerEmailHint:
      "Returning owner? Enter your email to sign back in.",
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
    success: {
      title: "Your salon is live!",
      subtext:
        "You can take bookings immediately — share your link anywhere clients already message you.",
      slugAdjusted:
        "Your first-choice URL was taken, so we reserved {slug} for you.",
      callout:
        "Guests book on your page now — open it once to confirm everything feels right, then drop the link in Instagram or SMS.",
      salonOwnerLabel: "Salon owner",
      goToDashboard: "Go to Dashboard",
      dashboardHint:
        "If your profile isn't complete yet, the dashboard shows a setup checklist (services, staff, hours, address) before real bookings are recommended.",
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
      tryFree: "Try free",
      langAriaLabel: "Language",
      openMenu: "Open menu",
      closeMenu: "Close menu",
    },
    hero: {
      eyebrow: "Trusted by salons in Canada, the US & Vietnam",
      h1Line1: "Less than one manicure a month.",
      h1Gold: "Your salon runs itself.",
      subline:
        "Vietnamese-first. AI-powered. No missed bookings, ever.",
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
        // B2 (QA 2026-05-13) — landing claimed "Sign up with your
        // phone — OTP verification" but the prod register surface
        // ships email magic-link as the recommended path
        // (`smsEnabled=false` on the current SMS-disabled config).
        // Switching the headline + body so the landing matches the
        // experience the customer actually lands on.
        title: "Sign up with your email",
        body: "Instant access via magic link — no app, no password.",
        preview:
          "You’ll see — a sign-in link in your inbox, then your dashboard.",
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
          "Copy your nailiq.ca/your-salon URL. Send to clients via Zalo, SMS, or stick on the front desk.",
        preview: "You’ll see — your first booking land within hours.",
      },
      bottomCta: "Ready when you are. Try free for 14 days",
    },
    socialProof: {
      eyebrow: "Trusted By",
      h2: "What salon owners say",
      sub: "Early access feedback",
      quotes: [
        {
          initials: "LN",
          body:
            "Perfect for busy salons. We stopped losing walk-ins because the queue is right there on iPad. Front desk finally has a clear picture.",
          author: "Lan Nguyen, Owner",
          venue: "Nails by Lan · Toronto",
        },
        {
          initials: "TM",
          body:
            "Vietnamese support saved us. Our customers book themselves now in Vietnamese and our phone barely rings — in a good way.",
          author: "Thuy Mai, Owner",
          venue: "Saigon Nail Studio · Houston, TX",
        },
        {
          initials: "PN",
          body:
            "Setup took 10 minutes — I was skeptical but it really is that fast. The walk-in list is visible to everyone and the chaos at our front desk is finally gone.",
          author: "Phuong Nguyen, Owner",
          venue: "Pink Nails Studio · Vancouver, BC",
        },
        {
          initials: "JH",
          body:
            "The bilingual booking link changed everything. Our older Vietnamese clients who couldn't figure out our old system now book themselves without calling.",
          author: "Jennifer Ho, Owner",
          venue: "Lotus Nails · Calgary, AB",
        },
      ],
    },
    trustStrip: {
      made: "Made in Vancouver, BC 🇨🇦",
      pipeda: "PIPEDA Compliant",
      freeToStart: "Free to start — no card",
      bilingual: "Vietnamese & English",
    },
    pricing: {
      eyebrow: "Pricing",
      h2: "Simple, transparent pricing",
      sub: "No hidden fees. Upgrade or cancel anytime.",
      perMonth: "/month",
      taxNote: "+ GST/HST (and PST where applicable). Prices in CAD.",
      ccNotice: "No credit card required",
      proMigrationNote: "Switching from another tool? First 3 months free.",
      plans: [
        {
          id: "free",
          name: "Free",
          price: "$0",
          badge: null,
          features: [
            "1 staff member",
            "Up to 50 bookings/month",
            "Online booking link",
            "Walk-in queue",
            "Vietnamese & English",
            "AI Menu Scanner (setup only)",
          ],
          cta: "Get started free",
        },
        {
          id: "pro",
          name: "Pro",
          price: "$39",
          badge: "Most Popular",
          features: [
            "Everything in Free",
            "Unlimited bookings & staff",
            "Real-time receptionist center",
            "Smart AI Upsell",
            "Auto review requests",
            "Owner reports & analytics",
            "Cancel anytime",
          ],
          cta: "Start 14-day free trial",
        },
        {
          id: "studio",
          name: "Studio",
          price: "$99",
          badge: "Best Value",
          features: [
            "Everything in Pro",
            "AI Review Defense (1-click approve)",
            "Loyalty stamp cards & Gift Cards",
            "Staff performance reports",
            "CRM & client history",
            "SMS marketing (100 msgs/month)",
            "Priority support",
          ],
          cta: "Start 14-day free trial",
        },
        {
          id: "enterprise",
          name: "Enterprise",
          price: "$199",
          badge: "For Chains",
          features: [
            "Everything in Studio",
            "Voice AI (English + Vietnamese) (coming soon)",
            "Multi-location management",
            "Staff payroll & commission (coming soon)",
            "T4 tax export (coming soon)",
            "AI inventory management (coming soon)",
            "Unlimited SMS",
            "Dedicated onboarding",
          ],
          cta: "Contact us",
        },
      ],
      addons: {
        sectionTitle: "Need more? Add what you need.",
        sms: {
          name: "SMS Extra",
          price: "$20 / 500 messages",
          description: "Extra SMS credits for any plan",
        },
        location: {
          name: "Extra Location",
          price: "$49/month per location",
          description: "Add another salon location",
        },
        branding: {
          name: "Branded Digital Card",
          price: "$199 one-time",
          description: "Custom luxury branding package",
        },
      },
    },
    faq: {
      eyebrow: "FAQ",
      h2: "Questions salon owners ask before they switch",
      sub: "If your question isn't here, message us — we reply within one business day.",
      items: [
        {
          q: "Do I need to install an app?",
          a: "No. NailIQ runs in any web browser on phone, tablet, or laptop. Your customers also book without installing anything — they just open your booking link.",
        },
        {
          q: "Can I cancel anytime?",
          a: "Yes. No contract, no minimum term. Cancel from your dashboard and your subscription stops at the end of the current billing month.",
        },
        {
          q: "How long does setup take?",
          a: "About 15 minutes for most salons. Pre-loaded service templates and staff defaults speed it up — you just confirm what's already there and tweak prices.",
        },
        {
          q: "Does NailIQ support Vietnamese?",
          a: "Yes — the full owner and receptionist UI is bilingual EN/VN, and the customer-facing booking page auto-detects language. We're the only salon platform built Vietnamese-first.",
        },
        {
          q: "Are there transaction fees?",
          a: "No per-booking or per-customer fees. The monthly subscription is the only charge from NailIQ. If you accept card payments through a third party (Square, Stripe), their processing fees apply separately.",
        },
        {
          q: "Do customers need to download an app to book?",
          a: "No. Customers tap your booking link and book in the browser — works on iPhone, Android, and desktop without an install.",
        },
        {
          q: "Can I import my customers from Booksy or another tool?",
          a: "Yes — CSV import is supported. Email support@nailiq.ca with your export and we'll help you map the columns. For full migrations, the first 3 months are free.",
        },
        {
          q: "What happens if my internet is slow?",
          a: "The receptionist center caches recent bookings and walk-ins, so basic operations keep working through short outages. Heavy actions (creating a new booking, syncing edits) need a connection to complete.",
        },
      ],
      footerText: "Still have questions?",
      footerCta: "Contact us →",
    },
    contact: {
      pageTitle: "Contact us",
      lede:
        "Based in Vancouver, BC, Canada. We aim to respond within one business day.",
      formHeading: "Send us a message",
      nameLabel: "Your name",
      namePlaceholder: "Jane Nguyen",
      emailLabel: "Email",
      emailPlaceholder: "jane@yoursalon.com",
      salonLabel: "Salon name (optional)",
      salonPlaceholder: "Saigon Nail Studio",
      messageLabel: "Message",
      messagePlaceholder:
        "I'd love to learn how NailIQ handles walk-in queue during busy hours…",
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
      eyebrow: "One last thing",
      h2: "Replace your receptionist for less than $39/month.",
      sub:
        "14-day free trial. No credit card. Setup in 2 minutes.",
      ctaPrimary: "Start your free trial",
      ctaSecondary: "See how it works ↓",
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
    marketing: "Retention",
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
    signInOrSignUpSubtext: "Free 14 days · No credit card required · Ready in 2 minutes",
    orDivider: "or",
    continueWithGoogle: "Continue with Google",
    googleHelperText: "Fastest · No password needed",
    emailSectionLabel: "Sign in with email",
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
    forgotPasswordPageSubtitle: "Enter your email address and we'll send you a link to reset your password.",
    forgotPasswordSubmit: "Send reset link",
    forgotPasswordSubmitting: "Sending…",
    forgotPasswordSentTitle: "Check your inbox",
    forgotPasswordSentBody: "If an account exists with that email, we've sent a password reset link. Links expire in one hour.",
    forgotPasswordBackToSignIn: "Back to sign in",
    resetPasswordPageTitle: "Create a new password",
    resetPasswordNewPassword: "New password",
    resetPasswordConfirmPassword: "Confirm password",
    resetPasswordSubmit: "Set new password",
    resetPasswordSubmitting: "Setting password…",
    resetPasswordSuccess: "Password reset successfully. Redirecting to sign in…",
    resetPasswordMismatch: "Passwords don't match.",
    resetPasswordInvalidLink: "This reset link has expired. Request a new one.",
    resetPasswordServerError: "Something went wrong. Try again.",
    resetPasswordStrengthHint: "Password strength: ",
    brandTagline: "Smart salon management — built for you",
    brandBullet1: "Free 14 days · No credit card needed",
    brandBullet2: "Up and running in under 2 minutes",
    brandBullet3: "Made for Vietnamese-owned salons in North America",
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
      socialProof:
        "3 salons lost access this week from missing recovery email",
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
      readySubtitle: "Share your booking link with customers to receive your first booking",
      copyButton: "Copy link",
      copiedButton: "Copied!",
      openButton: "Open page",
      qrButton: "QR Code",
      qrModalTitle: "Booking QR Code",
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
      testErrorNoRecipients: "No recipients yet — add an email or enable owners/admins.",
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
    descriptionPlaceholder: "e.g. Long-lasting shine, perfectly shaped nails.",
    descriptionHint:
      "One line shown under the service name on your booking page. Leave blank and we'll write one for you.",
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
    staffCannotPerformService:
      "This staff member is not set up to perform that service.",
    staffLimitReached: "Free plan allows 3 staff. Upgrade to Pro for 10.",
    serviceLimitReached:
      "Free plan allows 10 services. Upgrade to Pro for 50.",
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
    removeStaff: "Remove staff",
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
    minServiceRequired:
      "You need more than one service before you can delete.",
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
    bannerSubtitle: "Take a photo of your price list and AI will fill in your services automatically.",
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
    reviewSub: "Select the services you'd like to import. You can edit prices and durations.",
    selectAll: "Select all",
    deselectAll: "Deselect all",
    priceLabel: "Price",
    durationLabel: "Min",
    importButton: "Import services",
    importButtonN: "Import {n} services",
    manualFallback: "Enter manually instead",
    errorVisionFailed: "Couldn't read the menu. Please try a clearer photo or enter manually.",
    errorNoServices: "No services found in this image. Try a closer photo of the price list.",
    errorPlanLimit: "You've reached your plan's service limit.",
    errorPayloadTooLarge: "Image is too large. Please resize to under 4MB and try again.",
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
    basicMode: {
      toggle: "Basic",
      toggleOnAria: "Switch to Basic Mode — simplified front-desk cockpit",
      toggleOffAria: "Exit Basic Mode — back to the full board",
      pageTitle: "Receptionist",
      nextActionHeading: "Next action",
      alertsHeading: "Needs attention",
      moreIssues: (n: number) => `+${n} more issue${n === 1 ? "" : "s"}`,
      longWaitGuest: (n: number) => `1 guest has waited over ${n} min`,
      finishOverdue: (n: number) =>
        n === 1 ? "1 booking is overdue — wrap up or extend" : `${n} bookings overdue — wrap up or extend`,
      assignWaiting: (n: number) =>
        n === 1
          ? "1 guest is waiting. Assign them to an available staff member."
          : `${n} guests are waiting. Assign the next guest to an available staff member.`,
      assignWaitingNamed: (name: string) =>
        `${name} is waiting. Assign them to an available staff member.`,
      prepareNext: (n: number) =>
        n === 1 ? "1 guest arriving in the next 30 min" : `${n} guests arriving in the next 30 min`,
      partyPendingNamed: (time: string, name: string) =>
        `Today ${time} group: ${name} has not confirmed`,
      partyPendingCount: (time: string, n: number) =>
        `Today ${time} group: ${n} guests pending`,
      suggestWalkin: (name: string) => `${name} is available. You can add a walk-in.`,
      actionOpenQueue: "Open queue",
      actionAddWalkin: "+ Walk-in",
      actionOpenParty: "Open party bookings",
      actionOpenBooking: "Open booking",
      alertOverdue: (n: number) =>
        n === 1 ? "1 booking overdue" : `${n} bookings overdue`,
      alertOverdueNamed: (name: string, time: string) =>
        `${name} overdue · ${time}`,
      alertNotStarted: (n: number) =>
        n === 1
          ? "1 guest overdue to start"
          : `${n} guests overdue to start`,
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
      pendingHelp: "Guests who haven't confirmed their name/phone via the group link.",
      slotsCount: (n: number) => `${n} slot${n !== 1 ? "s" : ""}`,
      waveLabel: (n: number) => `Wave ${n}`,
      copyLink: "Copy group link",
      copied: "✓ Copied!",
      statusConfirmed: "Confirmed",
      statusPending: "Pending",
      statusExpired: "Expired",
      cancelParty: "Cancel party",
      cancelConfirm: (n: number) => `Cancel all ${n} booking${n !== 1 ? "s" : ""} in this party?`,
      cancelConfirmYes: "Yes, cancel all",
      cancelConfirmNo: "Keep",
      cancelling: "Cancelling…",
      cancelError: "Couldn't cancel — please try again",
      notifyLabel: "Notify the organizer",
      notifySms: "SMS",
      notifyEmail: "Email",
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
      minutesAgo: (n: number) =>
        n < 1 ? "just now" : `${n} min wait`,
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
        incompleteHint: "Enter a name and pick a service to add",
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
        walkinConflictsGroup:
          "{name} has a group booking at {time}. Continue?",
        walkinContinueAnyway: "Continue anyway",
        walkinChooseDifferent: "Choose different staff",
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
      invited: "Invited",
      statusWaiting: "Waiting",
      claimed: "✅ Claimed",
      createBooking: "Create booking",
      empty: "No one on the waitlist",
      invitedToast: (name) => `Invited ${name} by SMS`,
      suppressedToast: (name) =>
        `Marked ${name} invited — SMS disabled in this environment`,
      errorToast: "Could not send the invite. Please try again.",
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
      closingLabel: "Close",
      conflictShake:
        "That slot overlaps another booking. Choose another slot or time.",
      rescheduleFailed: {
        past_date: "Can't move a booking into the past.",
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
      cancelUndoFailed: "Cannot undo — appointment already past or staff just booked.",
    },
    notify: {
      heading: "Notify customer",
      sms: "Text (SMS)",
      email: "Email",
      previewTitle: "Preview",
      willNotNotify: "Customer won't be notified.",
      noPhone: "no phone",
      noEmail: "no email",
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
      monthly_booking_limit_reached:
        "This salon hit its plan's monthly booking limit. Upgrade to continue.",
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
      sectionIntro:
        "Full client directory — search by name or phone number.",
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
          const parts = [`Hi ${firstName}! We'd love to see you again at Hi-Lite.`];
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
        bySource: "Bookings by source",
        empty: "No data in this range yet.",
        serviceCol: "Service",
        staffCol: "Staff",
        sourceCol: "Source",
        countCol: "Count",
        appointmentsCol: "Appointments",
        shareCol: "Share",
        revenueCol: "Revenue",
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
      usageText: "{used} / {cap} bookings this month. Upgrade to Pro to remove the cap.",
      upgradeCta: "Upgrade to Pro",
      manageCtaSettings: "Manage in Settings",
      upgradeError:
        "Couldn't start checkout. Try again from Settings → Billing.",
    },
    noShowFeeModal: {
      title: "No-show fee",
      desc: (amount: string) => `A fee of ${amount} is saved on this booking's card.`,
      charge: (amount: string) => `Charge ${amount} now`,
      waive: "Waive fee",
      cancel: "Cancel (mark no-show, decide later)",
    },
    latenessGrid: {
      startShort: "Start",
      autoNoShowAt: (time: string) => `Auto no-show at ${time}`,
      late: "Late",
      veryLate: "Very late",
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
