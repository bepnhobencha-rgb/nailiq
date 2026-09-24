"use client";

import { useEffect, useRef, type RefObject } from "react";

/** Keyboard contract for existing operational overlays with custom geometry.
 * Does not create another overlay or change shared Modal/Drawer presentation. */
export function useOverlayFocus(
  isOpen: boolean,
  panelRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!isOpen || !panelRef.current) return;
    const panel = panelRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.focus({ preventScroll: true });
    const anotherDialogHasFocus = () => {
      const activeDialog = document.activeElement?.closest('[role="dialog"]');
      return !!activeDialog && activeDialog !== panel;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || anotherDialogHasFocus()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((control) => control.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target) && !anotherDialogHasFocus()) panel.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", containFocus);
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected && !anotherDialogHasFocus()) previous.focus({ preventScroll: true });
    };
  }, [isOpen, panelRef]);
}
