import { type ReactNode, useEffect, useRef, useState } from "react";
import type { PhoneActivityItem } from "./phoneFrameTypes";
import { PhoneMockGrid } from "./PhoneMockGrid";

const FLOW_DELAY_MS = 300;
const POST_BOOKING_REST_MS = 2200;
const CYCLE_MS = FLOW_DELAY_MS * 2 + POST_BOOKING_REST_MS;

type FlowState = { phase: "svc" | "full"; col: number };

function clearAll(ids: number[]) {
  for (const id of ids) window.clearTimeout(id);
  ids.length = 0;
}

type PhoneHeroScreenProps = {
  strip: readonly [string, string, string];
  times: readonly [string, string, string];
  activityFeed: ReadonlyArray<PhoneActivityItem>;
  reduced: boolean;
  children: ReactNode;
};

/**
 * Staged service → time → live booking (existing marketing mock).
 */
export function PhoneHeroScreen({
  strip,
  times,
  activityFeed,
  reduced,
  children,
}: PhoneHeroScreenProps) {
  const [flow, setFlow] = useState<FlowState>({ phase: "svc", col: 0 });
  const [activityIndex, setActivityIndex] = useState(0);
  const hasActivity = activityFeed.length > 0;
  const nAct = activityFeed.length;
  const chainRef = useRef<number[]>([]);
  const act = hasActivity
    ? activityFeed[activityIndex % (nAct || 1)]
    : null;

  const flowUsed = reduced ? ({ phase: "full", col: 0 } as const) : flow;

  useEffect(() => {
    if (reduced) {
      return;
    }

    const chain = chainRef.current;
    clearAll(chain);
    let alive = true;
    const mod = strip.length;

    if (hasActivity && nAct < 1) {
      return;
    }

    const scheduleBeat = (startCol: number) => {
      if (!alive) return;
      setFlow({ phase: "svc", col: startCol });
      chain.push(
        window.setTimeout(() => {
          if (!alive) return;
          setFlow({ phase: "full", col: startCol });
        }, FLOW_DELAY_MS),
      );
      chain.push(
        window.setTimeout(() => {
          if (!alive) return;
          if (hasActivity && nAct > 0) {
            setActivityIndex((a) => (a + 1) % nAct);
          }
        }, FLOW_DELAY_MS * 2),
      );
      chain.push(
        window.setTimeout(() => {
          if (!alive) return;
          const next = (startCol + 1) % mod;
          scheduleBeat(next);
        }, CYCLE_MS),
      );
    };

    scheduleBeat(0);

    return () => {
      alive = false;
      clearAll(chain);
    };
  }, [reduced, hasActivity, nAct, strip.length]);

  const timeLit = flowUsed.phase === "full";
  const col = flowUsed.col;

  if (hasActivity && act != null) {
    return (
      <PhoneMockGrid
        strip={strip}
        times={times}
        col={col}
        timeLit={timeLit}
        bottom={
          <>
            <div
              key={activityIndex}
              className="animate-nq-activity origin-center rounded-xl border border-nq-border/30 bg-nq-bg/90 px-2.5 py-2 shadow-sm ring-1 ring-nq-primary/8 transition-shadow duration-500 will-change-transform"
            >
              <p className="text-[9px] font-medium tracking-wider text-nq-primary/90">
                {act.label}
              </p>
              <p className="mt-1 text-balance break-words text-center text-[11px] leading-snug text-nq-foreground/95">
                {act.line}
              </p>
            </div>
            <div className="animate-nq-content-pulse min-h-0 shrink text-center">
              {children}
            </div>
          </>
        }
      />
    );
  }

  return (
    <PhoneMockGrid
      strip={strip}
      times={times}
      col={col}
      timeLit={timeLit}
      bottom={
        <div className="animate-nq-content-pulse min-h-0 text-center will-change-[opacity]">
          {children}
        </div>
      }
    />
  );
}
