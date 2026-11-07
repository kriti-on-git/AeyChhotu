/* Menu module — business rules.

   Owns catalogue folders, dish writes, pricing validation, availability and
   the diner menu read. Cross-module work is contracted: Table confirms the
   guest's table before a menu read, and Orders refuses pending rounds when a
   dish is taken off the menu. Neither is imported directly. */

import { AppError } from "../../errors/app-error.js";
import { buildMeta } from "../../lib/util.js";
import type { TableServicePort } from "../table/table.types.js";
import { isUniqueViolation } from "./menu.errors.js";
import type {
  AdminMenuItem,
  AvailabilityResult,
  CategoryAssignment,
  CategoryDto,
  CategoryPatch,
  CategoryRow,
  CategoryWriteInput,
  CartMenuItem,
  MenuImagePort,
  MenuItemDto,
  MenuItemRow,
  MenuItemWriteInput,
  MenuListParams,
  MenuOrderPort,
  MenuRepositoryPort,
  MenuServicePort,
  MenuServicePort as MenuServiceContract,
  PublicCategoryDto,
  UpdateMenuItemInput,
} from "./menu.types.js";

export interface MenuServiceDeps {
  readonly repository: MenuRepositoryPort;
  readonly tables: Pick<TableServicePort, "requireTable">;
  readonly orders: MenuOrderPort;
  readonly images: MenuImagePort;
}

function categoryDto(row: CategoryRow, images: MenuImagePort): CategoryDto {
  return {
    category_id: row.id,
    name: row.name,
    parent_id: row.parent_id,
    sort_order: row.sort_order,
    item_count: row.item_count,
    thumbnail_menu_item_id: row.thumbnail_menu_item_id,
    thumbnail:
      row.image_item_id &&
      row.storage_driver &&
      row.original_key &&
      row.small_key &&
      row.tiny_key
        ? images.toDto({
            menu_item_id: row.image_item_id,
            storage_driver: row.storage_driver,
            original_key: row.original_key,
            small_key: row.small_key,
            tiny_key: row.tiny_key,
            blur_data_url: row.blur_data_url ?? "",
          })
        : null,
  };
}

function itemDto(row: MenuItemRow, images: MenuImagePort): MenuItemDto {
  const image =
    row.storage_driver && row.original_key && row.small_key && row.tiny_key
      ? images.toDto({
          menu_item_id: row.id,
          storage_driver: row.storage_driver,
          original_key: row.original_key,
          small_key: row.small_key,
          tiny_key: row.tiny_key,
          blur_data_url: row.blur_data_url ?? "",
        })
      : null;

  return {
    menu_item_id: row.id,
    name: row.name,
    price: Number(row.price),
    category: row.category,
    category_id: row.category_id ?? null,
    is_available: row.is_available,
    description: row.description,
    vegetarian: row.vegetarian,
    ingredients: row.ingredients ?? [],
    spice_level: row.spice_level ?? 0,
    allergens: row.allergens ?? [],
    diet_tags: row.diet_tags ?? [],
    portion_description: row.portion_description ?? "",
    image_url: image?.image_url ?? null,
    image_small_url: image?.image_small_url ?? null,
    blur_data_url: image?.blur_data_url ?? null,
  };
}

function duplicateCategory(): never {
  throw new AppError(
    409,
    "CATEGORY_EXISTS",
    "A folder with that name already exists in this folder.",
  );
}

function assertPrice(price: number): void {
  if (!Number.isFinite(price) || price < 0 || price > 1_000_000) {
    throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
      fields: { price: "Price must be a finite amount between 0 and 1,000,000." },
    });
  }
}

export class MenuService implements MenuServiceContract {
  private readonly repository: MenuRepositoryPort;
  private readonly tables: Pick<TableServicePort, "requireTable">;
  private readonly orders: MenuOrderPort;
  private readonly images: MenuImagePort;

  constructor(deps: MenuServiceDeps) {
    this.repository = deps.repository;
    this.tables = deps.tables;
    this.orders = deps.orders;
    this.images = deps.images;
  }

