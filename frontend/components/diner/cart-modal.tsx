"use client";

import { Flame, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CartLineRow } from "@/components/diner/cart-line-row";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Text } from "@/components/ui/text";
import { useTableData } from "@/hooks/use-table-data";
import { fireOrder, removeCartLine, updateCartLine } from "@/lib/api";
import type { ServiceFailure } from "@/lib/api/types";
import { formatPrice, formatTableLabel } from "@/lib/format";

export interface CartModalProps {
  open: boolean;
  onClose: () => void;
  tableToken: string;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
  onFired: () => void;
}

export function CartModal({
  open,
  onClose,
  tableToken,
  displayName,
  onDisplayNameChange,
  onFired,
}: CartModalProps) {
  const { table, cart, menuIndex, totals } = useTableData(tableToken);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [firing, setFiring] = useState(false);
  const [failure, setFailure] = useState<ServiceFailure | null>(null);

  async function handleFire() {
    setFiring(true);
    setFailure(null);

    const result = await fireOrder(tableToken);
    setFiring(false);

    if (!result.ok) {
      setFailure(result);
      return;
    }

    onFired();
  }

  async function handleQuantity(cartItemId: string, quantity: number) {
    setBusyLineId(cartItemId);

    if (quantity < 1) {
      await removeCartLine({ cart_item_id: cartItemId });
    } else {
      await updateCartLine({ cart_item_id: cartItemId, quantity });
    }

    setBusyLineId(null);
  }

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
              onClick={handleFire}
              leftIcon={<Flame className="size-5" aria-hidden />}
            >
              Fire order for the table
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
          <div className="flex items-start gap-3 rounded-md border-2 border-alert/35 bg-alert-surface p-4">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-alert" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-alert">{failure.message}</p>
              {failure.sold_out?.length ? (
                <Text variant="small" className="text-alert">
                  Sold out: {failure.sold_out.join(", ")}. The menu is now updated.
                </Text>
              ) : null}
              {failure.code === "duplicate_order" ? (
                <Text variant="small" className="text-alert">
                  Open the live tracker to follow the order already in the kitchen.
                </Text>
              ) : null}
            </div>
          </div>
        ) : null}

        {cart.length === 0 ? (
          <EmptyState
            title="The table cart is empty"
            description="Add a dish from the menu and it appears here instantly for everyone at the table."
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
                onNotesChange={(notes) => void updateCartLine({ cart_item_id: line.id, ...notes })}
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
