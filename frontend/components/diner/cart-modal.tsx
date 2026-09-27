"use client";

import { Flame, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CartLineRow } from "@/components/diner/cart-line-row";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Text } from "@/components/ui/text";
import type { FireFailure, LiveTableValue } from "@/hooks/use-live-table";
import { formatPrice, formatTableLabel } from "@/lib/format";

export interface CartModalProps {
  open: boolean;
  onClose: () => void;
  tableToken: string;
  /** Shared live snapshot from useLiveTable — one source for every view. */
  live: LiveTableValue;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
  onFired: () => void;
}

export function CartModal({
  open,
  onClose,
  tableToken,
  live,
  displayName,
  onDisplayNameChange,
  onFired,
}: CartModalProps) {
  const { table, cart, menuIndex, totals, updateLine, removeLine, fire } = live;
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [firing, setFiring] = useState(false);
  const [failure, setFailure] = useState<FireFailure | null>(null);

  async function handleFire() {
    // Frontend double-submission block: the button is already `loading`,
    // this guard stops Enter-key re-entrant calls while a fire is in flight.
    if (firing) return;
    setFiring(true);
    setFailure(null);

    // live.fire() resets the table room cart state and pulls a clean
    // refreshed snapshot from the server on success (spec §3).
    const result = await live.fire();

    setFiring(false);

    if (!result.ok) {
      setFailure(result.failure);
      return;
    }

    onFired();
  }

  async function handleQuantity(cartItemId: string, quantity: number) {
    setBusyLineId(cartItemId);

    if (quantity < 1) {
      await removeLine(cartItemId);
    } else {
      await updateLine(cartItemId, { quantity });
    }

    setBusyLineId(null);
  }

  const isDuplicate =
    failure?.code === "DUPLICATE_ORDER" || failure?.code === "duplicate_order";
  const isInventory =
    failure?.code === "INVENTORY_FAILURE" || failure?.code === "inventory_conflict";

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Review table cart"
      description={
        table
          ? `${formatTableLabel(table.code)} fires as one grouped ticket for the kitchen.`
          : undefined
      }
      footer={
        cart.length > 0 ? (
          <>
            <Button
              variant="ember"
              size="xl"
              loading={firing}
              disabled={firing}
              onClick={() => void handleFire()}
              leftIcon={<Flame className="size-5" aria-hidden />}
            >
              {firing ? "Firing order…" : "Fire order for the table"}
            </Button>
            <Button variant="ghost" size="lg" onClick={onClose} disabled={firing}>
              Keep editing
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="lg" onClick={onClose}>
            Back to the menu
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-5">
        <Input
          label="Ordering as"
          hint="Shown next to the lines you add so the table knows who ordered what."
          value={displayName}
          maxLength={24}
          onChange={(event) => onDisplayNameChange(event.target.value)}
        />

        {failure ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-md border-2 border-alert/35 bg-alert-surface p-4"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-alert" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-alert">{failure.message}</p>
              {isInventory && failure.soldOut.length > 0 ? (
                <Text variant="small" className="text-alert">
                  Sold out: {failure.soldOut.join(", ")}. The menu is now updated.
                </Text>
              ) : null}
              {isDuplicate ? (
                <Text variant="small" className="text-alert">
                  Open the live tracker to follow the order already in the kitchen.
                </Text>
              ) : null}
              {/* Inline validation vectors piped from the API error envelope. */}
              {Object.entries(failure.fields).map(([field, message]) => (
                <p key={field} className="text-xs text-alert">
                  <span className="font-medium">{field}</span>: {message}
                </p>
              ))}
            </div>
          </div>
        ) : null}

        {cart.length === 0 ? (
          <EmptyState
            title="The table cart is empty"
            description="Add a dish from the menu and it appears here instantly for everyone at the table."
            action={
              <Button variant="outline" size="sm" onClick={onClose}>
                Browse the menu
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {cart.map((line) => (
              <CartLineRow
                key={line.id}
                line={line}
                item={menuIndex.get(line.menu_item_id)}
                busy={busyLineId === line.id}
                onQuantityChange={(quantity) => void handleQuantity(line.id, quantity)}
                onNotesChange={(notes) => void updateLine(line.id, notes)}
                onRemove={() => void handleQuantity(line.id, 0)}
              />
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between border-t border-line pt-5">
          <Text variant="small" tone="muted">
            {totals.itemCount} {totals.itemCount === 1 ? "item" : "items"} · shared cart
          </Text>
          <span className="font-display text-subheading text-ink">{formatPrice(totals.total)}</span>
        </div>
      </div>
    </Modal>
  );
}