  /* ------------------------------------------------------------ retrieval */

  async listMenu(
    params: MenuListParams,
  ): Promise<{ data: MenuItemDto[]; meta: ReturnType<typeof buildMeta> }> {
    await this.tables.requireTable(params.table_token);

    const total = await this.repository.countMenuItems(params.category, params.q);
    const rows = await this.repository.listMenuItems(
      params.category,
      params.q,
      params.limit,
      (params.page - 1) * params.limit,
    );

    return {
      data: rows.map((row) => itemDto(row, this.images)),
      meta: buildMeta(params.page, params.limit, total),
    };
  }

  async listPublicCategories(): Promise<PublicCategoryDto[]> {
    const rows = await this.repository.listPublicCategories();
    return rows.map((row) => ({
      category_id: row.id,
      name: row.name,
      parent_id: row.parent_id,
      sort_order: row.sort_order,
    }));
  }

  /** Public cross-module read for Cart: no folders, images or pricing. */
  findCartItem(menuItemId: string): Promise<CartMenuItem | null> {
    return this.repository.findCartItem(menuItemId);
  }

  /* ---------------------------------------------------------- availability */

  async setAvailability(menuItemId: string, isAvailable: boolean): Promise<AvailabilityResult> {
    const row = await this.repository.setAvailability(menuItemId, isAvailable);
    if (!row) {
      throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
    }

    /* Re-stocking never touches open rounds; taking a dish off refuses every
       PENDING round that holds it, with the dish's name in the reason. */
    const deniedOrders = row.is_available
      ? 0
      : await this.orders.denyPendingOrdersForItem(row.id, row.name);

    return {
      menu_item_id: row.id,
      is_available: row.is_available,
      denied_orders: deniedOrders,
    };
  }

  /* --------------------------------------------------------------- writes */

  async listAdminItems(): Promise<AdminMenuItem[]> {
    const rows = await this.repository.listAdminItems();
    return rows.map((row) => itemDto(row, this.images));
  }

  async createItem(input: MenuItemWriteInput): Promise<AdminMenuItem> {
    assertPrice(input.price);

    const folder = await this.resolveCategoryForWrite({
      category_id: input.category_id ?? undefined,
      category: input.category,
    });

    const id = await this.repository.insertItem(input, folder);
    if (!id) {
      throw new AppError(500, "INTERNAL_ERROR", "The dish could not be created.");
    }
    return this.readAdminItem(id, "The dish could not be read back.");
  }

  async updateItem(menuItemId: string, input: UpdateMenuItemInput): Promise<AdminMenuItem> {
    if (input.price !== undefined) assertPrice(input.price);

    const folder =
      input.category_id !== undefined || input.category !== undefined
        ? await this.resolveCategoryForWrite({
            category_id: input.category_id ?? undefined,
            category: input.category,
          })
        : null;

    const updated = await this.repository.updateItem(menuItemId, input, folder);
    if (!updated) {
      throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
    }

    const item = await this.readAdminItem(menuItemId, "Unknown menu item.");

    /* Keep the console's 86 switch identical to E14. */
    if (input.is_available === false) {
      await this.orders.denyPendingOrdersForItem(item.menu_item_id, item.name);
    }

    return item;
  }

  async archiveItem(menuItemId: string): Promise<{ menu_item_id: string }> {
    const row = await this.repository.archiveItem(menuItemId);
    if (!row) {
      throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
    }

    await this.orders.denyPendingOrdersForItem(row.id, row.name);
    return { menu_item_id: row.id };
  }

  private async readAdminItem(menuItemId: string, notFoundMessage: string): Promise<AdminMenuItem> {
    const row = await this.repository.findAdminItem(menuItemId);
    if (!row) {
      throw new AppError(404, "MENU_ITEM_NOT_FOUND", notFoundMessage);
    }
    return itemDto(row, this.images);
  }

