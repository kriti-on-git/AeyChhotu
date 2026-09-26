"use client";

import { useMemo } from "react";
import { useDb } from "@/hooks/use-db";
import type { CartLine, MenuItem, Order, RestaurantTable } from "@/lib/api/types";

export interface CartTotals {
  lineCount: number;
  itemCount: number;
  total: number;
}

export interface TableData {
  table: RestaurantTable | null;
  menu: MenuItem[];
  cart: CartLine[];
  quantities: Record<string, number>;
  totals: CartTotals;
  menuIndex: Map<string, MenuItem>;
  activeOrder: Order | null;
  orders: Order[];
  soldOutInCart: MenuItem[];
}

const ACTIVE_STATUSES = ["pending", "preparing", "ready"];

/* Derives every read the diner screens need from the single store snapshot,
   so the menu, the cart strip and the tracker can never disagree. */
export function useTableData(tableToken: string): TableData {
  const db = useDb();

  const table = db.tables.find((entry) => entry.code === tableToken) ?? null;

  const menuIndex = useMemo(() => new Map(db.menu.map((item) => [item.id, item])), [db.menu]);

  const cart = useMemo(
    () => (table ? db.cart.filter((line) => line.table_id === table.id) : []),
    [db.cart, table],
  );

  const orders = useMemo(
    () => (table ? db.orders.filter((order) => order.table_id === table.id) : []),
    [db.orders, table],
  );

  const quantities = useMemo(() => {
    const map: Record<string, number> = {};
    for (const line of cart) {
      map[line.menu_item_id] = (map[line.menu_item_id] ?? 0) + line.quantity;
    }
    return map;
  }, [cart]);

  const totals = useMemo(() => {
    return cart.reduce<CartTotals>(
      (accumulator, line) => {
        const item = menuIndex.get(line.menu_item_id);
        return {
          lineCount: accumulator.lineCount + 1,
          itemCount: accumulator.itemCount + line.quantity,
          total: accumulator.total + (item?.price ?? 0) * line.quantity,
        };
      },
      { lineCount: 0, itemCount: 0, total: 0 },
    );
  }, [cart, menuIndex]);

  const activeOrder =
    orders
      .filter((order) => ACTIVE_STATUSES.includes(order.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .at(0) ?? null;

  const soldOutInCart = cart
    .map((line) => menuIndex.get(line.menu_item_id))
    .filter((item): item is MenuItem => item !== undefined && !item.is_available);

  return {
    table,
    menu: db.menu,
    cart,
    quantities,
    totals,
    menuIndex,
    activeOrder,
    orders,
    soldOutInCart,
  };
}
