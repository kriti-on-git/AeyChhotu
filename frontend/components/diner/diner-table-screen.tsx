"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CartModal } from "@/components/diner/cart-modal";
import { CartStrip } from "@/components/diner/cart-strip";
import { InactiveTableState } from "@/components/diner/inactive-table-state";
import { MenuList } from "@/components/diner/menu-list";
import { TableSessionHeader } from "@/components/diner/table-session-header";
import { LandscapeScene } from "@/components/landscape/landscape-scene";
import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import { usePresence } from "@/hooks/use-presence";
import { useTableData } from "@/hooks/use-table-data";
import { addCartLine } from "@/lib/api";
import { getStoredDisplayName, storeDisplayName, storeTableToken } from "@/lib/api/session";
import type { MenuItem } from "@/lib/api/types";
import { formatPrice } from "@/lib/format";

export interface DinerTableScreenProps {
  tableToken: string;
}

export function DinerTableScreen({ tableToken }: DinerTableScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { table, menu, cart, quantities, totals, activeOrder, soldOutInCart } =
    useTableData(tableToken);

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

    const result = await addCartLine({
      table_token: tableToken,
      menu_item_id: item.id,
      added_by: displayName,
    });

    setPendingItemId(null);

    if (!result.ok) {
      toast({ title: result.message, tone: "error" });
      return;
    }

    toast({ title: `${item.name} added`, description: "Everyone at the table can see it now." });
  }

  if (!table) return <InactiveTableState />;

  return (
    <main id="main" className="min-h-dvh pb-32">
      <TableSessionHeader table={table} hasActiveOrder={Boolean(activeOrder)} />

      <div className="relative isolate overflow-hidden border-b border-line">
        <LandscapeScene depth="soft" />
        <Container className="relative z-10 py-12">
          <Text variant="label" tone="subtle">
            Scan-to-order session
          </Text>
          <Heading level="title" as="h1" className="mt-3">
            {table.name}
          </Heading>
          <Text variant="lead" tone="muted" className="mt-4 max-w-2xl">
            Add what you want to the shared cart. Nothing reaches the kitchen until someone at the
            table taps review and fire.
          </Text>
        </Container>
      </div>

      <Container className="grid gap-12 py-12 lg:grid-cols-[1.7fr_1fr] lg:items-start">
        <MenuList
          menu={menu}
          quantities={quantities}
          pendingItemId={pendingItemId}
          onAdd={(item) => void handleAdd(item)}
        />

        <aside className="flex flex-col gap-5 lg:sticky lg:top-24" aria-label="Live table cart">
          <Card tone="canvas">
            <CardHeader>
              <CardTitle>Live table cart</CardTitle>
              <CardDescription>
                {totals.itemCount === 0
                  ? "Empty right now. Anything you add shows up here and on every other phone."
                  : `${totals.itemCount} items · ${formatPrice(totals.total)}`}
              </CardDescription>
            </CardHeader>

            {soldOutInCart.length > 0 ? (
              <Text variant="small" tone="alert" className="mt-5">
                Sold out since it was added: {soldOutInCart.map((item) => item.name).join(", ")}.
              </Text>
            ) : null}

            <div className="mt-6 flex flex-col gap-3">
              <Button
                size="lg"
                fullWidth
                disabled={cart.length === 0}
                onClick={() => setCartOpen(true)}
              >
                Review &amp; fire
              </Button>
              {cart.length > 0 ? (
                <Button size="sm" variant="ghost" fullWidth onClick={() => setCartOpen(true)}>
                  Edit quantities and notes
                </Button>
              ) : null}
            </div>
          </Card>

          {activeOrder ? (
            <Card tone="ink">
              <CardHeader>
                <span className="text-label text-tan uppercase">Order in the kitchen</span>
                <CardTitle className="text-cream">Status: {activeOrder.status}</CardTitle>
                <CardDescription className="text-cream/75">
                  A second fire is blocked until this order is served.
                </CardDescription>
              </CardHeader>
              <Link
                href={`/table/${table.code}/tracker`}
                className={buttonStyles({ variant: "secondary", size: "md", fullWidth: true, className: "mt-6" })}
              >
                Open live tracker
              </Link>
            </Card>
          ) : null}
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
