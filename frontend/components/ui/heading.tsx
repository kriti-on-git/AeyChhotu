import type { ElementType, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type HeadingLevel = "display" | "title" | "heading" | "subheading";
export type HeadingTone = "default" | "muted" | "inverse";

const levels: Record<HeadingLevel, string> = {
  display: "text-display",
  title: "text-title",
  heading: "text-heading",
  subheading: "text-subheading",
};

const tones: Record<HeadingTone, string> = {
  default: "text-ink",
  muted: "text-ink-muted",
  inverse: "text-cream",
};

const tags: Record<HeadingLevel, ElementType> = {
  display: "h1",
  title: "h1",
  heading: "h2",
  subheading: "h3",
};

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  level?: HeadingLevel;
  tone?: HeadingTone;
  as?: ElementType;
}

export function Heading({
  level = "heading",
  tone = "default",
  as,
  className,
  ...props
}: HeadingProps) {
  const Component = as ?? tags[level];

  return (
    <Component
      className={cn("font-display font-semibold", levels[level], tones[tone], className)}
      {...props}
    />
  );
}
