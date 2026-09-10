"use client";

import { createPortal } from "react-dom";
import { Toast } from "@/components/ui/Toast";
import { getUserMessages } from "@/shared/i18n/user";

export function SignOutFeedback({ failed, language, onDismiss }: {
  failed: boolean;
  language: "en" | "vi";
  onDismiss: () => void;
}) {
  // Failure is set only after a client action. Mount outside the sidebar so
  // collapsed/scrolling containers cannot clip the shared error toast.
  if (!failed) return null;
  return createPortal(
    <Toast
      toast={{ variant: "error", message: getUserMessages(language).signOut.unconfirmed }}
      onDismiss={onDismiss}
      autoDismissMs={0}
      className="sm:bottom-0"
    />,
    document.body,
  );
}
