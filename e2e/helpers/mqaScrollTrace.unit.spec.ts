import { describe, expect, it } from "vitest";

import {
  MQA_0032_SURFACES,
  analyzeMqa0032ScrollTrace,
  type Mqa0032RuntimeMeasurement,
  type Mqa0032Surface,
} from "./mqaScrollTrace";

type SyntheticEvent = Record<string, unknown>;

const FRAME_COUNT = 132;
const FRAME_INTERVAL_US = 16_000;
const WINDOW_DURATION_US = 2_300_000;

function marker(name: string, ts: number): SyntheticEvent {
  return {
    name: "TimeStamp",
    cat: "devtools.timeline",
    ph: "I",
    ts,
    args: { data: { message: name } },
  };
}

function frame(
  ts: number,
  sequence: number,
  options?: {
    oldShape?: boolean;
    state?: string;
    affectsSmoothness?: boolean;
    scrollState?: string;
    frameSource?: number;
    traceId?: number;
  },
): SyntheticEvent {
  const reporter = {
    state: options?.state ?? "STATE_PRESENTED_ALL",
    affects_smoothness: options?.affectsSmoothness ?? false,
    scroll_state: options?.scrollState ?? "SCROLL_COMPOSITOR_THREAD",
    frame_source: options?.frameSource ?? 41,
    frame_sequence: sequence,
    ...(options?.traceId === undefined
      ? {}
      : {
          display_trace_id: options.traceId,
          surface_frame_trace_id: options.traceId,
        }),
    reason: "REASON_UNSPECIFIED",
    has_high_latency: false,
    has_missing_content: false,
  };
  return {
    name: "PipelineReporter",
    cat: "cc,benchmark",
    ph: "b",
    ts,
    id2: { local: String(sequence) },
    args: options?.oldShape
      ? { chrome_frame_reporter: reporter }
      : { frame_reporter: reporter },
  };
}

function surfaceEvents(
  surface: Mqa0032Surface,
  startUs: number,
  mutate?: (events: SyntheticEvent[]) => void,
): SyntheticEvent[] {
  const events: SyntheticEvent[] = [
    marker(`mqa-0032:${surface}:begin`, startUs),
  ];
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    events.push(
      frame(startUs + 20_000 + index * FRAME_INTERVAL_US, index + 1, {
        oldShape: surface === "queue",
      }),
    );
  }
  events.push(
    {
      name: "RunTask",
      cat: "disabled-by-default-devtools.timeline",
      ph: "X",
      ts: startUs + 500_000,
      dur: 51_000,
    },
    marker(`mqa-0032:${surface}:end`, startUs + WINDOW_DURATION_US),
  );
  mutate?.(events);
  return events;
}

function modernSurfaceEvents(
  surface: Mqa0032Surface,
  startUs: number,
): SyntheticEvent[] {
  const events: SyntheticEvent[] = [
    marker(`mqa-0032:${surface}:begin`, startUs),
  ];
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const ts = startUs + 20_000 + index * FRAME_INTERVAL_US;
    const traceId = 10_000 + index;
    events.push(
      frame(ts, index + 1, {
        scrollState: "SCROLL_NONE",
        traceId,
      }),
      {
        name: "EventLatency",
        cat: "cc,benchmark,input,input.scrolling",
        ph: "b",
        ts,
        args: {
          event_latency: {
            display_trace_id: traceId,
            event_latency_id: 20_000 + index,
            event_type: "FIRST_GESTURE_SCROLL_UPDATE",
            has_high_latency: false,
            is_janky_scrolled_frame: false,
            surface_frame_trace_id: traceId,
            vsync_interval_ms: 16,
          },
          scroll_jank_v4: { result_id: 30_000 + index },
        },
      },
      {
        name: "ScrollJankV4",
        cat: "cc,benchmark,input,input.scrolling",
        ph: "b",
        ts,
        args: {
          scroll_jank_v4: {
            damage_type: "DAMAGING",
            is_janky: false,
            result_id: 30_000 + index,
            updates: { first_scroll_update_type: "REAL" },
          },
        },
      },
      {
        name: "InputHandlerProxy::HandleGestureScrollUpdate_Result",
        cat: "input,input.scrolling",
        ph: "X",
        ts,
        args: {
          scroll_deltas: {
            did_overscroll_root: false,
            provided_to_compositor_delta_x: surface === "timeline" ? 32 : 0,
            provided_to_compositor_delta_y: surface === "queue" ? 64 : 0,
            trace_id: 20_000 + index,
            unused_delta_x: 0,
            unused_delta_y: 0,
          },
        },
      },
    );
  }
  events.push(marker(`mqa-0032:${surface}:end`, startUs + WINDOW_DURATION_US));
  return events;
}

