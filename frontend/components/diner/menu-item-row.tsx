"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MenuItem } from "@/lib/api/types";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface MenuItemRowProps {
  item: MenuItem;
  quantityInCart: number;
  pending?: boolean;
  /** API validation / inventory message rendered under the row (spec §4). */
  error?: string;
  onAdd: (item: MenuItem) => void;
}

/* The veg mark uses the square-with-dot convention diners actually recognise
   on an Indian menu, rather than a bare coloured dot that reads as a legend
   you have to learn. */
function DietMark({ vegetarian }: { vegetarian: boolean }) {
  return (
    <span
      role="img"
      aria-label={vegetarian ? "Vegetarian" : "Non-vegetarian"}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[3px] border-2",
        vegetarian ? "border-ready" : "border-alert",
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-pill", vegetarian ? "bg-ready" : "bg-alert")}
      />
    </span>
  );
}

export function MenuItemRow({
  item,
  quantityInCart,
  pending = false,
  error,
  onAdd,
}: MenuItemRowProps) {
  const unavailable = !item.is_available;

  return (
    <li
      className={cn(
        "flex items-start justify-between gap-5 border-b border-line py-5 last:border-b-0",
        unavailable && "opacity-60",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <DietMark vegetarian={item.vegetarian} />

          <h3
            className={cn(
              "font-display text-subheading",
              unavailable ? "text-ink-subtle line-through" : "text-ink",
            )}
          >
            {item.name}
          </h3>

          {quantityInCart > 0 && !unavailable ? (
            <span className="rounded-pill border border-ember/25 bg-ember-soft px-2.5 py-1 text-xs font-semibold text-ember">
              {quantityInCart} in cart
            </span>
          ) : null}
        </div>

        <p className="max-w-prose pl-[1.625rem] text-sm leading-relaxed text-ink-muted">
          {item.description}
        </p>
        <p className="pl-[1.625rem] text-base font-semibold text-ink">
          {formatPrice(item.price)}
        </p>

        {error ? (
          <p role="alert" className="pl-[1.625rem] text-xs font-medium text-alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        {unavailable ? (
          <span className="rounded-pill bg-pending-surface px-4 py-2.5 text-label text-pending uppercase">
            Out of stock
          </span>
        ) : (
          <Button
            size="sm"
            variant="soft"
            loading={pending}
            onClick={() => onAdd(item)}
            aria-label={`Add ${item.name} to the table cart`}
            leftIcon={<Plus className="size-4" aria-hidden />}
          >
            Add
          </Button>
        )}
      </div>
    </li>
  );
}
