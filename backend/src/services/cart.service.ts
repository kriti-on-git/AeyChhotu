/* Compatibility seam for createApp() with no injection.

   Production always supplies the Cart module service from the composition
   root. This default keeps scripts and ad-hoc boots working on the legacy
   pool, with realtime deliberately disabled (the Socket.IO server is not
   running in that mode). */

import { createLegacyDbPort } from "../db/legacy-db-port.js";
import { NOOP_CART_REALTIME } from "../modules/cart/cart.events.js";
import { CartRepository } from "../modules/cart/cart.repository.js";
import { CartService } from "../modules/cart/cart.service.js";
import type { CartServicePort } from "../modules/cart/cart.types.js";
import { getDefaultTableService } from "../modules/table/index.js";
import { getDefaultMenuService } from "./menu.service.js";

let defaultService: CartServicePort | null = null;

export function getDefaultCartService(): CartServicePort {
  if (defaultService === null) {
    defaultService = new CartService({
      repository: new CartRepository(createLegacyDbPort()),
      tables: getDefaultTableService(),
      menu: getDefaultMenuService(),
      realtime: NOOP_CART_REALTIME,
    });
  }
  return defaultService;
}

/** Called once by the composition root before any request is served. */
export function configureCartService(service: CartServicePort): void {
  defaultService = service;
}
