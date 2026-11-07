/* Inventory module — request validators.

   These are additive endpoints, so nothing here rewrites an existing schema.
   Counts are whole numbers; stock may be set to null (untracked) but never a
   negative value. Client-supplied reasons are restricted to the ledger enum. */

import { z } from "zod";
import { uuid } from "../../validation/primitives.js";

const STOCK_REASONS = [
  "manual",
  "delivery",
  "wastage",
  "stocktake",
  "order",
  "order_restore",
] as const;

const stockCount = z.coerce
  .number()
  .int("Stock must be a whole number.")
  .min(0, "Stock cannot be negative.")
  .max(1_000_000, "Stock is unrealistically high.");

export const inventoryItemParamsSchema = z.object({
  menu_item_id: uuid("menu_item_id"),
});

export const inventoryQuerySchema = z.object({
  state: z.enum(["out", "low", "ok", "untracked"]).optional(),
});

export const inventoryMovementsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const setStockSchema = z
  .object({
    stock_quantity: stockCount.nullable().optional(),
    low_stock_threshold: stockCount.optional(),
  })
  .refine(
    (body) =>
      body.stock_quantity !== undefined || body.low_stock_threshold !== undefined,
    { message: "Provide a stock count or a low-stock threshold." },
  );

export const adjustStockSchema = z.object({
  delta: z.coerce
    .number()
    .int("The adjustment must be a whole number.")
    .min(-1_000_000)
    .max(1_000_000)
    .refine((value) => value !== 0, "The adjustment cannot be zero."),
  reason: z.enum(STOCK_REASONS),
  order_id: uuid("order_id").nullable().optional(),
});

export const restoreStockSchema = z.object({
  quantity: z.coerce
    .number()
    .int("The restored quantity must be a whole number.")
    .min(1, "Restore at least one unit.")
    .max(1_000_000),
  order_id: uuid("order_id").nullable().optional(),
});
