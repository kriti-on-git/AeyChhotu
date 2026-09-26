import type { ElementType, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type ContainerSize = "page" | "content" | "narrow" | "full";

const sizes: Record<ContainerSize, string> = {
  page: "max-w-page",
  content: "max-w-content",
  narrow: "max-w-narrow",
  full: "max-w-none",
};

export interface ContainerProps extends HTMLAttributes<HTMLDivElement> {
  size?: ContainerSize;
  as?: ElementType;
}

export function Container({
  size = "page",
  as: Component = "div",
  className,
  ...props
}: ContainerProps) {
  return (
    <Component
      className={cn("mx-auto w-full px-5 sm:px-8 lg:px-12", sizes[size], className)}
      {...props}
    />
  );
}
