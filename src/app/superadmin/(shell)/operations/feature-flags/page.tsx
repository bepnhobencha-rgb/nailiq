import { ComingSoonPage } from "@/components/superadmin/ComingSoonPage";

export default function FeatureFlagsPage() {
  return (
    <ComingSoonPage
      section="Operations"
      title="Platform Feature Flags"
      phase="Phase 1F"
      description="Toggle platform-wide flags (maintenance_mode, beta_signup_open, etc.). Per-salon flag overrides live under Salons."
    />
  );
}
