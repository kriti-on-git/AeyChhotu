/* Cart module — business rules.

   The cart belongs to the table session, not the device: every read and write
   resolves table_token first and every write re-asserts table_id in SQL. Add
   is a single conflict-safe statement; stepper updates lock the line and apply
   the delta inside one transaction. Realtime publication happens only after a
   successful write and can never turn a committed cart change into an HTTP
   failure. */

import { AppError } from "../../errors/app-error.js";
import { buildMeta } from "../../lib/util.js";
import { CART_EVENTS } from "./cart.events.js";
import type {
  CartAddInput,
  CartLineWithTotal,
  CartListParams,
  CartMenuPort,
  CartRealtimeAction,
  CartRealtimePayload,
  CartRealtimePort,
  CartRemovalResult,
  CartRepositoryPort,
  CartRow,
  CartServicePort,
  CartTablePort,
  CartUpdateInput,
} from "./cart.types.js";

export interface CartServiceDeps {
  readonly repository: CartRepositoryPort;
  readonly tables: CartTablePort;
  readonly menu: CartMenuPort;
  readonly realtime: CartRealtimePort;
  readonly onPublishError?: (err: unknown) => void;
}

const MAX_QUANTITY = 99;

export class CartService implements CartServicePort {
  private readonly repository: CartRepositoryPort;
  private readonly tables: CartTablePort;
  private readonly menu: CartMenuPort;
  private readonly realtime: CartRealtimePort;
  private readonly onPublishError?: (err: unknown) => void;

  constructor(deps: CartServiceDeps) {
    this.repository = deps.repository;
    this.tables = deps.tables;
    this.menu = deps.menu;
    this.realtime = deps.realtime;
    this.onPublishError = deps.onPublishError;
  }

  /* E4 — REST bootstrap before realtime attaches. */
  async listCart(params: CartListParams): Promise<{
    data: CartRow[];
    meta: import("../../lib/util.js").PageMeta;
  }> {
    const table = await this.tables.requireTable(params.table_token);
    const total = await this.repository.countForTable(table.id);
    const data = await this.repository.listForTable(
      table.id,
      params.limit,
      (params.page - 1) * params.limit,
    );
    return { data, meta: buildMeta(params.page, params.limit, total) };
  }

  /* E5 — atomic upsert. Availability is a fast pre-check; fire_order() owns
     the authoritative inventory decision. */
  async addItem(input: CartAddInput): Promise<CartLineWithTotal> {
    const table = await this.tables.requireTable(input.table_token);

    const menuItem = await this.menu.findCartItem(input.menu_item_id);
    if (!menuItem) {
      throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
    }
    if (!menuItem.is_available) {
      throw new AppError(409, "ITEM_UNAVAILABLE", `${menuItem.name} just ran out.`);
    }

    const row = await this.repository.addLine(table.id, {
      menuItemId: input.menu_item_id,
      quantity: input.quantity,
      requestNote: input.request_note ?? "",
      allergyNote: input.allergy_note ?? "",
      addedBy: input.added_by.trim(),
    });

    const line = {
      ...row,
      total_table_quantity: await this.repository.totalForTableItem(
        table.id,
        row.menu_item_id,
      ),
    };
    this.publish(table.id, "added", line);
    return line;
  }

  /* E6 — absolute and delta modes in one transaction. Editing notes onto an
     existing identical line merges the two instead of raising 23505. */
  async updateItem(
    cartItemId: string,
    input: CartUpdateInput,
  ): Promise<CartLineWithTotal> {
    const table = await this.tables.requireTable(input.table_token);
    if (!(await this.repository.findLine(table.id, cartItemId))) {
      throw new AppError(404, "CART_ITEM_NOT_FOUND", "That cart line no longer exists.");
    }

    const row = await this.repository.transaction(async (tx) => {
      const line = await tx.lockLine(table.id, cartItemId);
      if (!line) {
        throw new AppError(404, "CART_ITEM_NOT_FOUND", "That cart line no longer exists.");
      }

      const nextQuantity =
        input.quantity_delta !== undefined
          ? line.quantity + input.quantity_delta
          : (input.quantity ?? line.quantity);

      if (
        !Number.isInteger(nextQuantity) ||
        nextQuantity < 1 ||
        nextQuantity > MAX_QUANTITY
      ) {
        throw new AppError(400, "VALIDATION_ERROR", "Quantity must stay between 1 and 99.", {
          fields: { quantity_delta: "Resulting quantity must be between 1 and 99." },
        });
      }

      const nextRequestNote = input.request_note ?? line.request_note;
      const nextAllergyNote = input.allergy_note ?? line.allergy_note;
      const notesChanged =
        nextRequestNote !== line.request_note ||
        nextAllergyNote !== line.allergy_note;

      if (!notesChanged) {
        const updated = await tx.updateLine(
          line.id,
          table.id,
          nextQuantity,
          line.request_note,
          line.allergy_note,
        );
        if (!updated) {
          throw new AppError(404, "CART_ITEM_NOT_FOUND", "That cart line no longer exists.");
        }
        return updated;
      }

      const existing = await tx.findClashingLine(
        table.id,
        line.menu_item_id,
        nextRequestNote,
        nextAllergyNote,
        line.id,
      );

      if (existing) {
        const merged = await tx.mergeLine(existing.id, nextQuantity);
        await tx.deleteLine(line.id);
        if (!merged) {
          throw new AppError(404, "CART_ITEM_NOT_FOUND", "That cart line no longer exists.");
        }
        return merged;
      }

      const updated = await tx.updateLine(
        line.id,
        table.id,
        nextQuantity,
        nextRequestNote,
        nextAllergyNote,
      );
      if (!updated) {
        throw new AppError(404, "CART_ITEM_NOT_FOUND", "That cart line no longer exists.");
      }
      return updated;
    });

    const result = {
      ...row,
      total_table_quantity: await this.repository.totalForTableItem(
        table.id,
        row.menu_item_id,
      ),
    };
    this.publish(table.id, "updated", result);
    return result;
  }

  /* E7 — ownership is proven before delete and re-asserted in the statement. */
  async removeItem(
    tableToken: string,
    cartItemId: string,
  ): Promise<CartRemovalResult> {
    const table = await this.tables.requireTable(tableToken);
    if (!(await this.repository.findLine(table.id, cartItemId))) {
      throw new AppError(404, "CART_ITEM_NOT_FOUND", "That cart line no longer exists.");
    }

    const deleted = await this.repository.deleteLine(table.id, cartItemId);
    if (!deleted) {
      throw new AppError(404, "CART_ITEM_NOT_FOUND", "That cart line no longer exists.");
    }

    this.publish(table.id, "removed", null);
    return { id: cartItemId, message: "Line item purged from table cart." };
  }

  async clearCart(tableToken: string): Promise<{ removed: number }> {
    const table = await this.tables.requireTable(tableToken);
    const removed = await this.repository.deleteForTable(table.id);
    if (removed > 0) this.publish(table.id, "cleared", null);
    return { removed };
  }

  /* Realtime is an observer of a committed write. A transport or payload
     failure is reported to composition, never surfaced as a failed mutation. */
  private publish(
    tableId: string,
    action: CartRealtimeAction,
    line: CartLineWithTotal | null,
  ): void {
    const payload: CartRealtimePayload = {
      table_id: tableId,
      action,
      line,
    };
    try {
      this.realtime.toTable(tableId, CART_EVENTS[action], payload);
    } catch (err) {
      this.onPublishError?.(err);
    }
  }
}
