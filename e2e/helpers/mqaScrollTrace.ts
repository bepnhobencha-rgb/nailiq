export const MQA_0032_SURFACES = ["timeline", "queue"] as const;

export type Mqa0032Surface = (typeof MQA_0032_SURFACES)[number];
export type Mqa0032Axis = "horizontal" | "vertical";

export const MQA_0032_THRESHOLDS = {
  requiredSweeps: 3,
  minMarkerWindowMs: 2_000,
  minDispatchedWheelEvents: 120,
  minTrustedWheelEvents: 72,
  minScrollEvents: 30,
  minReachableDistancePx: 600,
  minTravelDistancePx: 1_200,
  minActiveCompositorFrames: 90,
  maxP95FrameIntervalMs: 20,
  maxFrameGapMs: 50,
  maxSmoothnessAffectingDroppedFrames: 0,
  maxSmoothnessAffectingPartialFrames: 0,
} as const;

export type Mqa0032RuntimeMeasurement = {
  surface: Mqa0032Surface;
  axis: Mqa0032Axis;
  sweeps: number;
  dispatchedWheelEvents: number;
  trustedWheelEvents: number;
  scrollEvents: number;
  maxReachablePx: number;
  totalTravelPx: number;
  minPositionPx: number;
  maxPositionPx: number;
  finalPositionPx: number;
};

type TraceEvent = {
  name?: unknown;
  cat?: unknown;
  ph?: unknown;
  ts?: unknown;
  dur?: unknown;
  pid?: unknown;
  tid?: unknown;
  id?: unknown;
  id2?: unknown;
  args?: unknown;
};

type FrameReporter = {
  state: string | null;
  affectsSmoothness: boolean | null;
  scrollState: string | null;
  frameSource: string | null;
  frameSequence: string | null;
  displayTraceId: string | null;
  surfaceFrameTraceId: string | null;
  reason: string | null;
  hasHighLatency: boolean | null;
  hasMissingContent: boolean | null;
};

type ActiveFrame = FrameReporter & {
  ts: number;
};

type ModernScrollFrame = {
  ts: number;
  eventLatencyId: string | null;
  displayTraceId: string | null;
  surfaceFrameTraceId: string | null;
  resultId: string | null;
  vsyncIntervalMs: number | null;
  hasHighLatency: boolean | null;
  isJanky: boolean | null;
};

type ScrollJankFrame = {
  ts: number;
  resultId: string | null;
  damageType: string | null;
  firstScrollUpdateType: string | null;
  isJanky: boolean | null;
};

type CompositorScrollUpdate = {
  ts: number;
  traceId: string | null;
  providedDeltaX: number | null;
  providedDeltaY: number | null;
  unusedDeltaX: number | null;
  unusedDeltaY: number | null;
  didOverscrollRoot: boolean | null;
};

export type Mqa0032SurfaceTraceSummary = {
  surface: Mqa0032Surface;
  scrollEvidenceSource:
    | "pipeline_reporter"
    | "scroll_jank_v4_event_latency"
    | null;
  markerStartUs: number | null;
  markerEndUs: number | null;
  markerDurationMs: number | null;
  pipelineReporterEvents: number;
  pipelineReporterScrollNoneFrames: number;
  cadenceFrameCount: number;
  modernScrollFrames: number;
  scrollJankFrames: number;
  jankyScrollFrames: number;
  compositorConsumedScrollUpdates: number;
  activeScrollFrames: number;
  compositorScrollFrames: number;
  mainThreadScrollFrames: number;
  rasterScrollFrames: number;
  unknownScrollFrames: number;
  dominantFrameSource: string | null;
  dominantCompositorFrames: number;
  presentedAllFrames: number;
  noUpdateDesiredFrames: number;
  partialFrames: number;
  droppedFrames: number;
  smoothnessAffectingPartialFrames: number;
  smoothnessAffectingDroppedFrames: number;
  highLatencyFrames: number;
  missingContentFrames: number;
  unknownFrameStates: string[];
  unclassifiedSmoothnessFrames: number;
  p50FrameIntervalMs: number | null;
  p95FrameIntervalMs: number | null;
  maxFrameGapMs: number | null;
  longTaskCount: number;
  longTaskTotalMs: number;
  longestTaskMs: number;
  layoutEventCount: number;
  paintEventCount: number;
  tracedWheelOrGestureEvents: number;
};

export type Mqa0032TraceAnalysis = {
  result: "PASS" | "FAIL";
  thresholds: typeof MQA_0032_THRESHOLDS;
  traceEventCount: number;
  runtime: Record<Mqa0032Surface, Mqa0032RuntimeMeasurement>;
  surfaces: Record<Mqa0032Surface, Mqa0032SurfaceTraceSummary>;
  failures: string[];
  diagnostics: string[];
};

