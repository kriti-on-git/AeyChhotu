/* Public surface of the Menu module. Other modules import from here, never
   from a file inside it. */

export { MenuService } from "./menu.service.js";
export { MenuRepository } from "./menu.repository.js";
export {
  createMenuRouter,
  type MenuControllerDeps,
  type MenuImageSize,
} from "./menu.controller.js";
export {
  createMenuModule,
  type MenuModule,
  type MenuModuleOptions,
} from "./menu.module.js";
export { MENU_TOKENS } from "./menu.tokens.js";
export {
  adminCategoryParamsSchema,
  adminCreateCategorySchema,
  adminCreateMenuItemSchema,
  adminMenuItemParamsSchema,
  adminUpdateCategorySchema,
  adminUpdateMenuItemSchema,
  availabilitySchema,
  menuImageParamsSchema,
  menuItemParamsSchema,
  menuQuerySchema,
} from "./menu.validation.js";
export type {
  AdminMenuItem,
  AvailabilityResult,
  CategoryAssignment,
  CategoryDto,
  CategoryPatch,
  CategoryRecord,
  CategoryRow,
  CategoryUsage,
  CategoryWriteInput,
  CartMenuItem,
  CreateMenuItemInput,
  MenuImageDto,
  MenuImagePort,
  MenuImageSource,
  MenuItemDto,
  MenuItemRow,
  MenuItemWriteInput,
  MenuListParams,
  MenuOrderPort,
  MenuRepositoryPort,
  MenuServicePort,
  PublicCategoryDto,
  SchemaPresence,
  UpdateMenuItemInput,
} from "./menu.types.js";
