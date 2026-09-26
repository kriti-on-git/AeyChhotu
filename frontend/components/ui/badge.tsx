import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone = "neutral" | "brand" | "outline" | "pending" | "preparing" | "ready" | "alert";
export type BadgeSize = "sm" | "md";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-sand text-ink-muted",
  brand: "bg-dark-brown text-cream",
  outline: "border border-line-strong bg-transparent text-ink-muted",
  pending: "bg-pending/12 text-pending",
  preparing: "bg-preparing/12 text-preparing",
  ready: "bg-ready/12 text-ready",
  alert: "bg-alert-surface text-alert",
};

const sizes: Record<BadgeSize, string> = {
  sm: "px-2.5 py-1 text-[0.6875rem]",
  md: "px-3 py-1.5 text-xs",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
}

export function Badge({ tone = "neutral", size = "sm", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill font-medium tracking-wide uppercase",
        tones[tone],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
