"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/empty-state";
import type { LiveTableValue } from "@/hooks/use-live-table";
import { getTableBill, type TableBill } from "@/lib/api-client";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Which slice of the bill the drawer is showing. */
export type BillScope = "total" | "mine";

export interface BillDrawerProps {
  open: boolean;
  onClose: () => void;
  scope: BillScope;
  onScopeChange: (scope: BillScope) => void;
  /** The same live snapshot the menu and cart read. */
  live: LiveTableValue;
  displayName: string;
}

interface BillLine {
  key: string;
  name: string;
  quantity: number;
  addedBy: string;
  amount: number;
}

function ownerName(addedBy: string | null | undefined): string {
  const name = addedBy?.trim();
  return name ? name : "Guest";
}

function initial(name: string): string {
  return (name.trim().slice(0, 1) || "G").toUpperCase();
}

/* The running bill. Fired lines and every rupee of arithmetic come from
   `GET /billing/tables/:id/guest`; the browser only renders the backend's
   response. Cart lines are shown separately and explicitly labelled as an
   estimate until they are fired into the bill. */
export function BillDrawer({
  open,
  onClose,
  scope,
  onScopeChange,
  live,
  displayName,
}: BillDrawerProps) {
  const { cart, menuIndex, table } = live;
  const [bill, setBill] = useState<TableBill | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !table) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    void getTableBill(table.id)
      .then((next) => {
        if (!cancelled) setBill(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "The bill could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, table, live.billStatus]);

  const mineOnly = scope === "mine";
  const matches = (addedBy: string) => !mineOnly || ownerName(addedBy) === displayName;

  const fired: BillLine[] = (bill?.line_items ?? [])
    .filter((line) => matches(line.added_by))
    .map((line) => ({
      key: `${line.order_id}:${line.menu_item_id}:${line.added_by}`,
      name: line.name,
      quantity: line.quantity,
      addedBy: ownerName(line.added_by),
      amount: line.line_total_minor / 100,
    }));

  const staged: BillLine[] = cart
    .filter((line) => matches(line.added_by))
    .map((line) => {
      const item = menuIndex.get(line.menu_item_id);
      return {
        key: line.id,
        name: item?.name ?? "Removed item",
        quantity: line.quantity,
        addedBy: ownerName(line.added_by),
        amount: (item?.price ?? 0) * line.quantity,
      };
    });

  /* The only local addition left is the cart estimate. It is never presented
     as the bill and never includes tax or discounts. */
  const stagedEstimate = staged.reduce((sum, line) => sum + line.amount, 0);
  const empty = fired.length === 0 && staged.length === 0;
  const allocations = (bill?.allocations ?? []).filter(
    (allocation) => !mineOnly || allocation.name === displayName,
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={mineOnly ? "Your part of the bill" : "Total bill"}
      description={
        mineOnly
          ? `Only the dishes ${displayName} added. Totals are calculated by the restaurant.`
          : "Everything this table has ordered. Totals are calculated by the restaurant."
      }
      size="md"
      footer={
        empty ? null : (
          <div className="flex w-full flex-col gap-2">
            {bill ? (
              <div className="flex w-full flex-col gap-1.5 text-sm">
                <Row label="Subtotal" value={formatPrice(bill.totals.subtotal_minor / 100)} />
                {bill.totals.discount_minor > 0 ? (
                  <Row
                    label="Discount"
                    value={`- ${formatPrice(bill.totals.discount_minor / 100)}`}
                  />
                ) : null}
                {bill.totals.tax_minor > 0 ? (
                  <Row label="Tax" value={formatPrice(bill.totals.tax_minor / 100)} />
                ) : null}
                <div className="flex items-baseline justify-between border-t border-line pt-2">
                  <span className="text-label text-ink-subtle uppercase">Total</span>
                  <span className="font-display text-subheading text-ink tabular-nums">
                    {formatPrice(bill.totals.total_minor / 100)}
                  </span>
                </div>
              </div>
            ) : null}

            {stagedEstimate > 0 ? (
              <span className="w-full text-xs text-ink-subtle">
                + {formatPrice(stagedEstimate)} still in the cart — an estimate, not on the bill
                yet.
              </span>
            ) : null}
          </div>
        )
      }
    >
      <div className="flex flex-col gap-6">
        <div
          role="group"
          aria-label="Which bill to show"
          className="flex h-11 items-center gap-1 rounded-md border border-line-strong bg-surface p-1"
        >
          {(
            [
              { id: "total", label: "Whole table" },
              { id: "mine", label: "Your part" },
            ] as { id: BillScope; label: string }[]
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onScopeChange(option.id)}
              aria-pressed={scope === option.id}
              className={cn(
                "h-full flex-1 cursor-pointer rounded-sm px-3 text-sm font-semibold transition-colors duration-[var(--duration-fast)]",
                scope === option.id
                  ? "bg-ink text-ink-inverse"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-ink-muted" role="status">
            <Loader2 className="size-4 animate-spin text-ember" aria-hidden />
            Loading the restaurant's bill…
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-md border border-alert/35 bg-alert-surface px-3 py-2 text-sm text-alert">
            {error}
          </p>
        ) : null}

        {empty ? (
          <EmptyState
            title={mineOnly ? "You have not ordered anything yet" : "Nothing on the bill yet"}
            description={
              mineOnly
                ? "Dishes you add to the shared cart appear here, with their own total."
                : "Add a dish from the menu and every line lands here as the table orders."
            }
          />
        ) : (
          <>
            {fired.length > 0 ? (
              <section className="flex flex-col">
                <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-dashed border-line-strong pb-2">
                  <span className="text-label text-ink-subtle uppercase">On the bill</span>
                  <span className="text-xs text-ink-subtle">Calculated by the restaurant</span>
                </header>
                <LineList lines={fired} showOwner={!mineOnly} />
              </section>
            ) : null}

            {staged.length > 0 ? (
              <section className="flex flex-col">
                <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-dashed border-line-strong pb-2">
                  <span className="text-label text-ember uppercase">Still in the cart</span>
                  <span className="text-xs text-ink-subtle">Estimate · not on the bill</span>
                </header>
                <LineList lines={staged} showOwner={!mineOnly} />
              </section>
            ) : null}

            {allocations.length > 0 ? (
              <section className="flex flex-col border-t border-line pt-5">
                <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-dashed border-line-strong pb-2">
                  <span className="text-label text-ink-subtle uppercase">Split by person</span>
                  <span className="text-xs text-ink-subtle">Restaurant allocation</span>
                </header>
                <ul className="flex flex-col divide-y divide-line/70">
                  {allocations.map((person) => {
                    const isYou = person.name === displayName;
                    return (
                      <li key={person.name} className="flex items-center justify-between gap-3 py-3">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span
                            aria-hidden
                            className={cn(
                              "flex size-7 shrink-0 items-center justify-center rounded-pill text-xs font-semibold",
                              isYou ? "bg-ember-soft text-ember" : "bg-sand text-ink-muted",
                            )}
                          >
                            {initial(person.name)}
                          </span>
                          <span className="truncate text-sm font-medium text-ink">
                            {person.name}
                            {isYou ? (
                              <span className="ml-1.5 text-xs font-semibold text-ember uppercase">
                                you
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold text-ink tabular-nums">
                          {formatPrice(person.subtotal_minor / 100)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </Drawer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-muted">{label}</span>
      <span className="text-ink tabular-nums">{value}</span>
    </div>
  );
}

function LineList({ lines, showOwner }: { lines: BillLine[]; showOwner: boolean }) {
  return (
    <ul className="flex flex-col divide-y divide-line/70">
      {lines.map((line) => (
        <li key={line.key} className="flex items-start justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-baseline gap-x-2 text-base font-medium text-ink">
              <span className="font-display font-semibold tabular-nums">{line.quantity}×</span>
              <span className="min-w-0">{line.name}</span>
            </p>
            {showOwner ? (
              <p className="mt-1 text-xs text-ink-subtle">Added by {line.addedBy}</p>
            ) : null}
          </div>
          <span className="shrink-0 text-sm font-semibold text-ink tabular-nums">
            {formatPrice(line.amount)}
          </span>
        </li>
      ))}
    </ul>
  );
}
