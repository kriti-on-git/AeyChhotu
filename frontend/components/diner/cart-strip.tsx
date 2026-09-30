"use client";

import { ShoppingBasket } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { formatPrice } from "@/lib/format";

export interface CartStripProps {
  itemCount: number;
  total: number;
  onView: () => void;
}

/* A solid ink bar rather than a translucent cream one: on a scrolling menu
   this is the only fixed element competing for attention, and it owns the
   single ember action on the screen. */
export function CartStrip({ itemCount, total, onView }: CartStripProps) {
  if (itemCount === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink/20 bg-ink text-ink-inverse shadow-lg">
      <Container className="flex items-center justify-between gap-4 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-md bg-ink-inverse/10"
          >
            <ShoppingBasket className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col">
            <p className="truncate text-sm font-semibold">
              {itemCount} {itemCount === 1 ? "item" : "items"} · {formatPrice(total)}
            </p>
            <p className="truncate text-xs text-ink-inverse/65">
              Shared live across every phone at this table
            </p>
          </div>
        </div>

        <button type="button" onClick={onView} className={buttonStyles({ variant: "ember", size: "md" })}>
          Review &amp; fire
        </button>
      </Container>
    </div>
  );
}
