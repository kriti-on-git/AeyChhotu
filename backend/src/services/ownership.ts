import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import { requireTable, type TableRecord } from "./sessions.service.js";

/* Session Ownership Validation Helper — the application-level half of
   data isolation (docs/7 §1.4 capability model; RLS is the database half).

   Rule: a consumer session IS its table_token. Every diner-scoped query
   resolves the table from the presented token first, then proves that the
   resource it is about to touch belongs to that exact table. An id that
   belongs to an adjacent table fails the ownership predicate and surfaces
   as the SAME 404 as a non-existent id — existence is never leaked. */

export interface OwnedCartLine {
  table: TableRecord;
  line: {
    id: string;
    table_id: string;
    menu_item_id: string;
    quantity: number;
    request_note: string;
    allergy_note: string;
    added_by: string;
  };
}

/** Resolves table_token (404 TABLE_NOT_FOUND) and requires the cart line
   to live in that table's cart (404 CART_ITEM_NOT_FOUND otherwise). */
export async function ownedCartLine(
  cartItemId: string,
  tableToken: string,
): Promise<OwnedCartLine> {
  const table = await requireTable(tableToken);

  const res = await pool.query<OwnedCartLine["line"]>(
    `SELECT id, table_id, menu_item_id, quantity, request_note, allergy_note, added_by
       FROM cart_items
      WHERE id = $1 AND table_id = $2`,
    [cartItemId, table.id],
  );

  const line = res.rows[0];
  if (!line) {
    // Requesting another table's cart_item_id lands here too.
    throw new AppError(404, "CART_ITEM_NOT_FOUND", "That cart line no longer exists.");
  }

  return { table, line };
}
