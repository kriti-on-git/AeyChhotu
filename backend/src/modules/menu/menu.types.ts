/* Menu module — contracts.

   The boundary covers catalogue folders, dishes (description, price,
   availability) and menu retrieval. Controllers and the legacy service
   facades depend on these types only; the module imports no other business
   module, only the small ports declared here. */

export interface MenuImageDto {
  image_url: string;
  image_small_url: string;
  blur_data_url: string;
}

export type MenuImageSource = {
  menu_item_id: string;
  storage_driver: string;
  original_key: string;
  small_key: string;
  tiny_key: string;
  blur_data_url: string;
};

/** Turns stored image keys into public URLs. Implemented by the existing
    image service and injected, so this module never reads storage config. */
export interface MenuImagePort {
  toDto(row: MenuImageSource): MenuImageDto;
}

/** One dish exactly as the diner and admin contracts expose it. */
export type MenuItemDto = {
  menu_item_id: string;
  name: string;
  price: number;
  category: string;
  category_id: string | null;
  is_available: boolean;
  description: string;
  vegetarian: boolean;
  image_url: string | null;
  image_small_url: string | null;
  blur_data_url: string | null;
  ingredients: string[];
  spice_level: number;
  allergens: string[];
  diet_tags: string[];
  portion_description: string;
};

export type AdminMenuItem = MenuItemDto;

/** Narrow read used by the Cart module: enough to accept or refuse a line. */
export type CartMenuItem = {
  menu_item_id: string;
  name: string;
  is_available: boolean;
};

export type MenuListParams = {
  table_token: string;
  page: number;
  limit: number;
  category?: string;
  q?: string;
};

export type MenuItemRow = {
  id: string;
  name: string;
  price: number;
  category: string;
  category_id: string | null;
  description: string;
  vegetarian: boolean;
  is_available: boolean;
  ingredients: string[] | null;
  spice_level: number | null;
  allergens: string[] | null;
  diet_tags: string[] | null;
  portion_description: string | null;
  storage_driver: string | null;
  original_key: string | null;
  small_key: string | null;
  tiny_key: string | null;
  blur_data_url: string | null;
};

export type MenuItemWriteInput = {
  name: string;
  price: number;
  category_id?: string | null;
  category?: string;
  description: string;
  vegetarian: boolean;
  is_available: boolean;
  ingredients?: string[];
  spice_level?: number;
  allergens?: string[];
  diet_tags?: string[];
  portion_description?: string;
};

export type CreateMenuItemInput = MenuItemWriteInput;
export type UpdateMenuItemInput = Partial<MenuItemWriteInput>;

export type CategoryDto = {
  category_id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  item_count: number;
  thumbnail_menu_item_id: string | null;
  thumbnail: MenuImageDto | null;
};

export type PublicCategoryDto = {
  category_id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
};

export type CategoryRow = {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  item_count: number;
  thumbnail_menu_item_id: string | null;
  image_item_id: string | null;
  storage_driver: string | null;
  original_key: string | null;
  small_key: string | null;
  tiny_key: string | null;
  blur_data_url: string | null;
};

export type PublicCategoryRow = {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
};

export type CategoryRecord = {
  id: string;
  name: string;
  parent_id: string | null;
};

export type CategoryWriteInput = {
  name: string;
  parent_id?: string | null;
};

export type CategoryPatch = {
  name?: string;
  parent_id?: string | null;
  sort_order?: number;
  thumbnail_menu_item_id?: string | null;
};

/** Legacy label + folder id a dish write resolves to. */
export type CategoryAssignment = {
  category_id: string | null;
  category: string;
};

export type CategoryUsage = {
  children: number;
  items: number;
};

export type AvailabilityResult = {
  menu_item_id: string;
  is_available: boolean;
  denied_orders: number;
};

export type SchemaPresence = {
  readonly present: readonly string[];
  readonly missing: readonly string[];
};

/** Cross-module contract: turning a dish off refuses pending rounds that hold
    it. Implemented by the orders module at composition time. */
export interface MenuOrderPort {
  denyPendingOrdersForItem(menuItemId: string, itemName: string): Promise<number>;
}

/** Storage contract. One explicit query per method; no business decisions. */
export interface MenuRepositoryPort {
  countMenuItems(category: string | undefined, q: string | undefined): Promise<number>;
  listMenuItems(
    category: string | undefined,
    q: string | undefined,
    limit: number,
    offset: number,
  ): Promise<MenuItemRow[]>;

  listAdminItems(): Promise<MenuItemRow[]>;
  findAdminItem(menuItemId: string): Promise<MenuItemRow | null>;
  findCartItem(menuItemId: string): Promise<CartMenuItem | null>;
  insertItem(input: MenuItemWriteInput, folder: CategoryAssignment): Promise<string>;
  updateItem(
    menuItemId: string,
    input: UpdateMenuItemInput,
    folder: CategoryAssignment | null,
  ): Promise<boolean>;
  archiveItem(menuItemId: string): Promise<{ id: string; name: string } | null>;
  setAvailability(
    menuItemId: string,
    isAvailable: boolean,
  ): Promise<{ id: string; name: string; is_available: boolean } | null>;

  listCategories(): Promise<CategoryRow[]>;
  listPublicCategories(): Promise<PublicCategoryRow[]>;
  findCategory(categoryId: string): Promise<CategoryRecord | null>;
  insertCategory(name: string, parentId: string | null): Promise<string>;
  updateCategory(categoryId: string, patch: CategoryPatch): Promise<void>;
  syncItemLabels(categoryId: string, name: string): Promise<void>;
  categoryUsage(categoryId: string): Promise<CategoryUsage>;
  archiveCategory(categoryId: string): Promise<void>;
  categoryWouldCycle(categoryId: string, candidateParent: string): Promise<boolean>;
  thumbnailBelongsToCategory(menuItemId: string, categoryId: string): Promise<boolean>;
  resolveCategoryForWrite(input: {
    category_id?: string | null;
    category?: string;
  }): Promise<CategoryAssignment>;

  schemaObjects(): Promise<SchemaPresence>;
}

/** What controllers, the lifecycle and legacy service callers consume. */
export interface MenuServicePort {
  listMenu(params: MenuListParams): Promise<{ data: MenuItemDto[]; meta: import("../../lib/util.js").PageMeta }>;
  findCartItem(menuItemId: string): Promise<CartMenuItem | null>;
  listPublicCategories(): Promise<PublicCategoryDto[]>;
  setAvailability(menuItemId: string, isAvailable: boolean): Promise<AvailabilityResult>;

  listAdminItems(): Promise<AdminMenuItem[]>;
  createItem(input: MenuItemWriteInput): Promise<AdminMenuItem>;
  updateItem(menuItemId: string, input: UpdateMenuItemInput): Promise<AdminMenuItem>;
  archiveItem(menuItemId: string): Promise<{ menu_item_id: string }>;

  listCategories(): Promise<CategoryDto[]>;
  createCategory(input: CategoryWriteInput): Promise<CategoryDto>;
  updateCategory(categoryId: string, input: CategoryPatch): Promise<CategoryDto>;
  deleteCategory(categoryId: string): Promise<{ category_id: string }>;
  resolveCategoryForWrite(input: {
    category_id?: string | null;
    category?: string;
  }): Promise<CategoryAssignment>;
}
