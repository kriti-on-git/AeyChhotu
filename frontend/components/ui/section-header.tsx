import type { ElementType, ReactNode } from "react";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export type HeaderAlign = "left" | "center";
export type HeaderSize = "section" | "page";

const aligns: Record<HeaderAlign, string> = {
  left: "items-start text-left",
  center: "items-center text-center",
};

const maxWidths: Record<HeaderSize, string> = {
  section: "max-w-2xl",
  page: "max-w-3xl",
};

export interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  align?: HeaderAlign;
  size?: HeaderSize;
  actions?: ReactNode;
  as?: ElementType;
  className?: string;
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = "left",
  size = "section",
  actions,
  as: Component = "div",
  className,
}: SectionHeaderProps) {
  return (
    <Component
      className={cn(
        "flex flex-col gap-4",
        aligns[align],
        align === "center" && "mx-auto",
        maxWidths[size],
        className,
      )}
    >
      {eyebrow ? (
        <Text variant="label" tone="subtle" as="span" className="flex items-center gap-2.5">
          <span aria-hidden className="h-px w-6 bg-line-strong" />
          {eyebrow}
        </Text>
      ) : null}

      <Heading level={size === "page" ? "title" : "heading"} as={size === "page" ? "h1" : "h2"}>
        {title}
      </Heading>

      {description ? (
        <Text variant="lead" tone="muted" className={cn(align === "center" && "mx-auto")}>
          {description}
        </Text>
      ) : null}

      {actions ? <div className="mt-2 flex flex-wrap items-center gap-3">{actions}</div> : null}
    </Component>
  );
}
