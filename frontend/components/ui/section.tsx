import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type SectionTone = "canvas" | "surface" | "sunken" | "ink";
export type SectionSpacing = "sm" | "md" | "lg";

const tones: Record<SectionTone, string> = {
  canvas: "bg-canvas text-ink",
  surface: "bg-surface text-ink",
  sunken: "bg-surface-sunken text-ink",
  ink: "bg-dark-brown text-cream",
};

const spacings: Record<SectionSpacing, string> = {
  sm: "py-12 sm:py-16",
  md: "py-16 sm:py-24",
  lg: "py-24 sm:py-32 lg:py-40",
};

export interface SectionProps extends HTMLAttributes<HTMLElement> {
  tone?: SectionTone;
  spacing?: SectionSpacing;
}

export function Section({
  tone = "canvas",
  spacing = "md",
  className,
  ...props
}: SectionProps) {
  return (
    <section
      className={cn("relative isolate w-full", tones[tone], spacings[spacing], className)}
      {...props}
    />
  );
}
