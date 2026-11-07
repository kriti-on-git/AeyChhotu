/* Compatibility seam for createApp() with no injection.

   Production always supplies the Orders module service from the composition
   root. This default keeps scripts and ad-hoc boots working on the legacy
   pool, with the internal event bus deliberately absent (no consumer exists
   in that mode). */

import { createLegacyDbPort } from "../db/legacy-db-port.js";
import { NOOP_ORDER_EVENTS } from "../modules/orders/orders.events.js";
import { OrdersRepository } from "../modules/orders/orders.repository.js";
import { OrdersService } from "../modules/orders/orders.service.js";
import type { OrdersServicePort } from "../modules/orders/orders.types.js";
import { getDefaultTableService } from "../modules/table/index.js";

let defaultService: OrdersServicePort | null = null;

export function getDefaultOrdersService(): OrdersServicePort {
  if (defaultService === null) {
    defaultService = new OrdersService({
      repository: new OrdersRepository(createLegacyDbPort()),
      tables: getDefaultTableService(),
      events: NOOP_ORDER_EVENTS,
    });
  }
  return defaultService;
}

/** Called once by the composition root before any request is served. */
export function configureOrdersService(service: OrdersServicePort): void {
  defaultService = service;
}

/* Kept for the Menu compatibility facade, which imports this historical
   function name directly. */
export function denyPendingOrdersForItem(
  menuItemId: string,
  itemName: string,
): Promise<number> {
  return getDefaultOrdersService().denyPendingOrdersForItem(menuItemId, itemName);
}

export { denialReasonForSoldOutItem } from "../modules/orders/orders.service.js";
