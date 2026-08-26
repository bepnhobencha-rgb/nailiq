import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CalendarViewModeControl } from "../CalendarViewModeControl";
import { ShellV2DateNavigator } from "../ShellV2DateNavigator";

describe("Shell V2 mobile date controls", () => {
  it("anchors the view menu inside a narrow viewport and keeps every label visible", () => {
    const html = renderToStaticMarkup(
      createElement(CalendarViewModeControl, {
        value: "day",
        labels: {
          ariaLabel: "View mode",
          day: "Day",
          week: "Week",
          month: "Month",
        },
        language: "en",
        onChange: vi.fn(),
      }),
    );

    expect(html).toContain(
      'data-testid="shell-v2-calendar-view-menu" class="absolute left-0',
    );
    expect(html).toContain("sm:left-auto sm:right-0");
    expect(html).toContain(">Day</button>");
    expect(html).toContain(">Week</button>");
    expect(html).toContain(">Month</button>");
  });

  it("renders a compact phone label while preserving the full accessible date", () => {
    const html = renderToStaticMarkup(
      createElement(ShellV2DateNavigator, {
        mode: "day",
        dayYmd: "2026-08-26",
        weekMondayYmd: "2026-08-24",
        monthFirstYmd: "2026-08-01",
        todayYmd: "2026-08-26",
        language: "en",
        labels: {
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
        onPrevious: vi.fn(),
        onNext: vi.fn(),
        onCurrent: vi.fn(),
        onSelectDate: vi.fn(),
      }),
    );

    expect(html).toContain(
      'aria-label="Choose date: Wednesday, August 26, 2026"',
    );
    expect(html).toContain(
      'data-testid="shell-v2-date-label-compact" class="truncate text-xs font-semibold capitalize sm:hidden" aria-hidden="true">Wed, Aug 26</span>',
    );
    expect(html).toContain(
      'data-testid="shell-v2-date-label-full" class="hidden truncate text-sm font-semibold capitalize sm:inline">Wednesday, August 26, 2026</span>',
    );
  });
});
