import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type SpinnerSize = "sm" | "md" | "lg";

const sizes: Record<SpinnerSize, string> = {
  sm: "size-4",
  md: "size-6",
  lg: "size-9",
};

export interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
  label?: string;
}

export function Spinner({ size = "md", className, label = "Loading" }: SpinnerProps) {
  return (
    <span role="status" aria-label={label} className="inline-flex items-center">
      <Loader2
        aria-hidden
        className={cn("animate-spin text-ink-subtle", sizes[size], className)}
      />
    </span>
  );
}
