"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { MenuItemRow } from "@/components/diner/menu-item-row";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import type { MenuItem } from "@/lib/api/types";

export interface MenuListProps {
  menu: MenuItem[];
  quantities: Record<string, number>;
  pendingItemId: string | null;
  onAdd: (item: MenuItem) => void;
}

export function MenuList({ menu, quantities, pendingItemId, onAdd }: MenuListProps) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? menu.filter(
          (item) =>
            item.name.toLowerCase().includes(needle) ||
            item.category.toLowerCase().includes(needle) ||
            item.description.toLowerCase().includes(needle),
        )
      : menu;

    const byCategory = new Map<string, MenuItem[]>();
    for (const item of filtered) {
      const bucket = byCategory.get(item.category) ?? [];
      bucket.push(item);
      byCategory.set(item.category, bucket);
    }

    return [...byCategory.entries()];
  }, [menu, query]);

  return (
    <div className="flex flex-col gap-8">
      <Input
        label="Search the menu"
        placeholder="Dosa, biryani, chai…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        leadingIcon={<Search className="size-4" aria-hidden />}
      />

      {groups.length === 0 ? (
        <EmptyState
          title="Nothing matches that"
          description="Try a different dish, or clear the search to see the full menu."
        />
      ) : (
        groups.map(([category, items]) => (
          <section key={category} className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-4 border-b-2 border-dark-brown/15 pb-3">
              <h2 className="font-display text-heading text-ink">{category}</h2>
              <Text variant="caption" tone="subtle">
                {items.length} {items.length === 1 ? "dish" : "dishes"}
              </Text>
            </div>

            <ul className="flex flex-col">
              {items.map((item) => (
                <MenuItemRow
                  key={item.id}
                  item={item}
                  quantityInCart={quantities[item.id] ?? 0}
                  pending={pendingItemId === item.id}
                  onAdd={onAdd}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
