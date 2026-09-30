"use client";

import { Flame, ShoppingBasket, Timer } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CartModal } from "@/components/diner/cart-modal";
import { CartStrip } from "@/components/diner/cart-strip";
import { InactiveTableState } from "@/components/diner/inactive-table-state";
import { MenuBrowser } from "@/components/diner/menu-browser";
import { TableCart } from "@/components/diner/table-cart";
import { Button, buttonStyles } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { Heading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/loading-state";
import { useToast } from "@/components/ui/toast";
import { usePresence } from "@/hooks/use-presence";
import { useLiveTable } from "@/hooks/use-live-table";
import { getStoredDisplayName, storeDisplayName, storeTableToken } from "@/lib/api/session";
import type { MenuItem } from "@/lib/api/types";

export interface DinerTableScreenProps {
  tableToken: string;
}

/* The four moves this screen has to make obvious, in order. The first three
   are what the guest does; the fourth is what the kitchen does about it. */
const sessionSteps = [
  { icon: ShoppingBasket, title: "Browse", body: "Open a menu, then a section." },
  { icon: Flame, title: "Swipe or tap", body: "Right to add, left to skip." },
  { icon: Timer, title: "Fire once", body: "One grouped ticket to the kitchen." },
];

export function DinerTableScreen({ tableToken }: DinerTableScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const live = useLiveTable(tableToken);
  const { table, menu, quantities, totals, activeOrder, itemErrors } = live;

  const [cartOpen, setCartOpen] = useState(false);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  // The value is only ever rendered inside the cart modal, which opens after
  // hydration, so reading storage in the initialiser cannot mismatch the SSR HTML.
  const [displayName, setDisplayName] = useState(() => getStoredDisplayName());

  usePresence(tableToken);

  useEffect(() => {
    storeTableToken(tableToken);
  }, [tableToken]);

  function handleDisplayNameChange(name: string) {
    setDisplayName(name);
    storeDisplayName(name);
  }

  async function handleAdd(item: MenuItem) {
    setPendingItemId(item.id);

    const result = await live.addToCart(item, displayName);

    setPendingItemId(null);

    if (!result.ok) {
      toast({
        title: result.message ?? `${item.name} could not be added.`,
        tone: "error",
      });
      return;
    }

    toast({ title: `${item.name} added`, description: "Everyone at the table can see it now." });
  }

  // ---- State matrix: loading ---------------------------------------------
  if (live.phase === "loading") return <DinerSkeleton />;

  // ---- State matrix: error (specific message + Retry Connection) ---------
  if (live.phase === "error") {
    if (live.error?.error === "TABLE_NOT_FOUND") return <InactiveTableState />;

    return (
      <main id="main" className="min-h-dvh">
        <Container size="narrow" className="py-16">
          <EmptyState
            tone="alert"
            titleAs="h1"
            title="We lost the connection to the kitchen"
            description={live.error?.message ?? "Please try again in a moment."}
            action={
              <Button variant="ember" size="md" onClick={live.retry}>
                Retry Connection
              </Button>
            }
          />
        </Container>
      </main>
    );
  }

  if (!table) return <InactiveTableState />;

  return (
    <main id="main" className="min-h-dvh pb-32">
      {/* One row, no session chrome: the guest only needs the instruction, so
          the page opens on "Ready to order?" beside the three moves. */}
      <div className="border-b border-line bg-surface">
        <Container className="flex flex-col gap-6 py-7 sm:py-8 lg:flex-row lg:items-center lg:justify-between lg:gap-12">
          {/* No table identifier: the token in the URL is the capability
              credential, so it must never be shown to the diner. */}
          <Heading level="title" as="h1" className="font-bold text-ember">
            Ready to order?
          </Heading>

          <ol className="grid gap-4 sm:grid-cols-3 lg:max-w-xl lg:shrink-0">
              {sessionSteps.map((step, index) => (
                <li key={step.title} className="flex gap-3 sm:flex-col sm:gap-2">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-ember-soft text-ember">
                    <step.icon className="size-4" aria-hidden />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-ink">
                      <span className="text-ink-subtle tabular-nums">
                        {String(index + 1).padStart(2, "0")}
                      </span>{" "}
                      {step.title}
                    </p>
                    <p className="text-xs leading-snug text-ink-muted">{step.body}</p>
                  </div>
                </li>
              ))}
          </ol>
        </Container>
      </div>

      {/* An order already in the kitchen outranks everything below it, so it
          gets one full-width line rather than a card in the column. */}
      {activeOrder ? (
        <div className="border-b border-line bg-ink text-ink-inverse">
          <Container className="flex flex-wrap items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-md bg-ink-inverse/10"
              >
                <Flame className="size-4" />
              </span>
              <div>
                <p className="text-sm font-semibold capitalize">
                  Order {activeOrder.status} in the kitchen
                </p>
                <p className="text-xs text-ink-inverse/70">
                  A second fire is blocked until this one is served.
                </p>
              </div>
            </div>
            <Link
              href={`/table/${table.code}/tracker`}
              className={buttonStyles({ variant: "ember", size: "sm" })}
            >
              Open live tracker
            </Link>
          </Container>
        </div>
      ) : null}

      <Container className="grid gap-12 py-12 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-14">
        {menu.length === 0 ? (
          // ---- State matrix: empty catalog ------------------------------
          <EmptyState
            titleAs="h2"
            title="The menu is being stocked"
            description="No dishes are showing right now. Refresh and the kitchen's list appears the moment it lands."
            action={
              <Button variant="soft" size="md" onClick={() => void live.refresh()}>
                Refresh menu
              </Button>
            }
          />
        ) : (
          <MenuBrowser
            menu={menu}
            quantities={quantities}
            pendingItemId={pendingItemId}
            itemErrors={itemErrors}
            onAdd={(item) => void handleAdd(item)}
            onReview={() => setCartOpen(true)}
            cartItemCount={totals.itemCount}
          />
        )}

        {/* Desktop: the cart sits in view the whole time. On a phone it would
            be half the screen, so there it becomes the bar below instead. */}
        <aside className="hidden lg:sticky lg:top-28 lg:block" aria-label="Live table cart">
          <TableCart live={live} onReview={() => setCartOpen(true)} />
        </aside>
      </Container>

      <CartStrip
        itemCount={totals.itemCount}
        total={totals.total}
        onView={() => setCartOpen(true)}
      />

      <CartModal
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        tableToken={tableToken}
        live={live}
        displayName={displayName}
        onDisplayNameChange={handleDisplayNameChange}
        onFired={() => {
          setCartOpen(false);
          toast({
            title: "Order fired",
            description: "The kitchen has one grouped ticket for this table.",
            tone: "success",
          });
          router.push(`/table/${tableToken}/tracker`);
        }}
      />
    </main>
  );
}

/* Loading state: same page shell and grid columns as the real screen so the
   layout shift stays stable while the first snapshot streams in. */
function DinerSkeleton() {
  return (
    <main id="main" className="min-h-dvh pb-32">
      <div className="border-b border-line bg-surface">
        <Container className="flex flex-col gap-6 py-7 sm:py-8 lg:flex-row lg:items-center lg:justify-between lg:gap-12">
          <Skeleton className="h-9 w-64 max-w-full" />
          <div className="grid gap-4 sm:grid-cols-3 lg:w-full lg:max-w-xl lg:shrink-0">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        </Container>
      </div>

      <Container className="grid gap-12 py-12 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-14">
        <div className="flex flex-col gap-6">
          <Skeleton className="h-12 w-full rounded-md" />
          <div className="grid gap-5 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-4 rounded-xl border border-line p-3">
                <Skeleton className="aspect-[4/3] w-full rounded-lg" />
                <Skeleton className="h-5 w-36" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-9 w-24" />
              </div>
            ))}
          </div>
        </div>

        <div className="hidden rounded-lg border border-line bg-surface p-6 lg:block">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-3 h-4 w-56" />
          <Skeleton className="mt-6 h-13 w-full rounded-md" />
        </div>
      </Container>
    </main>
  );
}
