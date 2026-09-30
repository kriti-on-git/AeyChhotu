"use client";

import { Minus, Plus, Trash2 } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export interface QuantityStepperProps {
  quantity: number;
  /** Dish name, for the control labels a screen reader reads out. */
  label: string;
  busy?: boolean;
  /**
   * Sends the intended absolute quantity, exactly as the cart modal always
   * has: the parent turns 0 into the existing remove path and anything else
   * into the existing quantity_delta update. No new quantity system.
   */
  onChange: (quantity: number) => void;
  className?: string;
}

/* Compact, easy to tap, and identical everywhere a line can be changed: the
   minus becomes a bin at one so the destructive action is explicit. */
export function QuantityStepper({
  quantity,
  label,
  busy = false,
  onChange,
  className,
}: QuantityStepperProps) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <IconButton
        label={quantity === 1 ? `Remove ${label}` : `Decrease ${label}`}
        size="sm"
        tone="outline"
        disabled={busy}
        onClick={() => onChange(quantity - 1)}
      >
        {quantity === 1 ? (
          <Trash2 className="size-3.5" aria-hidden />
        ) : (
          <Minus className="size-3.5" aria-hidden />
        )}
      </IconButton>

      <span
        className="min-w-7 text-center text-sm font-semibold text-ink tabular-nums"
        aria-live="polite"
      >
        {quantity}
      </span>

      <IconButton
        label={`Add another ${label}`}
        size="sm"
        tone="outline"
        disabled={busy}
        onClick={() => onChange(quantity + 1)}
      >
        <Plus className="size-3.5" aria-hidden />
      </IconButton>
    </div>
  );
}
