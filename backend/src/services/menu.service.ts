/* Transitional facade over the Menu module.

   The module owns the catalogue. This file keeps the historical function
   names working for routes/admin.ts and the still-unmigrated admin service,
   and is the single place where the module's ports are bound to the legacy
   pool, the Table service and order denial. It holds no SQL and no rules. */

import { createLegacyDbPort } from "../db/legacy-db-port.js";
import { MenuRepository } from "../modules/menu/menu.repository.js";
import { MenuService } from "../modules/menu/menu.service.js";
import type {
  MenuItemDto,
  MenuListParams,
  MenuServicePort,
} from "../modules/menu/menu.types.js";
import { getDefaultTableService } from "../modules/table/index.js";
import { imageDtoFromRow } from "./menu-image.service.js";
import { denyPendingOrdersForItem } from "./orders.service.js";

export type {
  AdminMenuItem,
  AvailabilityResult,
  CategoryAssignment,
  CategoryDto,
  CategoryPatch,
  CategoryWriteInput,
  CreateMenuItemInput,
  MenuItemDto,
  MenuItemWriteInput,
  MenuListParams,
  MenuServicePort,
  PublicCategoryDto,
  UpdateMenuItemInput,
} from "../modules/menu/index.js";

let defaultService: MenuServicePort | null = null;

/** The single service used by services/catalog.service.ts,
    services/admin.service.ts and the default createApp() path. Production
    replaces it during composition with the module instance. */
export function getDefaultMenuService(): MenuServicePort {
  if (defaultService === null) {
    defaultService = new MenuService({
      repository: new MenuRepository(createLegacyDbPort()),
      tables: getDefaultTableService(),
      orders: { denyPendingOrdersForItem },
      images: { toDto: imageDtoFromRow },
    });
  }
  return defaultService;
}

/** Called once by the composition root before any request is served. */
export function configureMenuService(service: MenuServicePort): void {
  defaultService = service;
}

export function listMenu(
  params: MenuListParams,
): Promise<{ data: MenuItemDto[]; meta: import("../lib/util.js").PageMeta }> {
  return getDefaultMenuService().listMenu(params);
}

export function setAvailability(menuItemId: string, isAvailable: boolean) {
  return getDefaultMenuService().setAvailability(menuItemId, isAvailable);
}