function modernPassingInput() {
  return {
    rawTrace: {
      traceEvents: [
        ...modernSurfaceEvents("timeline", 1_000_000),
        ...modernSurfaceEvents("queue", 5_000_000),
      ],
    },
    runtimeMeasurements: MQA_0032_SURFACES.map(validRuntime),
  };
}

function validRuntime(
  surface: Mqa0032Surface,
): Mqa0032RuntimeMeasurement {
  return {
    surface,
    axis: surface === "timeline" ? "horizontal" : "vertical",
    sweeps: 3,
    dispatchedWheelEvents: 144,
    trustedWheelEvents: 144,
    scrollEvents: 120,
    maxReachablePx: 1_000,
    totalTravelPx: 4_000,
    minPositionPx: 0,
    maxPositionPx: 900,
    finalPositionPx: 0,
  };
}

function passingInput() {
  return {
    rawTrace: {
      traceEvents: [
        ...surfaceEvents("timeline", 1_000_000),
        ...surfaceEvents("queue", 5_000_000),
      ],
    },
    runtimeMeasurements: MQA_0032_SURFACES.map(validRuntime),
  };
}

describe("MQA-0032 raw Chrome scroll trace parser", () => {
  it("accepts old and new frame-reporter shapes with strict compositor proof", () => {
    const result = analyzeMqa0032ScrollTrace(passingInput());

    expect(result.result).toBe("PASS");
    expect(result.failures).toEqual([]);
    expect(result.surfaces.timeline.dominantCompositorFrames).toBe(FRAME_COUNT);
    expect(result.surfaces.queue.dominantCompositorFrames).toBe(FRAME_COUNT);
    expect(result.surfaces.timeline.p95FrameIntervalMs).toBe(16);
    expect(result.surfaces.queue.p95FrameIntervalMs).toBe(16);
    // Long tasks are retained as diagnostics. They are not accepted as a
    // replacement for compositor frame evidence and do not alone make a trace fail.
    expect(result.surfaces.timeline.longTaskCount).toBe(1);
  });

  it("accepts correlated Chromium headless ScrollJankV4 truth when PipelineReporter is SCROLL_NONE", () => {
    const result = analyzeMqa0032ScrollTrace(modernPassingInput());

    expect(result.result).toBe("PASS");
    expect(result.failures).toEqual([]);
    for (const surface of MQA_0032_SURFACES) {
      expect(result.surfaces[surface].scrollEvidenceSource).toBe(
        "scroll_jank_v4_event_latency",
      );
      expect(result.surfaces[surface].modernScrollFrames).toBe(FRAME_COUNT);
      expect(result.surfaces[surface].scrollJankFrames).toBe(FRAME_COUNT);
      expect(
        result.surfaces[surface].compositorConsumedScrollUpdates,
      ).toBe(FRAME_COUNT);
      expect(result.surfaces[surface].cadenceFrameCount).toBe(FRAME_COUNT);
      expect(result.surfaces[surface].p95FrameIntervalMs).toBe(16);
      expect(result.surfaces[surface].jankyScrollFrames).toBe(0);
    }
  });

  it("fails closed on incomplete, janky, or non-compositor modern scroll evidence", () => {
    const input = modernPassingInput();
    const traceEvents = (input.rawTrace as { traceEvents: SyntheticEvent[] })
      .traceEvents;
    const timelineLatency = traceEvents.find(
      (event) =>
        event.name === "EventLatency" && Number(event.ts) > 1_000_000,
    );
    const latency = (
      timelineLatency?.args as {
        event_latency: Record<string, unknown>;
      }
    ).event_latency;
    delete latency.vsync_interval_ms;

    const timelineJank = traceEvents.find(
      (event) =>
        event.name === "ScrollJankV4" && Number(event.ts) > 1_000_000,
    );
    const jank = (
      timelineJank?.args as {
        scroll_jank_v4: Record<string, unknown>;
      }
    ).scroll_jank_v4;
    jank.is_janky = true;
    jank.result_id = 999_999;

    const timelineCompositorResult = traceEvents.find(
      (event) =>
        event.name ===
          "InputHandlerProxy::HandleGestureScrollUpdate_Result" &&
        Number(event.ts) > 1_000_000,
    );
    const deltas = (
      timelineCompositorResult?.args as {
        scroll_deltas: Record<string, unknown>;
      }
    ).scroll_deltas;
    deltas.provided_to_compositor_delta_x = 0;
    deltas.trace_id = 888_888;

    const result = analyzeMqa0032ScrollTrace(input);
    expect(result.result).toBe("FAIL");
    expect(result.failures.join("\n")).toContain(
      "timeline: 1 modern scroll frames have incomplete EventLatency metadata",
    );
    expect(result.failures.join("\n")).toContain(
      "timeline: 1 scroll updates were not fully consumed by the compositor",
    );
    expect(result.failures.join("\n")).toContain(
      "timeline: EventLatency and ScrollJankV4 disagree on janky frame count",
    );
    expect(result.failures.join("\n")).toContain(
      "timeline: EventLatency and ScrollJankV4 result IDs do not correlate",
    );
    expect(result.failures.join("\n")).toContain(
      "timeline: EventLatency and compositor scroll result IDs do not correlate",
    );
  });

  it("rejects ambiguous trace-id correlation in the modern fallback", () => {
    const input = modernPassingInput();
    const traceEvents = (input.rawTrace as { traceEvents: SyntheticEvent[] })
      .traceEvents;
    const timelinePipeline = traceEvents.find(
      (event) =>
        event.name === "PipelineReporter" && Number(event.ts) > 1_000_000,
    );
    const reporter = (
      timelinePipeline?.args as {
        frame_reporter: Record<string, unknown>;
      }
    ).frame_reporter;
    reporter.frame_source = 99;

    const result = analyzeMqa0032ScrollTrace(input);
    expect(result.result).toBe("FAIL");
    expect(result.failures.join("\n")).toContain(
      "timeline: expected exactly one trace-id-correlated PipelineReporter source, found 2",
    );
  });

  it("fails closed when marker windows or compositor frames are absent", () => {
    const result = analyzeMqa0032ScrollTrace({
      rawTrace: { traceEvents: [] },
      runtimeMeasurements: MQA_0032_SURFACES.map(validRuntime),
    });

    expect(result.result).toBe("FAIL");
    expect(result.failures).toContain("raw trace contains no traceEvents");
    expect(result.failures.join("\n")).toContain(
      "timeline: no PipelineReporter events",
    );
    expect(result.failures.join("\n")).toContain(
      "queue: no active-scroll frame reporter events",
    );
  });

  it("rejects smoothness-affecting dropped and partial frames", () => {
    const input = passingInput();
    const traceEvents = (input.rawTrace as { traceEvents: SyntheticEvent[] })
      .traceEvents;
    const timelineFrame = traceEvents.find(
      (event) =>
        event.name === "PipelineReporter" &&
        Number(event.ts) > 1_000_000 &&
        Number(event.ts) < 3_000_000,
    );
    const queueFrame = traceEvents.find(
      (event) =>
        event.name === "PipelineReporter" && Number(event.ts) > 5_000_000,
    );
    const timelineReporter = (
      timelineFrame?.args as {
        frame_reporter: Record<string, unknown>;
      }
    ).frame_reporter;
    timelineReporter.state = "STATE_DROPPED";
    timelineReporter.affects_smoothness = true;
    const queueReporter = (
      queueFrame?.args as {
        chrome_frame_reporter: Record<string, unknown>;
      }
    ).chrome_frame_reporter;
    queueReporter.state = "STATE_PRESENTED_PARTIAL";
    queueReporter.affects_smoothness = true;

    const result = analyzeMqa0032ScrollTrace(input);
    expect(result.result).toBe("FAIL");
    expect(result.failures.join("\n")).toContain(
      "timeline: 1 smoothness-affecting dropped frames",
    );
    expect(result.failures.join("\n")).toContain(
      "queue: 1 smoothness-affecting partially-presented frames",
    );
  });

  it("rejects slow compositor intervals and an over-budget maximum gap", () => {
    const input = passingInput();
    const traceEvents = (input.rawTrace as { traceEvents: SyntheticEvent[] })
      .traceEvents;
    for (const event of traceEvents) {
      if (
        event.name === "PipelineReporter" &&
        Number(event.ts) > 1_000_000 &&
        Number(event.ts) < 3_000_000
      ) {
        const sequence = Number(
          (
            event.args as {
              frame_reporter: { frame_sequence: number };
            }
          ).frame_reporter.frame_sequence,
        );
        event.ts = 1_020_000 + (sequence - 1) * 25_000;
      }
    }
    // Keep the marker after every mutated frame.
    const timelineEnd = traceEvents.find(
      (event) =>
        (event.args as { data?: { message?: string } } | undefined)?.data
          ?.message === "mqa-0032:timeline:end",
    );
    if (timelineEnd) timelineEnd.ts = 4_500_000;

    const result = analyzeMqa0032ScrollTrace(input);
    expect(result.result).toBe("FAIL");
    expect(result.failures.join("\n")).toContain(
      "timeline: compositor frame p95 25ms exceeds 20ms",
    );

    const withGap = passingInput();
    const gapEvents = (withGap.rawTrace as { traceEvents: SyntheticEvent[] })
      .traceEvents;
    (withGap.rawTrace as { traceEvents: SyntheticEvent[] }).traceEvents =
      gapEvents.filter((event) => {
        const sequence = Number(
          (
            event.args as {
              frame_reporter?: { frame_sequence?: number };
            }
          )?.frame_reporter?.frame_sequence,
        );
        return !(
          event.name === "PipelineReporter" &&
          sequence >= 80 &&
          sequence <= 83
        );
      });
    const gapResult = analyzeMqa0032ScrollTrace(withGap);
    expect(gapResult.result).toBe("FAIL");
    expect(gapResult.failures.join("\n")).toContain(
      "timeline: compositor max gap",
    );
  });

  it("rejects synthetic/untrusted wheel claims even when the trace looks green", () => {
    const input = passingInput();
    input.runtimeMeasurements[0] = {
      ...input.runtimeMeasurements[0]!,
      trustedWheelEvents: 0,
      scrollEvents: 0,
      totalTravelPx: 0,
    };

    const result = analyzeMqa0032ScrollTrace(input);
    expect(result.result).toBe("FAIL");
    expect(result.failures.join("\n")).toContain(
      "timeline: runtime observed 0 trusted wheel events",
    );
    expect(result.failures.join("\n")).toContain(
      "timeline: runtime actual travel 0px",
    );
  });

  it("rejects unknown frame states instead of treating them as successful", () => {
    const input = passingInput();
    const traceEvents = (input.rawTrace as { traceEvents: SyntheticEvent[] })
      .traceEvents;
    const firstFrame = traceEvents.find(
      (event) => event.name === "PipelineReporter",
    );
    const reporter = (
      firstFrame?.args as {
        frame_reporter: Record<string, unknown>;
      }
    ).frame_reporter;
    reporter.state = "STATE_NEW_UNRECOGNIZED_VALUE";

    const result = analyzeMqa0032ScrollTrace(input);
    expect(result.result).toBe("FAIL");
    expect(result.failures.join("\n")).toContain(
      "timeline: unknown frame states: STATE_NEW_UNRECOGNIZED_VALUE",
    );
  });

  it("rejects short trace windows and duplicate runtime measurements", () => {
    const input = passingInput();
    const traceEvents = (input.rawTrace as { traceEvents: SyntheticEvent[] })
      .traceEvents;
    const timelineEnd = traceEvents.find(
      (event) =>
        (event.args as { data?: { message?: string } } | undefined)?.data
          ?.message === "mqa-0032:timeline:end",
    );
    if (timelineEnd) timelineEnd.ts = 2_500_000;
    input.runtimeMeasurements.push(validRuntime("timeline"));

    const result = analyzeMqa0032ScrollTrace(input);
    expect(result.result).toBe("FAIL");
    expect(result.failures.join("\n")).toContain(
      "timeline: marker window 1500ms is shorter than 2000ms",
    );
    expect(result.failures.join("\n")).toContain(
      "expected exactly 2 runtime measurements, received 3",
    );
  });

  it("rejects unknown scroll states and unclassified dropped frames", () => {
    const input = passingInput();
    const traceEvents = (input.rawTrace as { traceEvents: SyntheticEvent[] })
      .traceEvents;
    const timelineFrames = traceEvents.filter(
      (event) =>
        event.name === "PipelineReporter" &&
        Number(event.ts) > 1_000_000 &&
        Number(event.ts) < 3_000_000,
    );
    const unknownScrollReporter = (
      timelineFrames[0]?.args as {
        frame_reporter: Record<string, unknown>;
      }
    ).frame_reporter;
    unknownScrollReporter.scroll_state = "SCROLL_NEW_UNRECOGNIZED_VALUE";

    const unclassifiedDropReporter = (
      timelineFrames[1]?.args as {
        frame_reporter: Record<string, unknown>;
      }
    ).frame_reporter;
    unclassifiedDropReporter.state = "STATE_DROPPED";
    delete unclassifiedDropReporter.affects_smoothness;

    const result = analyzeMqa0032ScrollTrace(input);
    expect(result.result).toBe("FAIL");
    expect(result.failures.join("\n")).toContain(
      "timeline: 1 active frames have unknown scroll states",
    );
    expect(result.failures.join("\n")).toContain(
      "timeline: 1 dropped/partial frames are missing affects_smoothness",
    );
  });

  it("rejects the wrong axis and non-finite runtime values", () => {
    const input = passingInput();
    input.runtimeMeasurements[0] = {
      ...input.runtimeMeasurements[0]!,
      axis: "vertical",
      finalPositionPx: Number.NaN,
    };

    const result = analyzeMqa0032ScrollTrace(input);
    expect(result.result).toBe("FAIL");
    expect(result.failures.join("\n")).toContain(
      "timeline: runtime measured vertical; expected horizontal scrolling",
    );
    expect(result.failures.join("\n")).toContain(
      "timeline: runtime finalPositionPx must be a finite non-negative number",
    );
  });
});
