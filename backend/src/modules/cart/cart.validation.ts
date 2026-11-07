/* Cart module — request contracts.

   Ported verbatim from validation/schemas.ts: the HTTP messages and numeric
   bounds are part of the compatibility contract with the diner UI and the
   assistant's tool layer. */

import { z } from "zod";
import {
  note,
  pagination,
  tableToken,
  uuid,
} from "../../validation/primitives.js";

/** E4 GET /api/v1/cart/items */
export const cartListQuerySchema = z.object({ table_token: tableToken, ...pagination });

/** E5 POST /api/v1/cart/items */
export const cartAddSchema = z.object({
  table_token: tableToken,
  menu_item_id: uuid("menu_item_id"),
  quantity: z.coerce.number().int("quantity must be an integer between 1 and 99.").min(1, "quantity must be an integer between 1 and 99.").max(99, "quantity must be an integer between 1 and 99.").default(1),
  allergy_note: note.optional(),
  request_note: note.optional(),
  /* Who put it in the cart, taken from the name the gate collected. Required:
     an unnamed cart line becomes an unnamed ticket, which is what made the
     split bill read as one anonymous "Guest" tab. */
  added_by: z
    .string()
    .trim()
    .min(1, "added_by is required — a dish must belong to someone at the table.")
    .max(40, "added_by must be 40 characters or fewer."),
});

/** E6 PATCH /api/v1/cart/items/:cart_item_id */
export const cartUpdateSchema = z
  .object({
    table_token: tableToken,
    // Absolute "set to N" (last write wins) — kept for contract compat.
    quantity: z.coerce.number().int("quantity must be an integer between 1 and 99.").min(1, "quantity must be an integer between 1 and 99; use DELETE to remove a line.").max(99, "quantity must be an integer between 1 and 99.").optional(),
    // +/- steppers send a DELTA instead: the server applies it atomically
    // (quantity = quantity + delta), so two phones tapping at once can no
    // longer overwrite each other with stale absolute values.
    quantity_delta: z.coerce
      .number()
      .int("quantity_delta must be a whole number between -99 and 99.")
      .min(-99, "quantity_delta must be between -99 and 99.")
      .max(99, "quantity_delta must be between -99 and 99.")
      .refine((value) => value !== 0, {
        message: "quantity_delta must not be 0; use DELETE to remove a line.",
      })
      .optional(),
    request_note: note.optional(),
    allergy_note: note.optional(),
  })
  .refine(
    (body) =>
      body.quantity !== undefined ||
      body.quantity_delta !== undefined ||
      body.request_note !== undefined ||
      body.allergy_note !== undefined,
    { message: "Provide at least one of quantity, quantity_delta, request_note, allergy_note." },
  );

/** E6 path params */
export const cartItemParamsSchema = z.object({ cart_item_id: uuid("cart_item_id") });

/** E7 DELETE /api/v1/cart/items */
export const cartDeleteSchema = z.object({
  table_token: tableToken,
  cart_item_id: uuid("cart_item_id"),
});
