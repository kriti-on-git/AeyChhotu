"use client";

import { Activity, Pencil, Receipt, UserRound, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { BillScope } from "@/components/diner/bill-drawer";
import { Container } from "@/components/ui/container";
import { Tooltip } from "@/components/ui/tooltip";
import type { LiveTableValue } from "@/hooks/use-live-table";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface DinerNavBarProps {
  tableToken: string;
  live: LiveTableValue;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
  /** Opens the bill breakdown panel on the requested slice. */
  onOpenBill: (scope: BillScope) => void;
}

/* The charcoal band is this surface's whole navigation. Who you are sits on
   the left — editable, because the table reads that name beside every line
   you add — and the three things a guest reaches for sit on the right: the
   live tracker and the two running bills. Amounts stay in tooltips so the
   band reads as three quiet icons rather than a dashboard. */
export function DinerNavBar({
  tableToken,
  live,
  displayName,
  onDisplayNameChange,
  onOpenBill,
}: DinerNavBarProps) {
  const { menuIndex, orders, cart, activeOrder } = live;
  const headerRef = useRef<HTMLElement>(null);

  /* Publish the band's height so the sticky menu search can dock beneath it
     instead of sliding under it while the guest scrolls. */
  useEffect(() => {
    const node = headerRef.current;
    if (!node) return;

    const apply = () =>
      document.documentElement.style.setProperty("--diner-nav-h", `${node.offsetHeight}px`);

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Everything the table has already fired, plus whatever is staged now.
  const firedTotal = orders.reduce(
    (sum, order) => sum + order.items.reduce((line, item) => line + item.price * item.quantity, 0),
    0,
  );
  const stagedTotal = cart.reduce(
    (sum, line) => sum + (menuIndex.get(line.menu_item_id)?.price ?? 0) * line.quantity,
    0,
  );
  const totalBill = firedTotal + stagedTotal;

  // Just this guest's share: the lines they added, fired or still staged.
  const firedMine = orders.reduce(
    (sum, order) =>
      sum +
      order.items
        .filter((item) => item.added_by === displayName)
        .reduce((line, item) => line + item.price * item.quantity, 0),
    0,
  );
  const stagedMine = cart
    .filter((line) => line.added_by === displayName)
    .reduce((sum, line) => sum + (menuIndex.get(line.menu_item_id)?.price ?? 0) * line.quantity, 0);
  const myBill = firedMine + stagedMine;

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-40 border-b border-ink/40 bg-ink text-ink-inverse"
    >
      <Container className="flex flex-wrap items-center gap-x-4 gap-y-3 py-3">
        <DinerIdentity displayName={displayName} onChange={onDisplayNameChange} />

        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip label="Would you like to open live tracker?" side="bottom">
            <Link
              href={`/table/${tableToken}/tracker`}
              aria-label="Open live tracker"
              className={cn(actionClass, "relative")}
            >
              <Activity className="size-5" aria-hidden />
              {activeOrder ? (
                <span
                  aria-hidden
                  className="absolute top-2.5 right-2.5 size-2 animate-pulse-soft rounded-pill bg-ember ring-2 ring-ink"
                />
              ) : null}
            </Link>
          </Tooltip>

          <Tooltip label={`Total bill · ${formatPrice(totalBill)}`} side="bottom">
            <button
              type="button"
              onClick={() => onOpenBill("total")}
              aria-label={`Open the total bill breakdown: ${formatPrice(totalBill)}`}
              className={actionClass}
            >
              <Receipt className="size-5" aria-hidden />
            </button>
          </Tooltip>

          <Tooltip label={`Your part · ${formatPrice(myBill)}`} side="bottom">
            <button
              type="button"
              onClick={() => onOpenBill("mine")}
              aria-label={`Open your part of the bill: ${formatPrice(myBill)}`}
              className={actionClass}
            >
              <Wallet className="size-5" aria-hidden />
            </button>
          </Tooltip>
        </div>
      </Container>
    </header>
  );
}

const actionClass =
  "inline-flex size-10 items-center justify-center rounded-md text-ink-inverse/75 transition-colors duration-[var(--duration-fast)] ease-gentle hover:bg-ink-inverse/10 hover:text-ink-inverse focus-visible:bg-ink-inverse/10 focus-visible:text-ink-inverse focus-visible:outline-none";

/* The guest's own name, editable in place. Committing it updates the shared
   display name, so the next dish they add carries it and every other phone at
   the table (and the kitchen ticket) sees who ordered what. */
function DinerIdentity({
  displayName,
  onChange,
}: {
  displayName: string;
  onChange: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  // Seed the draft from the current name only when the editor opens, so
  // edits made elsewhere (the cart modal) are picked up and no state is
  // synchronised inside an effect.
  function startEditing() {
    setDraft(displayName);
    setEditing(true);
  }

  function commit() {
    const next = draft.trim();
    onChange(next || "Guest");
    setEditing(false);
  }

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-md bg-ink-inverse/10 text-ink-inverse/80"
      >
        <UserRound className="size-5" />
      </span>

      <div className="min-w-0">
        <p className="text-label text-ink-inverse/55 uppercase">Ordering as</p>

        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            maxLength={24}
            aria-label="Your name at this table"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") {
                setDraft(displayName);
                setEditing(false);
              }
            }}
            className="w-32 border-b border-ember/70 bg-transparent font-display text-base font-semibold text-ink-inverse outline-none sm:w-40"
          />
        ) : (
          <button
            type="button"
            onClick={startEditing}
            aria-label={`Edit your name (currently ${displayName})`}
            className="group flex max-w-40 cursor-pointer items-center gap-1.5 rounded-sm text-left"
          >
            <span className="truncate font-display text-base font-semibold text-ink-inverse">
              {displayName}
            </span>
            <Pencil
              className="size-3.5 shrink-0 text-ink-inverse/50 transition-colors duration-[var(--duration-fast)] group-hover:text-ember"
              aria-hidden
            />
          </button>
        )}
      </div>
    </div>
  );
}
