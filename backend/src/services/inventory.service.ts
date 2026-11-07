/* Compatibility seam for the Inventory module.

   Production supplies the service from the composition root. The default is
   built over the legacy pool so `createApp()` keeps working in scripts and
   tests that do not compose the whole application. */

import { createLegacyDbPort } from "../db/legacy-db-port.js";
import { InventoryRepository } from "../modules/inventory/inventory.repository.js";
import { InventoryService } from "../modules/inventory/inventory.service.js";
import type { InventoryServicePort } from "../modules/inventory/inventory.types.js";

let defaultService: InventoryServicePort | null = null;

export function getDefaultInventoryService(): InventoryServicePort {
  if (defaultService === null) {
    defaultService = new InventoryService({
      repository: new InventoryRepository(createLegacyDbPort()),
    });
  }
  return defaultService;
}

/** Called once by the composition root before any request is served. */
export function configureInventoryService(service: InventoryServicePort): void {
  defaultService = service;
}
