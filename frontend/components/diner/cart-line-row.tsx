"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { AllergyInput } from "@/components/diner/allergy-input";
import { QuantityStepper } from "@/components/diner/quantity-stepper";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import type { CartLine, MenuItem } from "@/lib/api/types";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface CartLineRowProps {
  line: CartLine;
  item: MenuItem | undefined;
  busy?: boolean;
  onQuantityChange: (quantity: number) => void;
  onNotesChange: (notes: { request_note?: string; allergy_note?: string }) => void;
  onRemove: () => void;
}

export function CartLineRow({
  line,
  item,
  busy = false,
  onQuantityChange,
  onNotesChange,
  onRemove,
}: CartLineRowProps) {
  const [notesOpen, setNotesOpen] = useState(Boolean(line.request_note || line.allergy_note));
  const unavailable = item ? !item.is_available : false;

  return (
    <li className="rounded-md border border-line bg-surface-sunken/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="font-display text-base text-ink">{item?.name ?? "Removed item"}</p>
          <Text variant="caption" tone="subtle">
            Added by {line.added_by} · {formatPrice(item?.price ?? 0)} each
          </Text>
          {unavailable ? (
            <Text variant="caption" tone="alert">
              Ran out while you were ordering — remove it to keep firing.
            </Text>
          ) : null}
        </div>

        <QuantityStepper
          quantity={line.quantity}
          label={item?.name ?? "item"}
          busy={busy}
          onChange={onQuantityChange}
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => setNotesOpen((open) => !open)}
          aria-expanded={notesOpen}
          className="flex cursor-pointer items-center gap-1.5 rounded-sm text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] hover:text-ember"
        >
          <ChevronDown
            className={cn("size-4 transition-transform duration-[var(--duration-fast)]", notesOpen && "rotate-180")}
            aria-hidden
          />
          {line.request_note || line.allergy_note ? "Notes added" : "Add a note or allergy"}
        </button>

        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="cursor-pointer rounded-sm text-sm font-medium text-ink-subtle transition-colors duration-[var(--duration-fast)] hover:text-alert disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      {notesOpen ? (
        <div className="mt-4 flex flex-col gap-4">
          <Input
            label="Kitchen note"
            placeholder="Extra sauce, no onions…"
            value={line.request_note}
            maxLength={120}
            onChange={(event) => onNotesChange({ request_note: event.target.value })}
          />
          <AllergyInput
            id={`${line.id}-allergy`}
            value={line.allergy_note}
            onChange={(value) => onNotesChange({ allergy_note: value })}
          />
        </div>
      ) : null}
    </li>
  );
}
