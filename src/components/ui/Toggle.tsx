"use client";

import {
  type ButtonHTMLAttributes,
  type ReactNode,
  forwardRef,
  useId,
  useState,
} from "react";

import { cn } from "@/shared/lib/cn";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";

const TOGGLE_MOTION = {
  fastSec: 0.1,
  ease: [0.22, 1, 0.36, 1] as const,
} as const;

export type ToggleVariant = "default" | "small";
export type ToggleLabelPosition = "left" | "right";

const trackSizeClasses: Record<ToggleVariant, string> = {
  default: "h-6 w-11",
  small: "h-5 w-9",
};

const thumbSizeClasses: Record<ToggleVariant, string> = {
  default: "h-5 w-5",
  small: "h-4 w-4",
};

const thumbOffsets: Record<ToggleVariant, { off: number; on: number }> = {
  default: { off: 2, on: 22 },
  small: { off: 2, on: 18 },
};

type NativeButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  | "onChange"
  | "type"
  | "role"
  | "aria-checked"
  | "checked"
  | "defaultChecked"
  | "value"
  | "disabled"
  | "onDrag"
  | "onDragStart"
  | "onDragEnd"
  | "onDragEnter"
  | "onDragLeave"
  | "onDragOver"
  | "onDragExit"
  | "onAnimationStart"
  | "onAnimationEnd"
  | "onAnimationIteration"
  | "onTransitionEnd"
>;

type ToggleBaseProps = {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: ToggleVariant;
  description?: ReactNode;
  labelPosition?: ToggleLabelPosition;
  className?: string;
};

type ToggleAccessibleNaming =
  | { label: ReactNode; "aria-label"?: string }
  | { label?: undefined; "aria-label": string };

export type ToggleProps = ToggleBaseProps &
  ToggleAccessibleNaming &
  NativeButtonProps;

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(
  function Toggle(props, ref) {
    const {
      checked,
      defaultChecked,
      onChange,
      disabled = false,
      loading = false,
      variant = "default",
      label,
      description,
      labelPosition = "right",
      className,
      id,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledByExternal,
      "aria-describedby": ariaDescribedByExternal,
      ...rest
    } = props;

    const reduced = useReducedMotion();
    const isControlled = checked !== undefined;
    const [internalChecked, setInternalChecked] = useState<boolean>(
      defaultChecked ?? false,
    );
    const isOn = isControlled ? Boolean(checked) : internalChecked;
    const blocked = disabled || loading;
    const reactId = useId();
    const rootId = id ?? reactId;
    const labelId = label ? `${rootId}-label` : undefined;
    const descId = description ? `${rootId}-desc` : undefined;

    const handleToggle = () => {
      if (blocked) return;
      const next = !isOn;
      if (!isControlled) setInternalChecked(next);
      onChange?.(next);
    };

    const offsets = thumbOffsets[variant];

    const track = (
      <button
        ref={ref}
        type="button"
        role="switch"
        id={rootId}
        aria-checked={isOn}
        aria-disabled={blocked || undefined}
        aria-busy={loading || undefined}
        aria-labelledby={ariaLabelledByExternal ?? labelId}
        aria-describedby={ariaDescribedByExternal ?? descId}
        aria-label={!labelId && !ariaLabelledByExternal ? ariaLabel : undefined}
        disabled={blocked}
        onClick={handleToggle}
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center min-h-11 min-w-11 rounded-full",
          "outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
          "disabled:cursor-not-allowed",
          loading && "cursor-wait opacity-70",
          !loading && blocked && "opacity-50",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "relative inline-block rounded-full border",
            trackSizeClasses[variant],
            isOn
              ? "bg-nq-primary border-nq-primary"
              : "bg-nq-surface border-nq-border",
          )}
        >
          <motion.span
            aria-hidden
            className={cn(
              "absolute top-0.5 block rounded-full shadow-nq-sm",
              thumbSizeClasses[variant],
              isOn ? "bg-nq-bg" : "bg-nq-foreground",
            )}
            initial={false}
            animate={{ x: isOn ? offsets.on : offsets.off }}
            transition={{
              duration: reduced ? 0 : TOGGLE_MOTION.fastSec,
              ease: TOGGLE_MOTION.ease,
            }}
          />
        </span>
      </button>
    );

    if (!label && !description) {
      return (
        <span className={cn("inline-flex", className)} {...rest}>
          {track}
        </span>
      );
    }

    const textBlock = (
      <span className="flex min-w-0 flex-col">
        {label ? (
          <span
            id={labelId}
            onClick={handleToggle}
            className={cn(
              "text-sm font-medium text-nq-foreground select-none",
              !blocked && "cursor-pointer",
            )}
          >
            {label}
          </span>
        ) : null}
        {description ? (
          <span id={descId} className="text-xs text-nq-muted">
            {description}
          </span>
        ) : null}
      </span>
    );

    return (
      <span
        className={cn(
          "inline-flex items-center gap-3",
          labelPosition === "left" && "flex-row-reverse",
          className,
        )}
        {...rest}
      >
        {track}
        {textBlock}
      </span>
    );
  },
);

Toggle.displayName = "Toggle";

export default Toggle;
