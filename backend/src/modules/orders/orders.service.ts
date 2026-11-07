/* Orders module — business rules.

   CREATION IS ONE SERVER-SIDE TRANSACTION. `repo.fire()` executes the
   `fire_order()` RPC, which serializes concurrent fires on the table row,
   refuses a duplicate active round, freezes the cart snapshot, validates
   inventory, snapshots unit prices and the total, inserts the ticket and
   drains exactly those cart lines. There is no code path here that inserts
   an order header and then fails to insert its items.

   The service translates that single result into the HTTP contract (the same
   status codes and messages as before), publishes the domain facts AFTER the
   commit, and owns the denied-round lifecycle (requeue / retry / dismiss),
   which is composed from the repository's transaction port. */

import { AppError } from "../../errors/app-error.js";
import { buildMeta, iso } from "../../lib/util.js";
import type {
  DeniedLineRow,
  FiredOrder,
  FireResult,
  OrderListItem,
  OrdersEventPublisher,
  OrdersListParams,
  OrdersPage,
  OrdersRepositoryPort,
  OrdersServicePort,
  OrdersTablePort,
  OrderStatus,
  RequeuedDeniedOrder,
  RetriedDeniedOrder,
  DismissedDeniedOrder,
} from "./orders.types.js";

export interface OrdersServiceDeps {
  readonly repository: OrdersRepositoryPort;
  readonly tables: OrdersTablePort;
  readonly events?: OrdersEventPublisher;
  readonly onPublishError?: (err: unknown) => void;
}

/** Item-name copy the diner reads on the tracker. */
export function denialReasonForSoldOutItem(name: string): string {
  return `Item ${name} went out of stock`;
}

function internalError(): AppError {
  return new AppError(500, "INTERNAL_ERROR", "Unexpected server error.");
}

export class OrdersService implements OrdersServicePort {
  private readonly repository: OrdersRepositoryPort;
  private readonly tables: OrdersTablePort;
  private readonly events?: OrdersEventPublisher;
  private readonly onPublishError?: (err: unknown) => void;

  constructor(deps: OrdersServiceDeps) {
    this.repository = deps.repository;
    this.tables = deps.tables;
    this.events = deps.events;
    this.onPublishError = deps.onPublishError;
  }

  /* E8 — POST /api/v1/orders/fire.

     The RPC predates archived tables (006), so the token is resolved through
     the Table module FIRST: that is the one place that owns the
     `deleted_at IS NULL` rule, and an archived table's URL must never fire. */
  async fireOrder(tableToken: string): Promise<FiredOrder> {
    await this.tables.requireTable(tableToken);

    const result = await this.repository.fire(tableToken);
    const fired = this.interpretFire(result);

    /* The order is committed at this point. A read that only feeds an event
       payload must not turn a successful fire into an HTTP failure. */
    let itemCount = 0;
    try {
      itemCount = await this.repository.countItems(fired.order_id);
    } catch {
      itemCount = 0;
    }

    this.publish(() =>
      this.events?.orderCreated({
        orderId: fired.order_id,
        tableId: fired.table_id,
        itemCount,
      }),
    );
    this.publish(() =>
      this.events?.ticketCreated({
        ticketId: fired.order_id,
        orderId: fired.order_id,
        tableId: fired.table_id,
      }),
    );

    return {
      order_id: fired.order_id,
      table_id: fired.table_id,
      status: fired.status,
      created_at: iso(fired.created_at),
      message: "Order successfully routed to KDS line.",
    };
  }

  /* E15 — status polling, scoped to the caller's table. Unknown id and
     another table's id both surface as the same 404: existence of a foreign
     order is never leaked. */
  async getOrderStatus(orderId: string, tableToken: string): Promise<OrderStatus> {
    const table = await this.tables.requireTable(tableToken);
    const row = await this.repository.findOrderForTable(orderId, table.id);
    if (!row) {
      throw new AppError(404, "ORDER_NOT_FOUND", "That order no longer exists.");
    }

    return {
      order_id: row.order_id,
      table_id: row.table_id,
      status: row.status,
      created_at: iso(row.created_at),
    };
  }

