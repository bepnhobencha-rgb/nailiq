import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NotifyCustomerPanel } from "../NotifyCustomerPanel";

const labels = {
  heading: "Notify customer",
  sms: "Text (SMS)",
  email: "Email",
  previewTitle: "Preview",
  willNotNotify: "Customer won't be notified.",
  languageNote: "in English",
  noPhone: "no phone",
  noEmail: "no email",
  unavailable: "disabled in salon settings",
};

describe("NotifyCustomerPanel", () => {
  it("disables a salon-blocked SMS channel even when the form value is on", () => {
    const html = renderToStaticMarkup(
      createElement(NotifyCustomerPanel, {
        value: { sms: true, email: true },
        onChange: () => undefined,
        hasPhone: true,
        hasEmail: true,
        availability: { sms: false, email: true },
        previewText: "Your appointment is confirmed.",
        labels,
      }),
    );

    const smsButton = html.match(
      /<button[^>]*data-testid="notify-toggle-sms"[^>]*>/,
    )?.[0];
    const emailButton = html.match(
      /<button[^>]*data-testid="notify-toggle-email"[^>]*>/,
    )?.[0];

    expect(smsButton).toContain('aria-checked="false"');
    expect(smsButton).toContain("disabled");
    expect(emailButton).toContain('aria-checked="true"');
    expect(emailButton).not.toContain("disabled");
    expect(html).toContain("disabled in salon settings");
  });
});
