import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface LoadingStateProps {
  label?: string;
  className?: string;
}

export function LoadingState({ label = "Loading…", className }: LoadingStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-14 text-center",
        className,
      )}
    >
      <Spinner size="lg" />
      <p className="text-sm text-ink-muted">{label}</p>
    </div>
  );
}

export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <span
      aria-hidden
      className={cn("block animate-pulse-soft rounded-sm bg-sand", className)}
    />
  );
}
