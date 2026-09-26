import type { ElementType, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type TextVariant = "lead" | "body" | "small" | "caption" | "label";
export type TextTone = "default" | "muted" | "subtle" | "inverse" | "alert";

const variants: Record<TextVariant, string> = {
  lead: "text-lead",
  body: "text-base leading-relaxed",
  small: "text-sm leading-relaxed",
  caption: "text-xs leading-normal",
  label: "text-label uppercase",
};

const tones: Record<TextTone, string> = {
  default: "text-ink",
  muted: "text-ink-muted",
  subtle: "text-ink-subtle",
  inverse: "text-cream",
  alert: "text-alert",
};

const tags: Record<TextVariant, ElementType> = {
  lead: "p",
  body: "p",
  small: "p",
  caption: "p",
  label: "span",
};

export interface TextProps extends HTMLAttributes<HTMLParagraphElement> {
  variant?: TextVariant;
  tone?: TextTone;
  as?: ElementType;
}

export function Text({
  variant = "body",
  tone = "default",
  as,
  className,
  ...props
}: TextProps) {
  const Component = as ?? tags[variant];

  return (
    <Component className={cn(variants[variant], tones[tone], className)} {...props} />
  );
}
