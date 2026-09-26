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
  onAdd: (item: MenuItem) => void;
}

export function MenuItemRow({ item, quantityInCart, pending = false, onAdd }: MenuItemRowProps) {
  const unavailable = !item.is_available;

  return (
    <li
      className={cn(
        "flex items-start justify-between gap-5 border-b border-line py-5 last:border-b-0",
        unavailable && "opacity-70",
      )}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className={cn("font-display text-subheading", unavailable ? "text-ink-subtle" : "text-ink")}>
            {item.name}
          </h3>
          <span
            aria-label={item.vegetarian ? "Vegetarian" : "Non-vegetarian"}
            className={cn(
              "inline-block size-2.5 rounded-pill",
              item.vegetarian ? "bg-ready" : "bg-alert",
            )}
          />
          {quantityInCart > 0 && !unavailable ? (
            <span className="rounded-pill bg-beige/70 px-2.5 py-1 text-xs font-medium text-brown">
              {quantityInCart} in cart
            </span>
          ) : null}
        </div>

        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{item.description}</p>
        <p className="text-sm font-medium text-ink">{formatPrice(item.price)}</p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        {unavailable ? (
          <span className="rounded-pill bg-sand px-4 py-2.5 text-label text-ink-subtle uppercase">
            Out of stock
          </span>
        ) : (
          <Button
            size="sm"
            variant="secondary"
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
