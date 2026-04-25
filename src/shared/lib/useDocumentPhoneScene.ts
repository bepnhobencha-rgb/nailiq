"use client";

import { useEffect, useRef, useState } from "react";
import type { PhoneFrameScene } from "@/components/ui/phone/phoneFrameTypes";

const ATTR = "data-nq-benefit-scene";

type BenefitScene = Exclude<PhoneFrameScene, "hero">;

/**
 * Maps scroll position to a phone scene using `[data-nq-benefit-scene]` marketing benefits.
 * Falls back to `hero` when no section is sufficiently in view.
 */
export function useDocumentPhoneScene(dependencyKey: string) {
  const [scene, setScene] = useState<PhoneFrameScene>("hero");
  const ratiosRef = useRef(new Map<Element, number>());

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }

    const map = ratiosRef.current;
    const nodes = document.querySelectorAll<HTMLElement>(`[${ATTR}]`);
    if (nodes.length === 0) {
      return;
    }

    const nodeList = [...nodes];

    const apply = () => {
      let best: { scene: BenefitScene; ratio: number } | null = null;
      for (const n of nodeList) {
        const r = map.get(n) ?? 0;
        if (r < 0.2) {
          continue;
        }
        const raw = n.getAttribute(ATTR);
        if (raw === "booking" || raw === "ai") {
          const s = raw as BenefitScene;
          if (!best || r > best.ratio) {
            best = { scene: s, ratio: r };
          }
        }
      }
      setScene((prev) => {
        const next: PhoneFrameScene = best && best.ratio > 0.2 ? best.scene : "hero";
        return prev === next ? prev : next;
      });
    };

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          map.set(
            e.target,
            e.isIntersecting ? e.intersectionRatio : 0,
          );
        }
        apply();
      },
      {
        threshold: [0, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 1],
        rootMargin: "-12% 0px -10% 0px",
      },
    );

    for (const n of nodeList) {
      obs.observe(n);
    }
    return () => {
      for (const n of nodeList) {
        obs.unobserve(n);
        map.delete(n);
      }
      obs.disconnect();
    };
  }, [dependencyKey]);

  return scene;
}
