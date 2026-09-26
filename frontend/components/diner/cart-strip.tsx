"use client";

import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { formatPrice } from "@/lib/format";

export interface CartStripProps {
  itemCount: number;
  total: number;
  onView: () => void;
}

export function CartStrip({ itemCount, total, onView }: CartStripProps) {
  if (itemCount === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur-md">
      <Container className="flex items-center justify-between gap-4 py-3.5">
        <div className="flex flex-col">
          <p className="text-sm font-medium text-ink">
            {itemCount} {itemCount === 1 ? "item" : "items"} in the table cart
          </p>
          <p className="text-xs text-ink-muted">
            {formatPrice(total)} · shared live across every phone at this table
          </p>
        </div>
        <Button onClick={onView} size="md">
          View cart
        </Button>
      </Container>
    </div>
  );
}
