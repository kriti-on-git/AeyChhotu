import { TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StateTone = "neutral" | "alert";

const tones: Record<StateTone, string> = {
  neutral: "bg-beige/45 text-brown",
  alert: "bg-alert-surface text-alert",
};

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: StateTone;
  /** Set to a heading tag when the state is the page's main heading. */
  titleAs?: "p" | "h1" | "h2";
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = "neutral",
  titleAs: Title = "p",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-line px-6 py-14 text-center",
        className,
      )}
    >
      {Icon ? (
        <span className={cn("flex size-12 items-center justify-center rounded-pill", tones[tone])}>
          <Icon className="size-5" aria-hidden />
        </span>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Title
          className={cn(
            "font-display text-ink",
            Title === "p" ? "text-subheading" : "text-heading",
          )}
        >
          {title}
        </Title>
        {description ? (
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-ink-muted">{description}</p>
        ) : null}
      </div>

      {action}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  description?: string;
  action?: ReactNode;
  titleAs?: EmptyStateProps["titleAs"];
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  description = "We could not load this right now. Please try again.",
  action,
  titleAs,
  className,
}: ErrorStateProps) {
  return (
    <EmptyState
      tone="alert"
      icon={TriangleAlert}
      title={title}
      titleAs={titleAs}
      description={description}
      action={action}
      className={className}
    />
  );
}
