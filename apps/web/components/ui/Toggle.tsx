"use client";

import { cn } from "@/lib/cn";

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
  "aria-label"?: string;
  className?: string;
}

/**
 * Toggle switch. Single ≥44px tap target on mobile (28px slider in a 44x44
 * hit area). Renders <button role="switch"> per ARIA APG so screen readers
 * announce "on / off". Use this everywhere a boolean setting needs a touch
 * affordance — replaces the native <input type="checkbox"> which has a
 * tap target far below mobile minimum.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  "aria-label": ariaLabel,
  className,
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-11 w-11 shrink-0 items-center justify-center",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <span
        className={cn(
          "block h-6 w-10 rounded-full transition-colors",
          checked ? "bg-accent" : "bg-panel2",
        )}
      />
      <span
        className={cn(
          "absolute h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-2" : "-translate-x-2",
        )}
      />
    </button>
  );
}
