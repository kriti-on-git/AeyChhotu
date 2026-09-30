"use client";

import Link from "next/link";
import { ActiveDinersBadge } from "@/components/diner/active-diners-badge";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import type { RestaurantTable } from "@/lib/api/types";
import { formatTableLabel } from "@/lib/format";

export interface TableSessionHeaderProps {
  table: RestaurantTable;
  hasActiveOrder: boolean;
}

export function TableSessionHeader({ table, hasActiveOrder }: TableSessionHeaderProps) {
  return (
    <div className="sticky top-0 z-30 border-b border-line bg-canvas/88 backdrop-blur-md">
      <Container className="flex flex-wrap items-center justify-between gap-3 py-3.5">
        <div className="flex items-center gap-3">
          <Badge tone="brand" size="md">
            {formatTableLabel(table.code)}
          </Badge>
          <span className="text-sm font-medium text-ink-muted">{table.name}</span>
        </div>

        <div className="flex items-center gap-3">
          <ActiveDinersBadge tableToken={table.code} />
          {hasActiveOrder ? (
            <Link
              href={`/table/${table.code}/tracker`}
              className={buttonStyles({ variant: "ember", size: "sm" })}
            >
              Track live order
            </Link>
          ) : null}
        </div>
      </Container>
    </div>
  );
}
