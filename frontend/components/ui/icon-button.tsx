import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { buttonIconClass, buttonStyles, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type IconButtonTone = "solid" | "soft" | "ghost" | "outline";

const tones: Record<IconButtonTone, string> = {
  solid: "bg-dark-brown text-cream hover:bg-clay",
  soft: "bg-beige text-dark-brown hover:bg-tan",
  ghost: "bg-transparent text-ink-muted hover:bg-beige/50 hover:text-ink",
  outline: "border border-dark-brown/25 text-dark-brown hover:bg-beige/40",
};

const squareSizes: Record<ButtonSize, string> = {
  sm: "size-9",
  md: "size-11",
  lg: "size-13",
  xl: "size-15",
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tone?: IconButtonTone;
  size?: ButtonSize;
  loading?: boolean;
}

export function IconButton({
  label,
  tone = "ghost",
  size = "md",
  loading = false,
  className,
  disabled,
  type = "button",
  children,
  ...props
}: IconButtonProps) {
  const variantMap: Record<IconButtonTone, ButtonVariant> = {
    solid: "primary",
    soft: "secondary",
    ghost: "ghost",
    outline: "outline",
  };

  return (
    <button
      type={type}
      disabled={disabled ?? loading}
      aria-label={label}
      title={label}
      aria-busy={loading || undefined}
      className={cn(
        buttonStyles({ variant: variantMap[tone], size }),
        "aspect-square gap-0 p-0",
        squareSizes[size],
        tones[tone],
        className,
      )}
      {...props}
    >
      {loading ? (
        <Loader2 className={cn(buttonIconClass(size), "animate-spin")} aria-hidden />
      ) : (
        children
      )}
    </button>
  );
}