  /* E16 — history. Prices and totals come from order_items/orders, which were
     frozen at fire time, never from today's menu price. */
  async listOrders(params: OrdersListParams): Promise<OrdersPage> {
    const table = await this.tables.requireTable(params.table_token);

    const total = await this.repository.countForTable(table.id);
    const rows = await this.repository.listForTable(
      table.id,
      params.limit,
      (params.page - 1) * params.limit,
    );

    const data: OrderListItem[] = rows.map((row) => ({
      order_id: row.order_id,
      table_id: row.table_id,
      status: row.status,
      created_at: iso(row.created_at),
      denial_reason: row.denial_reason ?? "",
      total: Number(row.total ?? 0),
      items: row.items ?? [],
    }));

    return { data, meta: buildMeta(params.page, params.limit, total) };
  }

  /* Called by Menu whenever a dish flips to unavailable. Refusal is atomic
     per round; each stopped round is announced as a domain fact. */
  async denyPendingOrdersForItem(menuItemId: string, itemName: string): Promise<number> {
    const reason = denialReasonForSoldOutItem(itemName);
    const denied = await this.repository.denyPendingForItem(menuItemId, reason);

    for (const order of denied) {
      this.publish(() =>
        this.events?.orderDenied({
          orderId: order.order_id,
          tableId: order.table_id,
          reason,
        }),
      );
    }

    return denied.length;
  }

  /* POST /api/v1/orders/:order_id/requeue — "Move to list" and the second
     half of "Retry". Every line still available is merged back into the
     shared cart; sold-out lines are reported, never silently added; the
     refused ticket is removed because it was never cooked. */
  async requeueDeniedOrder(
    orderId: string,
    tableToken: string,
  ): Promise<RequeuedDeniedOrder> {
    return this.repository.transaction(async (tx) => {
      const order = await this.lockDeniedOrder(tx.lockOrderForTable(orderId, tableToken), orderId, "moved back to the cart");
      const lines = await tx.listLines(orderId);

      const available = lines.filter((line) => line.is_available);
      const omitted = lines.filter((line) => !line.is_available).map((line) => line.name);

      /* Nothing can be moved: keep the denied ticket exactly where the diner
         can still read WHY it was refused. Deleting it would erase the only
         explanation for a round that never happened. */
      if (available.length === 0) {
        return { order_id: orderId, moved: 0, omitted };
      }

      for (const line of available) {
        await tx.addCartLine(order.table_id, toCartLine(line));
      }
      await tx.deleteOrder(orderId);

      return { order_id: orderId, moved: available.length, omitted };
    });
  }

  /* POST /api/v1/orders/:order_id/retry — "Retry" as ONE transaction. The
     move, the delete and the re-fire share it, so a failed re-fire rolls
     everything back: the refused ticket (and its explanation) is still on
     screen and the cart is exactly as it was. */
  async retryDeniedOrder(
    orderId: string,
    tableToken: string,
  ): Promise<RetriedDeniedOrder> {
    return this.repository.transaction(async (tx) => {
      const order = await this.lockDeniedOrder(tx.lockOrderForTable(orderId, tableToken), orderId, "retried");
      const lines = await tx.listLines(orderId);

      const available = lines.filter((line) => line.is_available);
      const omitted = lines.filter((line) => !line.is_available).map((line) => line.name);

      if (available.length === 0) {
        throw new AppError(
          409,
          "NOTHING_TO_RETRY",
          omitted.length
            ? `${omitted.join(", ")} ${omitted.length === 1 ? "is" : "are"} out of stock — nothing could be re-fired.`
            : "There was nothing left to re-fire from that order.",
          { omitted },
        );
      }

      for (const line of available) {
        await tx.addCartLine(order.table_id, toCartLine(line));
      }
      await tx.deleteOrder(orderId);

      const result = await tx.fire(tableToken);
      const fired = this.interpretFire(result, "re-fired");

      return {
        order_id: fired.order_id,
        table_id: fired.table_id,
        status: fired.status,
        created_at: iso(fired.created_at),
        moved: available.length,
        omitted,
      };
    });
  }

