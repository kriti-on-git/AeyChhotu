import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone =
  | "neutral"
  | "brand"
  | "outline"
  | "accent"
  | "pending"
  | "preparing"
  | "ready"
  | "alert";
export type BadgeSize = "sm" | "md";

/* Every tone pairs foreground and background from the same family, so the
   contrast ratio is fixed at design time rather than depending on what
   surface the badge happens to land on. */
const tones: Record<BadgeTone, string> = {
  neutral: "bg-sand text-ink-muted",
  brand: "bg-ink text-ink-inverse",
  outline: "border border-line-strong bg-transparent text-ink-muted",
  accent: "bg-ember-soft text-ember border border-ember/25",
  pending: "bg-pending-surface text-pending",
  preparing: "bg-preparing-surface text-preparing",
  ready: "bg-ready-surface text-ready",
  alert: "bg-alert-surface text-alert",
};

const sizes: Record<BadgeSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-[0.8125rem]",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
}

export function Badge({ tone = "neutral", size = "sm", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill font-semibold tracking-[0.06em] uppercase whitespace-nowrap",
        tones[tone],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