const KNOWN_FRAME_STATES = new Set([
  "STATE_NO_UPDATE_DESIRED",
  "STATE_PRESENTED_ALL",
  "STATE_PRESENTED_PARTIAL",
  "STATE_DROPPED",
]);

const COMPOSITOR_SCROLL_STATES = new Set([
  "SCROLL_COMPOSITOR_THREAD",
  // Newer Chromium traces can report raster-owned scrolling separately.
  "SCROLL_RASTER",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nested(
  value: unknown,
  path: readonly string[],
): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function traceEventsFrom(rawTrace: unknown): TraceEvent[] {
  const candidate = Array.isArray(rawTrace)
    ? rawTrace
    : isRecord(rawTrace)
      ? rawTrace.traceEvents
      : undefined;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(isRecord);
}

function markerMessage(event: TraceEvent): string | null {
  if (event.name === "TimeStamp") {
    return (
      asString(nested(event.args, ["data", "message"])) ??
      asString(nested(event.args, ["message"]))
    );
  }
  if (
    typeof event.cat === "string" &&
    event.cat.includes("blink.user_timing")
  ) {
    return asString(event.name);
  }
  return null;
}

function markerTimestamp(
  events: readonly TraceEvent[],
  marker: string,
  failures: string[],
): number | null {
  const matches = events.filter((event) => markerMessage(event) === marker);
  if (matches.length !== 1) {
    failures.push(
      `${marker}: expected exactly one trace marker, found ${matches.length}`,
    );
    return null;
  }
  const ts = asFiniteNumber(matches[0]?.ts);
  if (ts === null) {
    failures.push(`${marker}: marker timestamp is missing or non-finite`);
  }
  return ts;
}

function extractFrameReporter(event: TraceEvent): FrameReporter | null {
  if (event.name !== "PipelineReporter") return null;
  // PipelineReporter is a nestable async event. Only the begin event owns the
  // reporter metadata; accepting end events would double-count frames.
  if (event.ph !== "b" && event.ph !== "S") return null;

  const reporterCandidate =
    nested(event.args, ["frame_reporter"]) ??
    nested(event.args, ["chrome_frame_reporter"]) ??
    nested(event.args, ["data", "frame_reporter"]) ??
    nested(event.args, ["data", "chrome_frame_reporter"]);
  if (!isRecord(reporterCandidate)) return null;

  return {
    state: asString(reporterCandidate.state),
    affectsSmoothness: asBoolean(reporterCandidate.affects_smoothness),
    scrollState: asString(reporterCandidate.scroll_state),
    frameSource: asString(reporterCandidate.frame_source),
    frameSequence: asString(reporterCandidate.frame_sequence),
    displayTraceId: asString(reporterCandidate.display_trace_id),
    surfaceFrameTraceId: asString(reporterCandidate.surface_frame_trace_id),
    reason: asString(reporterCandidate.reason),
    hasHighLatency: asBoolean(reporterCandidate.has_high_latency),
    hasMissingContent: asBoolean(reporterCandidate.has_missing_content),
  };
}

const MODERN_SCROLL_UPDATE_TYPES = new Set([
  "FIRST_GESTURE_SCROLL_UPDATE",
  "GESTURE_SCROLL_UPDATE",
]);

function extractModernScrollFrame(event: TraceEvent): ModernScrollFrame | null {
  if (event.name !== "EventLatency") return null;
  if (event.ph !== "b" && event.ph !== "S") return null;
  const eventLatency = nested(event.args, ["event_latency"]);
  if (!isRecord(eventLatency)) return null;
  const eventType = asString(eventLatency.event_type);
  if (!MODERN_SCROLL_UPDATE_TYPES.has(eventType ?? "")) return null;
  const ts = asFiniteNumber(event.ts);
  if (ts === null) return null;
  return {
    ts,
    eventLatencyId: asString(eventLatency.event_latency_id),
    displayTraceId: asString(eventLatency.display_trace_id),
    surfaceFrameTraceId: asString(eventLatency.surface_frame_trace_id),
    resultId: asString(nested(event.args, ["scroll_jank_v4", "result_id"])),
    vsyncIntervalMs: asFiniteNumber(eventLatency.vsync_interval_ms),
    hasHighLatency: asBoolean(eventLatency.has_high_latency),
    isJanky: asBoolean(eventLatency.is_janky_scrolled_frame),
  };
}

function extractScrollJankFrame(event: TraceEvent): ScrollJankFrame | null {
  if (event.name !== "ScrollJankV4") return null;
  if (event.ph !== "b" && event.ph !== "S") return null;
  const scrollJank = nested(event.args, ["scroll_jank_v4"]);
  const ts = asFiniteNumber(event.ts);
  if (!isRecord(scrollJank) || ts === null) return null;
  return {
    ts,
    resultId: asString(scrollJank.result_id),
    damageType: asString(scrollJank.damage_type),
    firstScrollUpdateType: asString(
      nested(scrollJank, ["updates", "first_scroll_update_type"]),
    ),
    isJanky: asBoolean(scrollJank.is_janky),
  };
}

function extractCompositorScrollUpdate(
  event: TraceEvent,
): CompositorScrollUpdate | null {
  if (event.name !== "InputHandlerProxy::HandleGestureScrollUpdate_Result") {
    return null;
  }
  const deltas = nested(event.args, ["scroll_deltas"]);
  const ts = asFiniteNumber(event.ts);
  if (!isRecord(deltas) || ts === null) return null;
  return {
    ts,
    traceId: asString(deltas.trace_id),
    providedDeltaX: asFiniteNumber(deltas.provided_to_compositor_delta_x),
    providedDeltaY: asFiniteNumber(deltas.provided_to_compositor_delta_y),
    unusedDeltaX: asFiniteNumber(deltas.unused_delta_x),
    unusedDeltaY: asFiniteNumber(deltas.unused_delta_y),
    didOverscrollRoot: asBoolean(deltas.did_overscroll_root),
  };
}

function percentileNearestRank(
  values: readonly number[],
  percentile: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1] ?? null;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function frameIntervalsMs(frames: readonly ActiveFrame[]): number[] {
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const intervals: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (!previous || !current) continue;
    const deltaMs = (current.ts - previous.ts) / 1_000;
    if (Number.isFinite(deltaMs) && deltaMs > 0) intervals.push(deltaMs);
  }
  return intervals;
}

function dominantCompositorSequence(frames: readonly ActiveFrame[]): {
  source: string | null;
  frames: ActiveFrame[];
} {
  const bySource = new Map<string, ActiveFrame[]>();
  for (const frame of frames) {
    if (!COMPOSITOR_SCROLL_STATES.has(frame.scrollState ?? "")) continue;
    if (frame.frameSource === null || frame.frameSequence === null) continue;
    const group = bySource.get(frame.frameSource) ?? [];
    // Forked/backfill reporter rows can repeat the same sequence. Keep one row
    // per source+sequence so zero-length duplicate intervals cannot fake p95.
    if (!group.some((candidate) => candidate.frameSequence === frame.frameSequence)) {
      group.push(frame);
      bySource.set(frame.frameSource, group);
    }
  }

  let dominantSource: string | null = null;
  let dominantFrames: ActiveFrame[] = [];
  for (const [source, sourceFrames] of bySource) {
    if (sourceFrames.length > dominantFrames.length) {
      dominantSource = source;
      dominantFrames = sourceFrames;
    }
  }
  return { source: dominantSource, frames: dominantFrames };
}

function frameSequenceForSource(
  frames: readonly ActiveFrame[],
  source: string,
): ActiveFrame[] {
  const sequences = new Set<string>();
  const result: ActiveFrame[] = [];
  for (const frame of frames) {
    if (frame.frameSource !== source || frame.frameSequence === null) continue;
    if (sequences.has(frame.frameSequence)) continue;
    sequences.add(frame.frameSequence);
    result.push(frame);
  }
  return result;
}

function sameStringMultiset(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of right) {
    const count = counts.get(value);
    if (!count) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return counts.size === 0;
}

function eventDurationMs(event: TraceEvent): number | null {
  const durationUs = asFiniteNumber(event.dur);
  return durationUs === null ? null : durationUs / 1_000;
}

function analyzeSurface(
  events: readonly TraceEvent[],
  surface: Mqa0032Surface,
  failures: string[],
): Mqa0032SurfaceTraceSummary {
  const markerStartUs = markerTimestamp(
    events,
    `mqa-0032:${surface}:begin`,
    failures,
  );
  const markerEndUs = markerTimestamp(
    events,
    `mqa-0032:${surface}:end`,
    failures,
  );
  if (
    markerStartUs !== null &&
    markerEndUs !== null &&
    markerEndUs <= markerStartUs
  ) {
    failures.push(`${surface}: end marker must be after begin marker`);
  }

  const inside = (event: TraceEvent): boolean => {
    const ts = asFiniteNumber(event.ts);
    return (
      ts !== null &&
      markerStartUs !== null &&
      markerEndUs !== null &&
      ts >= markerStartUs &&
      ts <= markerEndUs
    );
  };
  const windowEvents = events.filter(inside);
  const pipelineReporterEvents = windowEvents.filter(
    (event) => event.name === "PipelineReporter",
  ).length;
  const pipelineFrames: ActiveFrame[] = [];
  for (const event of windowEvents) {
    const reporter = extractFrameReporter(event);
    const ts = asFiniteNumber(event.ts);
    if (!reporter || ts === null) continue;
    pipelineFrames.push({ ...reporter, ts });
  }
  const pipelineReporterScrollNoneFrames = pipelineFrames.filter(
    (frame) => frame.scrollState === "SCROLL_NONE",
  ).length;
  const activeFrames = pipelineFrames.filter(
    (frame) => frame.scrollState !== "SCROLL_NONE",
  );

  const compositorFrames = activeFrames.filter((frame) =>
    COMPOSITOR_SCROLL_STATES.has(frame.scrollState ?? ""),
  );
  const mainThreadFrames = activeFrames.filter(
    (frame) => frame.scrollState === "SCROLL_MAIN_THREAD",
  );
  const rasterFrames = activeFrames.filter(
    (frame) => frame.scrollState === "SCROLL_RASTER",
  );
  const unknownScrollFrames = activeFrames.filter(
    (frame) =>
      frame.scrollState !== "SCROLL_MAIN_THREAD" &&
      !COMPOSITOR_SCROLL_STATES.has(frame.scrollState ?? ""),
  );
  const legacyDominant = dominantCompositorSequence(compositorFrames);

  const modernFrames = windowEvents
    .map(extractModernScrollFrame)
    .filter((frame): frame is ModernScrollFrame => frame !== null);
  const scrollJankFrames = windowEvents
    .map(extractScrollJankFrame)
    .filter((frame): frame is ScrollJankFrame => frame !== null);
  const compositorUpdates = windowEvents
    .map(extractCompositorScrollUpdate)
    .filter((update): update is CompositorScrollUpdate => update !== null);
  const validModernFrames = modernFrames.filter(
    (frame) =>
      frame.eventLatencyId !== null &&
      frame.displayTraceId !== null &&
      frame.surfaceFrameTraceId !== null &&
      frame.resultId !== null &&
      frame.vsyncIntervalMs !== null &&
      frame.vsyncIntervalMs > 0 &&
      frame.hasHighLatency !== null &&
      frame.isJanky !== null,
  );
  const validScrollJankFrames = scrollJankFrames.filter(
    (frame) =>
      frame.resultId !== null &&
      frame.damageType === "DAMAGING" &&
      frame.firstScrollUpdateType === "REAL" &&
      frame.isJanky !== null,
  );
  const validCompositorUpdates = compositorUpdates.filter(
    (update) =>
      update.traceId !== null &&
      update.providedDeltaX !== null &&
      update.providedDeltaY !== null &&
      update.unusedDeltaX !== null &&
      update.unusedDeltaY !== null &&
      update.didOverscrollRoot !== null,
  );
  const compositorConsumedUpdates = validCompositorUpdates.filter(
    (update) =>
      Math.abs(update.providedDeltaX ?? 0) +
          Math.abs(update.providedDeltaY ?? 0) >
        0 &&
      update.unusedDeltaX === 0 &&
      update.unusedDeltaY === 0 &&
      update.didOverscrollRoot === false,
  );
  // Chromium 147 headless emits an authoritative ScrollJankV4/EventLatency
  // stream while leaving every PipelineReporter.scroll_state as SCROLL_NONE.
  // Use that modern stream only when the legacy field is uniformly NONE, and
  // retain PipelineReporter solely for cadence from the trace-id-correlated
  // renderer source. Any incomplete or ambiguous correlation fails below.
  const useModernScrollEvidence =
    activeFrames.length === 0 &&
    pipelineFrames.length > 0 &&
    pipelineReporterScrollNoneFrames === pipelineFrames.length &&
    modernFrames.length > 0;
  let scrollEvidenceSource: Mqa0032SurfaceTraceSummary["scrollEvidenceSource"] =
    activeFrames.length > 0 ? "pipeline_reporter" : null;
  let dominantFrameSource = legacyDominant.source;
  let dominantCompositorFrames = legacyDominant.frames.length;
  let cadenceFrames = legacyDominant.frames;
  let activeScrollFrameCount = activeFrames.length;
  let compositorScrollFrameCount = compositorFrames.length;
  let presentedAllFrames = activeFrames.filter(
    (frame) => frame.state === "STATE_PRESENTED_ALL",
  ).length;
  let noUpdateDesiredFrames = activeFrames.filter(
    (frame) => frame.state === "STATE_NO_UPDATE_DESIRED",
  ).length;
  let partialFrames = activeFrames.filter(
    (frame) => frame.state === "STATE_PRESENTED_PARTIAL",
  ).length;
  let droppedFrames = activeFrames.filter(
    (frame) => frame.state === "STATE_DROPPED",
  ).length;
  let smoothnessAffectingPartialFrames = activeFrames.filter(
    (frame) =>
      frame.state === "STATE_PRESENTED_PARTIAL" &&
      frame.affectsSmoothness === true,
  ).length;
  let smoothnessAffectingDroppedFrames = activeFrames.filter(
    (frame) =>
      frame.state === "STATE_DROPPED" && frame.affectsSmoothness === true,
  ).length;
  let highLatencyFrames = activeFrames.filter(
    (frame) => frame.hasHighLatency === true,
  ).length;
  let missingContentFrames = activeFrames.filter(
    (frame) => frame.hasMissingContent === true,
  ).length;
  let modernCorrelatedSourceCount = 0;

  if (useModernScrollEvidence) {
    scrollEvidenceSource = "scroll_jank_v4_event_latency";
    const surfaceTraceIds = new Set(
      validModernFrames.map((frame) => frame.surfaceFrameTraceId),
    );
    const displayTraceIds = new Set(
      validModernFrames.map((frame) => frame.displayTraceId),
    );
    const correlatedSources = new Set(
      pipelineFrames
        .filter(
          (frame) =>
            (frame.surfaceFrameTraceId !== null &&
              surfaceTraceIds.has(frame.surfaceFrameTraceId)) ||
            (frame.displayTraceId !== null &&
              displayTraceIds.has(frame.displayTraceId)),
        )
        .map((frame) => frame.frameSource)
        .filter((source): source is string => source !== null),
    );
    modernCorrelatedSourceCount = correlatedSources.size;
    if (correlatedSources.size === 1) {
      dominantFrameSource = correlatedSources.values().next().value ?? null;
      if (dominantFrameSource !== null) {
        cadenceFrames = frameSequenceForSource(
          pipelineFrames,
          dominantFrameSource,
        );
      }
    } else {
      dominantFrameSource = null;
      cadenceFrames = [];
    }
    activeScrollFrameCount = validModernFrames.length;
    compositorScrollFrameCount = compositorConsumedUpdates.length;
    dominantCompositorFrames = validModernFrames.length;
    const modernJankyFrames = validModernFrames.filter(
      (frame) => frame.isJanky === true,
    ).length;
    const scrollJankMarkedFrames = validScrollJankFrames.filter(
      (frame) => frame.isJanky === true,
    ).length;
    presentedAllFrames = validModernFrames.length - modernJankyFrames;
    noUpdateDesiredFrames = 0;
    partialFrames = 0;
    droppedFrames = Math.max(modernJankyFrames, scrollJankMarkedFrames);
    smoothnessAffectingPartialFrames = 0;
    smoothnessAffectingDroppedFrames = droppedFrames;
    highLatencyFrames = validModernFrames.filter(
      (frame) => frame.hasHighLatency === true,
    ).length;
    missingContentFrames = 0;
  }

  const intervalsMs = frameIntervalsMs(cadenceFrames);
  const p50FrameIntervalMs = percentileNearestRank(intervalsMs, 0.5);
  const p95FrameIntervalMs = percentileNearestRank(intervalsMs, 0.95);
  const maxFrameGapMs =
    intervalsMs.length > 0 ? Math.max(...intervalsMs) : null;

  const stateFrames = useModernScrollEvidence ? cadenceFrames : activeFrames;
  const unknownFrameStates = Array.from(
    new Set(
      stateFrames
        .map((frame) => frame.state ?? "<missing>")
        .filter((state) => !KNOWN_FRAME_STATES.has(state)),
    ),
  ).sort();
  const unclassifiedSmoothnessFrames = useModernScrollEvidence
    ? 0
    : activeFrames.filter(
        (frame) =>
          (frame.state === "STATE_DROPPED" ||
            frame.state === "STATE_PRESENTED_PARTIAL") &&
          frame.affectsSmoothness === null,
      ).length;

  const longTasks = windowEvents
    .filter(
      (event) =>
        event.name === "RunTask" &&
        typeof event.cat === "string" &&
        event.cat.includes("devtools.timeline"),
    )
    .map(eventDurationMs)
    .filter((duration): duration is number => duration !== null && duration >= 50);

  const summary: Mqa0032SurfaceTraceSummary = {
    surface,
    scrollEvidenceSource,
    markerStartUs,
    markerEndUs,
    markerDurationMs:
      markerStartUs !== null && markerEndUs !== null
        ? round((markerEndUs - markerStartUs) / 1_000)
        : null,
    pipelineReporterEvents,
    pipelineReporterScrollNoneFrames,
    cadenceFrameCount: cadenceFrames.length,
    modernScrollFrames: validModernFrames.length,
    scrollJankFrames: validScrollJankFrames.length,
    jankyScrollFrames: validScrollJankFrames.filter(
      (frame) => frame.isJanky === true,
    ).length,
    compositorConsumedScrollUpdates: compositorConsumedUpdates.length,
    activeScrollFrames: activeScrollFrameCount,
    compositorScrollFrames: compositorScrollFrameCount,
    mainThreadScrollFrames: mainThreadFrames.length,
    rasterScrollFrames: rasterFrames.length,
    unknownScrollFrames: unknownScrollFrames.length,
    dominantFrameSource,
    dominantCompositorFrames,
    presentedAllFrames,
    noUpdateDesiredFrames,
    partialFrames,
    droppedFrames,
    smoothnessAffectingPartialFrames,
    smoothnessAffectingDroppedFrames,
    highLatencyFrames,
    missingContentFrames,
    unknownFrameStates,
    unclassifiedSmoothnessFrames,
    p50FrameIntervalMs:
      p50FrameIntervalMs === null ? null : round(p50FrameIntervalMs),
    p95FrameIntervalMs:
      p95FrameIntervalMs === null ? null : round(p95FrameIntervalMs),
    maxFrameGapMs: maxFrameGapMs === null ? null : round(maxFrameGapMs),
    longTaskCount: longTasks.length,
    longTaskTotalMs: round(longTasks.reduce((sum, value) => sum + value, 0)),
    longestTaskMs: round(longTasks.length > 0 ? Math.max(...longTasks) : 0),
    layoutEventCount: windowEvents.filter((event) => event.name === "Layout")
      .length,
    paintEventCount: windowEvents.filter((event) => event.name === "Paint")
      .length,
    tracedWheelOrGestureEvents: windowEvents.filter((event) => {
      const name = asString(event.name) ?? "";
      const serializedArgs = JSON.stringify(event.args ?? {});
      return /MouseWheel|GestureScroll/i.test(`${name} ${serializedArgs}`);
    }).length,
  };

  if (pipelineReporterEvents === 0) {
    failures.push(`${surface}: no PipelineReporter events in marker window`);
  }
  if (
    summary.markerDurationMs !== null &&
    summary.markerDurationMs < MQA_0032_THRESHOLDS.minMarkerWindowMs
  ) {
    failures.push(
      `${surface}: marker window ${summary.markerDurationMs}ms is shorter than ` +
        `${MQA_0032_THRESHOLDS.minMarkerWindowMs}ms`,
    );
  }
  if (summary.activeScrollFrames === 0) {
    failures.push(`${surface}: no active-scroll frame reporter events`);
  }
  if (useModernScrollEvidence) {
    const invalidModernFrames = modernFrames.length - validModernFrames.length;
    const invalidScrollJankFrames =
      scrollJankFrames.length - validScrollJankFrames.length;
    const invalidCompositorUpdates =
      compositorUpdates.length - validCompositorUpdates.length;
    if (invalidModernFrames > 0) {
      failures.push(
        `${surface}: ${invalidModernFrames} modern scroll frames have incomplete EventLatency metadata`,
      );
    }
    if (invalidScrollJankFrames > 0) {
      failures.push(
        `${surface}: ${invalidScrollJankFrames} ScrollJankV4 frames are not real damaging scroll updates with complete jank metadata`,
      );
    }
    if (invalidCompositorUpdates > 0) {
      failures.push(
        `${surface}: ${invalidCompositorUpdates} compositor scroll results have incomplete delta metadata`,
      );
    }
    if (
      validModernFrames.length !== validScrollJankFrames.length ||
      validModernFrames.length !== validCompositorUpdates.length
    ) {
      failures.push(
        `${surface}: modern scroll evidence counts disagree ` +
          `(event_latency=${validModernFrames.length}, ` +
          `scroll_jank=${validScrollJankFrames.length}, ` +
          `compositor_results=${validCompositorUpdates.length})`,
      );
    }
    const eventLatencyResultIds = validModernFrames
      .map((frame) => frame.resultId)
      .filter((id): id is string => id !== null);
    const scrollJankResultIds = validScrollJankFrames
      .map((frame) => frame.resultId)
      .filter((id): id is string => id !== null);
    if (!sameStringMultiset(eventLatencyResultIds, scrollJankResultIds)) {
      failures.push(
        `${surface}: EventLatency and ScrollJankV4 result IDs do not correlate`,
      );
    }
    const eventLatencyIds = validModernFrames
      .map((frame) => frame.eventLatencyId)
      .filter((id): id is string => id !== null);
    const compositorTraceIds = validCompositorUpdates
      .map((update) => update.traceId)
      .filter((id): id is string => id !== null);
    if (!sameStringMultiset(eventLatencyIds, compositorTraceIds)) {
      failures.push(
        `${surface}: EventLatency and compositor scroll result IDs do not correlate`,
      );
    }
    if (compositorConsumedUpdates.length !== validCompositorUpdates.length) {
      failures.push(
        `${surface}: ${validCompositorUpdates.length - compositorConsumedUpdates.length} ` +
          "scroll updates were not fully consumed by the compositor",
      );
    }
    const eventLatencyJank = validModernFrames.filter(
      (frame) => frame.isJanky === true,
    ).length;
    const scrollJankV4Jank = validScrollJankFrames.filter(
      (frame) => frame.isJanky === true,
    ).length;
    if (eventLatencyJank !== scrollJankV4Jank) {
      failures.push(
        `${surface}: EventLatency and ScrollJankV4 disagree on janky frame count`,
      );
    }
    if (modernCorrelatedSourceCount !== 1) {
      failures.push(
        `${surface}: expected exactly one trace-id-correlated PipelineReporter source, ` +
          `found ${modernCorrelatedSourceCount}`,
      );
    }
    if (summary.cadenceFrameCount < MQA_0032_THRESHOLDS.minActiveCompositorFrames) {
      failures.push(
        `${surface}: correlated compositor cadence has ${summary.cadenceFrameCount} frames; ` +
          `requires ${MQA_0032_THRESHOLDS.minActiveCompositorFrames}`,
      );
    }
    if (summary.highLatencyFrames > 0) {
      failures.push(
        `${surface}: ${summary.highLatencyFrames} modern scroll frames have high latency`,
      );
    }
  }
  if (unknownFrameStates.length > 0) {
    failures.push(
      `${surface}: unknown frame states: ${unknownFrameStates.join(", ")}`,
    );
  }
  if (unknownScrollFrames.length > 0) {
    failures.push(
      `${surface}: ${unknownScrollFrames.length} active frames have unknown scroll states`,
    );
  }
  if (unclassifiedSmoothnessFrames > 0) {
    failures.push(
      `${surface}: ${unclassifiedSmoothnessFrames} dropped/partial frames are missing affects_smoothness`,
    );
  }
  if (
    summary.dominantCompositorFrames <
    MQA_0032_THRESHOLDS.minActiveCompositorFrames
  ) {
    failures.push(
      `${surface}: dominant compositor source has ${summary.dominantCompositorFrames} frames; ` +
        `requires ${MQA_0032_THRESHOLDS.minActiveCompositorFrames}`,
    );
  }
  if (p95FrameIntervalMs === null) {
    failures.push(`${surface}: compositor frame p95 is unavailable`);
  } else if (
    p95FrameIntervalMs > MQA_0032_THRESHOLDS.maxP95FrameIntervalMs
  ) {
    failures.push(
      `${surface}: compositor frame p95 ${round(p95FrameIntervalMs)}ms exceeds ` +
        `${MQA_0032_THRESHOLDS.maxP95FrameIntervalMs}ms`,
    );
  }
  if (maxFrameGapMs === null) {
    failures.push(`${surface}: compositor max frame gap is unavailable`);
  } else if (maxFrameGapMs > MQA_0032_THRESHOLDS.maxFrameGapMs) {
    failures.push(
      `${surface}: compositor max gap ${round(maxFrameGapMs)}ms exceeds ` +
        `${MQA_0032_THRESHOLDS.maxFrameGapMs}ms`,
    );
  }
  if (
    summary.smoothnessAffectingDroppedFrames >
    MQA_0032_THRESHOLDS.maxSmoothnessAffectingDroppedFrames
  ) {
    failures.push(
      `${surface}: ${summary.smoothnessAffectingDroppedFrames} ` +
        "smoothness-affecting dropped frames",
    );
  }
  if (
    summary.smoothnessAffectingPartialFrames >
    MQA_0032_THRESHOLDS.maxSmoothnessAffectingPartialFrames
  ) {
    failures.push(
      `${surface}: ${summary.smoothnessAffectingPartialFrames} ` +
        "smoothness-affecting partially-presented frames",
    );
  }
  return summary;
}

function validateRuntimeMeasurement(
  measurement: Mqa0032RuntimeMeasurement,
  failures: string[],
): void {
  const prefix = `${measurement.surface}: runtime`;
  const expectedAxis: Mqa0032Axis =
    measurement.surface === "timeline" ? "horizontal" : "vertical";
  if (measurement.axis !== expectedAxis) {
    failures.push(
      `${prefix} measured ${measurement.axis}; expected ${expectedAxis} scrolling`,
    );
  }
  const numericFields = [
    ["sweeps", measurement.sweeps],
    ["dispatchedWheelEvents", measurement.dispatchedWheelEvents],
    ["trustedWheelEvents", measurement.trustedWheelEvents],
    ["scrollEvents", measurement.scrollEvents],
    ["maxReachablePx", measurement.maxReachablePx],
    ["totalTravelPx", measurement.totalTravelPx],
    ["minPositionPx", measurement.minPositionPx],
    ["maxPositionPx", measurement.maxPositionPx],
    ["finalPositionPx", measurement.finalPositionPx],
  ] as const;
  for (const [name, value] of numericFields) {
    if (!Number.isFinite(value) || value < 0) {
      failures.push(`${prefix} ${name} must be a finite non-negative number`);
    }
  }
  if (!Number.isInteger(measurement.sweeps)) {
    failures.push(`${prefix} sweeps must be an integer`);
  }
  if (measurement.sweeps !== MQA_0032_THRESHOLDS.requiredSweeps) {
    failures.push(
      `${prefix} recorded ${measurement.sweeps} sweeps; requires ` +
        `${MQA_0032_THRESHOLDS.requiredSweeps}`,
    );
  }
  if (
    measurement.dispatchedWheelEvents <
    MQA_0032_THRESHOLDS.minDispatchedWheelEvents
  ) {
    failures.push(
      `${prefix} dispatched ${measurement.dispatchedWheelEvents} wheel events; ` +
        `requires ${MQA_0032_THRESHOLDS.minDispatchedWheelEvents}`,
    );
  }
  if (
    measurement.trustedWheelEvents < MQA_0032_THRESHOLDS.minTrustedWheelEvents
  ) {
    failures.push(
      `${prefix} observed ${measurement.trustedWheelEvents} trusted wheel events; ` +
        `requires ${MQA_0032_THRESHOLDS.minTrustedWheelEvents}`,
    );
  }
  if (measurement.scrollEvents < MQA_0032_THRESHOLDS.minScrollEvents) {
    failures.push(
      `${prefix} observed ${measurement.scrollEvents} scroll events; requires ` +
        `${MQA_0032_THRESHOLDS.minScrollEvents}`,
    );
  }
  if (
    measurement.maxReachablePx < MQA_0032_THRESHOLDS.minReachableDistancePx
  ) {
    failures.push(
      `${prefix} max reachable distance ${round(measurement.maxReachablePx)}px; ` +
        `requires ${MQA_0032_THRESHOLDS.minReachableDistancePx}px`,
    );
  }
  if (
    measurement.totalTravelPx < MQA_0032_THRESHOLDS.minTravelDistancePx
  ) {
    failures.push(
      `${prefix} actual travel ${round(measurement.totalTravelPx)}px; requires ` +
        `${MQA_0032_THRESHOLDS.minTravelDistancePx}px`,
    );
  }
  if (
    measurement.maxPositionPx - measurement.minPositionPx <
    MQA_0032_THRESHOLDS.minReachableDistancePx
  ) {
    failures.push(
      `${prefix} observed position range ` +
        `${round(measurement.maxPositionPx - measurement.minPositionPx)}px; ` +
        `requires ${MQA_0032_THRESHOLDS.minReachableDistancePx}px`,
    );
  }
}

export function analyzeMqa0032ScrollTrace(input: {
  rawTrace: unknown;
  runtimeMeasurements: readonly Mqa0032RuntimeMeasurement[];
}): Mqa0032TraceAnalysis {
  const failures: string[] = [];
  const diagnostics: string[] = [];
  const events = traceEventsFrom(input.rawTrace);
  if (events.length === 0) {
    failures.push("raw trace contains no traceEvents");
  }

  const runtimeBySurface = new Map(
    input.runtimeMeasurements.map((measurement) => [
      measurement.surface,
      measurement,
    ]),
  );
  for (const surface of MQA_0032_SURFACES) {
    const measurement = runtimeBySurface.get(surface);
    if (!measurement) {
      failures.push(`${surface}: runtime measurement is missing`);
    } else {
      validateRuntimeMeasurement(measurement, failures);
    }
  }
  if (
    input.runtimeMeasurements.length !== MQA_0032_SURFACES.length ||
    runtimeBySurface.size !== MQA_0032_SURFACES.length
  ) {
    failures.push(
      `expected exactly ${MQA_0032_SURFACES.length} runtime measurements, ` +
        `received ${input.runtimeMeasurements.length}`,
    );
  }

  const surfaces = Object.fromEntries(
    MQA_0032_SURFACES.map((surface) => [
      surface,
      analyzeSurface(events, surface, failures),
    ]),
  ) as Record<Mqa0032Surface, Mqa0032SurfaceTraceSummary>;

  for (const surface of MQA_0032_SURFACES) {
    const summary = surfaces[surface];
    diagnostics.push(
      `${surface}: long_tasks=${summary.longTaskCount}, ` +
        `longest_task_ms=${summary.longestTaskMs}, layouts=${summary.layoutEventCount}, ` +
        `paints=${summary.paintEventCount}, traced_wheel_or_gesture=${summary.tracedWheelOrGestureEvents}`,
    );
  }

  const fallbackRuntime: Record<Mqa0032Surface, Mqa0032RuntimeMeasurement> = {
    timeline:
      runtimeBySurface.get("timeline") ??
      missingRuntimeMeasurement("timeline", "horizontal"),
    queue:
      runtimeBySurface.get("queue") ??
      missingRuntimeMeasurement("queue", "vertical"),
  };

  return {
    result: failures.length === 0 ? "PASS" : "FAIL",
    thresholds: MQA_0032_THRESHOLDS,
    traceEventCount: events.length,
    runtime: fallbackRuntime,
    surfaces,
    failures,
    diagnostics,
  };
}

function missingRuntimeMeasurement(
  surface: Mqa0032Surface,
  axis: Mqa0032Axis,
): Mqa0032RuntimeMeasurement {
  return {
    surface,
    axis,
    sweeps: 0,
    dispatchedWheelEvents: 0,
    trustedWheelEvents: 0,
    scrollEvents: 0,
    maxReachablePx: 0,
    totalTravelPx: 0,
    minPositionPx: 0,
    maxPositionPx: 0,
    finalPositionPx: 0,
  };
}
