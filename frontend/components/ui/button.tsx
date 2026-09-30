import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant =
  | "primary"
  | "ember"
  | "secondary"
  | "soft"
  | "outline"
  | "ghost"
  | "danger";

export type ButtonSize = "sm" | "md" | "lg" | "xl";

const base =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md font-sans font-semibold whitespace-nowrap transition-[background-color,color,border-color,box-shadow,transform] duration-[var(--duration-fast)] ease-gentle select-none disabled:pointer-events-none disabled:opacity-45";

/* Hierarchy is carried by fill, not by hue: one ink action, one ember
   action, then progressively lighter chrome. A screen should never have
   two competing ember buttons on it. */
const variants: Record<ButtonVariant, string> = {
  primary: "bg-ink text-ink-inverse shadow-xs hover:bg-clay active:translate-y-px",
  ember: "bg-ember text-on-ember shadow-xs hover:bg-ember-strong active:translate-y-px",
  secondary: "bg-beige text-ink hover:bg-tan active:translate-y-px",
  soft: "border border-line-strong bg-sand text-ink hover:border-ink-subtle hover:bg-beige active:translate-y-px",
  outline:
    "border border-line-strong bg-transparent text-ink hover:border-ink-subtle hover:bg-sand active:translate-y-px",
  ghost: "bg-transparent text-ink-muted hover:bg-sand hover:text-ink",
  danger: "bg-alert text-ink-inverse shadow-xs hover:brightness-110 active:translate-y-px",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-sm",
  md: "h-11 px-4 text-sm",
  lg: "h-13 px-6 text-base",
  xl: "h-15 px-8 text-base",
};

const iconSizes: Record<ButtonSize, string> = {
  sm: "size-4",
  md: "size-4",
  lg: "size-5",
  xl: "size-5",
};

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}

export function buttonStyles({
  variant = "primary",
  size = "md",
  fullWidth = false,
  className,
}: ButtonStyleOptions = {}) {
  return cn(base, variants[variant], sizes[size], fullWidth && "w-full", className);
}

export function buttonIconClass(size: ButtonSize = "md") {
  return cn("shrink-0", iconSizes[size]);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = false,
  leftIcon,
  rightIcon,
  className,
  disabled,
  type = "button",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={buttonStyles({ variant, size, fullWidth, className })}
      {...props}
    >
      {loading ? (
        <Loader2 className={cn(buttonIconClass(size), "animate-spin")} aria-hidden />
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  );
}
