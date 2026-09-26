import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger"
  | "ember";

export type ButtonSize = "sm" | "md" | "lg" | "xl";

const base =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-pill font-sans font-medium whitespace-nowrap transition-[background-color,color,border-color,box-shadow,transform] duration-[var(--duration-fast)] ease-gentle select-none disabled:pointer-events-none disabled:opacity-45";

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-dark-brown text-cream shadow-sm hover:bg-clay hover:shadow-md active:translate-y-px",
  secondary: "bg-beige text-dark-brown hover:bg-tan active:translate-y-px",
  outline:
    "border border-dark-brown/25 bg-transparent text-dark-brown hover:border-dark-brown/50 hover:bg-beige/40 active:translate-y-px",
  ghost: "bg-transparent text-ink-muted hover:bg-beige/45 hover:text-ink",
  danger: "bg-alert text-cream shadow-sm hover:brightness-110 active:translate-y-px",
  ember: "bg-ember text-cream shadow-sm hover:brightness-110 active:translate-y-px",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-5 text-sm",
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