  /* -------------------------------------------------------------- folders */

  async listCategories(): Promise<CategoryDto[]> {
    const rows = await this.repository.listCategories();
    return rows.map((row) => categoryDto(row, this.images));
  }

  async createCategory(input: CategoryWriteInput): Promise<CategoryDto> {
    const name = input.name.trim();
    if (!name) {
      throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
        fields: { name: "Give the folder a name." },
      });
    }

    if (input.parent_id) {
      await this.loadCategory(input.parent_id);
    }

    let id: string;
    try {
      id = await this.repository.insertCategory(name, input.parent_id ?? null);
    } catch (err) {
      if (isUniqueViolation(err)) duplicateCategory();
      throw err;
    }

    return this.readCategory(id, "The folder could not be read back.");
  }

  async updateCategory(categoryId: string, input: CategoryPatch): Promise<CategoryDto> {
    const current = await this.loadCategory(categoryId);

    if (input.parent_id !== undefined && input.parent_id !== null) {
      if (input.parent_id === categoryId) {
        throw new AppError(400, "CATEGORY_CYCLE", "A folder cannot be its own parent.");
      }
      await this.loadCategory(input.parent_id);
      if (await this.repository.categoryWouldCycle(categoryId, input.parent_id)) {
        throw new AppError(400, "CATEGORY_CYCLE", "That move would put a folder inside itself.");
      }
    }

    if (input.thumbnail_menu_item_id) {
      const belongs = await this.repository.thumbnailBelongsToCategory(
        input.thumbnail_menu_item_id,
        categoryId,
      );
      if (!belongs) {
        throw new AppError(
          400,
          "CATEGORY_THUMBNAIL_INVALID",
          "Pick a dish that lives in this folder or one of its subfolders.",
        );
      }
    }

    const name = input.name !== undefined ? input.name.trim() : undefined;
    if (name === "") {
      throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
        fields: { name: "The folder name cannot be empty." },
      });
    }

    try {
      await this.repository.updateCategory(categoryId, {
        ...input,
        ...(name !== undefined ? { name } : {}),
      });
    } catch (err) {
      if (isUniqueViolation(err)) duplicateCategory();
      throw err;
    }

    if (name !== undefined && name !== current.name) {
      await this.repository.syncItemLabels(categoryId, name);
    }

    return this.readCategory(categoryId, "Unknown folder.");
  }

  async deleteCategory(categoryId: string): Promise<{ category_id: string }> {
    await this.loadCategory(categoryId);

    const usage = await this.repository.categoryUsage(categoryId);
    if (usage.children > 0 || usage.items > 0) {
      throw new AppError(
        409,
        "CATEGORY_NOT_EMPTY",
        "This folder still holds dishes or subfolders. Move or archive them first.",
      );
    }

    await this.repository.archiveCategory(categoryId);
    return { category_id: categoryId };
  }

  async resolveCategoryForWrite(input: {
    category_id?: string | null;
    category?: string;
  }): Promise<CategoryAssignment> {
    /* Validate the folder id at the service boundary so an unknown id is the
       documented 404, not a storage-shaped error. */
    if (input.category_id) {
      const folder = await this.repository.findCategory(input.category_id);
      if (!folder) {
        throw new AppError(404, "CATEGORY_NOT_FOUND", "Unknown folder.");
      }
    }
    return this.repository.resolveCategoryForWrite(input);
  }

  private async loadCategory(categoryId: string) {
    const row = await this.repository.findCategory(categoryId);
    if (!row) {
      throw new AppError(404, "CATEGORY_NOT_FOUND", "Unknown folder.");
    }
    return row;
  }

  private async readCategory(categoryId: string, message: string): Promise<CategoryDto> {
    const rows = await this.repository.listCategories();
    const found = rows.find((row) => row.id === categoryId);
    if (!found) {
      throw new AppError(404, "CATEGORY_NOT_FOUND", message);
    }
    return categoryDto(found, this.images);
  }
}

export type { MenuServiceContract };
