"use client";

import { useSelectedLayoutSegment } from "next/navigation";
import type { ReactNode } from "react";
import {
  shouldUseGuidedFocusMode,
  type GuidedSetupStage,
} from "@/shared/dashboard/guidedSetup";

/** Hide global announcement/trial CTAs while onboarding owns the next action. */
export function GuidedFocusVisibility({
  stage,
  children,
}: {
  stage: GuidedSetupStage;
  children: ReactNode;
}) {
  const activeSegment = useSelectedLayoutSegment();
  return shouldUseGuidedFocusMode(stage, activeSegment) ? null : children;
}
