"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type TooltipSide = "top" | "bottom";

const sides: Record<TooltipSide, string> = {
  top: "bottom-[calc(100%+0.5rem)] left-1/2 -translate-x-1/2",
  bottom: "top-[calc(100%+0.5rem)] left-1/2 -translate-x-1/2",
};

export interface TooltipProps {
  label: string;
  side?: TooltipSide;
  className?: string;
  children: ReactNode;
}

export function Tooltip({ label, side = "top", className, children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const tooltipId = useId();

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setVisible(false);
      }}
    >
      <span aria-describedby={visible ? tooltipId : undefined} className="inline-flex">
        {children}
      </span>
      <span
        id={tooltipId}
        role="tooltip"
        aria-hidden={!visible}
        className={cn(
          "pointer-events-none absolute z-40 max-w-56 rounded-sm bg-dark-brown px-3 py-1.5 text-center text-xs leading-snug text-cream shadow-md transition-opacity duration-[var(--duration-fast)]",
          sides[side],
          visible ? "opacity-100" : "invisible opacity-0",
          className,
        )}
      >
        {label}
      </span>
    </span>
  );
}
