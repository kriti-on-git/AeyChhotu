import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import {
  buttonIconClass,
  buttonStyles,
  type ButtonSize,
  type ButtonVariant,
} from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type IconButtonTone = "solid" | "accent" | "soft" | "ghost" | "outline";

/* Tones map straight onto button variants — styling is never applied twice,
   which is what previously let an outline IconButton drift away from the
   outline Button it sat next to. */
const variantMap: Record<IconButtonTone, ButtonVariant> = {
  solid: "primary",
  accent: "ember",
  soft: "soft",
  ghost: "ghost",
  outline: "outline",
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