  /* POST /api/v1/orders/:order_id/dismiss — the diner's "Cancel". Only a
     denied round may be discarded; it never reached the kitchen, so deleting
     it cannot erase sales history. */
  async dismissDeniedOrder(
    orderId: string,
    tableToken: string,
  ): Promise<DismissedDeniedOrder> {
    const table = await this.tables.requireTable(tableToken);
    const row = await this.repository.findOrderForTable(orderId, table.id);
    if (!row) {
      throw new AppError(404, "ORDER_NOT_FOUND", "That order no longer exists.");
    }
    this.assertDenied(row.status, "discarded");

    await this.repository.dismiss(orderId);
    return { order_id: orderId, dismissed: true };
  }

  /* ---------------------------------------------------------- helpers */

  private async lockDeniedOrder(
    pending: Promise<{ id: string; table_id: string; status: string } | null>,
    orderId: string,
    action: string,
  ): Promise<{ id: string; table_id: string; status: string }> {
    const order = await pending;
    if (!order) {
      throw new AppError(404, "ORDER_NOT_FOUND", "That order no longer exists.");
    }
    this.assertDenied(order.status, action);
    return order;
  }

  private assertDenied(status: string, action: string): void {
    if (status !== "denied") {
      throw new AppError(
        409,
        "ORDER_NOT_DENIED",
        `Only a denied order can be ${action}.`,
        { current_status: status },
      );
    }
  }

  /** Maps the RPC's business outcomes onto the documented HTTP contract. */
  private interpretFire(
    result: FireResult | null,
    context: "created" | "re-fired" = "created",
  ): { order_id: string; table_id: string; status: string; created_at: string } {
    if (!result) throw internalError();

    switch (result.code) {
      case "TABLE_NOT_FOUND":
        throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");

      case "DUPLICATE_ORDER":
        throw new AppError(409, "DUPLICATE_ORDER", "Order already sent", {
          order_id: result.order_id,
          status: result.status,
        });

      case "EMPTY_CART":
        throw new AppError(409, "EMPTY_CART", "The table cart is empty — nothing to fire.");

      case "INVENTORY_FAILURE": {
        const sold = result.sold_out ?? [];
        if (context === "re-fired") {
          /* This transaction rolls back: nothing was purged, nothing was
             re-fired. Say exactly that instead of the fire endpoint's copy. */
          throw new AppError(
            409,
            "INVENTORY_FAILURE",
            `${sold.join(", ")} ${sold.length > 1 ? "have" : "has"} sold out — nothing was re-fired.`,
            { sold_out: sold },
          );
        }

        const names = sold.join(", ");
        const verb = sold.length > 1 ? "have" : "has";
        throw new AppError(409, "INVENTORY_FAILURE", `${names} ${verb} sold out. Cart updated.`, {
          sold_out: sold,
        });
      }

      case "OK":
        if (!result.order_id || !result.table_id || !result.status || !result.created_at) {
          throw internalError();
        }
        return {
          order_id: result.order_id,
          table_id: result.table_id,
          status: result.status,
          created_at: result.created_at,
        };

      default:
        throw internalError();
    }
  }

  /** Events are an observer of a committed change. A listener failure is
      reported to composition, never surfaced as a failed order. */
  private publish(work: () => void): void {
    try {
      work();
    } catch (err) {
      this.onPublishError?.(err);
    }
  }
}

function toCartLine(line: DeniedLineRow) {
  return {
    menuItemId: line.menu_item_id,
    quantity: line.quantity,
    requestNote: line.request_note,
    allergyNote: line.allergy_note,
    addedBy: line.added_by,
  };
}
