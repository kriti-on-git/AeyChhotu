/* Public surface of the Inventory module. Other modules import from here,
   never from a file inside it. */

export { InventoryService } from "./inventory.service.js";
export { InventoryRepository } from "./inventory.repository.js";
export {
  createInventoryModule,
  type InventoryModule,
  type InventoryModuleOptions,
} from "./inventory.module.js";
export {
  createInventoryRouter,
  type InventoryControllerDeps,
} from "./inventory.controller.js";
export { INVENTORY_TOKENS } from "./inventory.tokens.js";
export {
  adjustStockSchema,
  inventoryItemParamsSchema,
  inventoryMovementsQuerySchema,
  inventoryQuerySchema,
  restoreStockSchema,
  setStockSchema,
} from "./inventory.validation.js";
export type {
  AdjustStockInput,
  AvailabilityReason,
  AvailabilityRequest,
  AvailabilityResult,
  AvailabilityRow,
  InventoryItem,
  InventoryItemRow,
  InventoryMovement,
  InventoryMovementRow,
  InventoryRepositoryPort,
  InventorySchemaPresence,
  InventoryServicePort,
  RestoreStockInput,
  SetStockInput,
  StockList,
  StockListParams,
  StockReason,
  StockState,
  StockSummary,
} from "./inventory.types.js";
