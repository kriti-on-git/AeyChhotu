import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Menu module unit tests.

   The repository is in-memory: these tests pin retrieval, pricing, folder
   rules, availability and the order-denial contract without Postgres. The
   HTTP surface has its own suite, and the SQL is exercised by the repository
   integration suite. */

import { AppError } from "../src/errors/app-error.js";
import { MenuService } from "../src/modules/menu/menu.service.js";
import type {
  CategoryAssignment,
  CategoryPatch,
  CategoryRow,
  CategoryUsage,
  CategoryWriteInput,
  MenuImagePort,
  MenuItemRow,
  MenuItemWriteInput,
  MenuRepositoryPort,
  PublicCategoryRow,
  SchemaPresence,
  UpdateMenuItemInput,
} from "../src/modules/menu/menu.types.js";

function item(overrides: Partial<MenuItemRow> = {}): MenuItemRow {
  return {
    id: "item-1",
    name: "Paneer Tikka",
    price: 260,
    category: "Starters",
    category_id: "cat-1",
    description: "Charred paneer.",
    vegetarian: true,
    is_available: true,
    ingredients: ["paneer"],
    spice_level: 1,
    allergens: ["dairy"],
    diet_tags: [],
    portion_description: "6 pieces",
    storage_driver: null,
    original_key: null,
    small_key: null,
    tiny_key: null,
    blur_data_url: null,
    ...overrides,
  };
}

function category(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: "cat-1",
    name: "Starters",
    parent_id: null,
    sort_order: 0,
    item_count: 1,
    thumbnail_menu_item_id: null,
    image_item_id: null,
    storage_driver: null,
    original_key: null,
    small_key: null,
    tiny_key: null,
    blur_data_url: null,
    ...overrides,
  };
}

class FakeMenuRepository implements MenuRepositoryPort {
  items: MenuItemRow[] = [item()];
  categories: CategoryRow[] = [category()];
  deleted = new Set<string>();
  archivedCategories = new Set<string>();
  private sequence = 1;

  async countMenuItems(categoryName: string | undefined, q: string | undefined): Promise<number> {
    return this.filtered(categoryName, q).length;
  }

  async listMenuItems(
    categoryName: string | undefined,
    q: string | undefined,
    limit: number,
    offset: number,
  ): Promise<MenuItemRow[]> {
    return this.filtered(categoryName, q).slice(offset, offset + limit);
  }

  private filtered(categoryName: string | undefined, q: string | undefined): MenuItemRow[] {
    return this.items.filter(
      (entry) =>
        !this.deleted.has(entry.id) &&
        (!categoryName || entry.category === categoryName) &&
        (!q || entry.name.toLowerCase().includes(q.toLowerCase())),
    );
  }

  async listAdminItems(): Promise<MenuItemRow[]> {
    return this.items.filter((entry) => !this.deleted.has(entry.id));
  }

  async findAdminItem(menuItemId: string): Promise<MenuItemRow | null> {
    if (this.deleted.has(menuItemId)) return null;
    return this.items.find((entry) => entry.id === menuItemId) ?? null;
  }

  async findCartItem(menuItemId: string) {
    const row = this.items.find((entry) => entry.id === menuItemId);
    if (!row || this.deleted.has(menuItemId)) return null;
    return { menu_item_id: row.id, name: row.name, is_available: row.is_available };
  }

  async insertItem(input: MenuItemWriteInput, folder: CategoryAssignment): Promise<string> {
    const id = `item-${++this.sequence + 1}`;
    this.items.push(
      item({
        id,
        name: input.name.trim(),
        price: input.price,
        category: folder.category,
        category_id: folder.category_id,
        description: input.description.trim(),
        vegetarian: input.vegetarian,
        is_available: input.is_available,
        ingredients: input.ingredients ?? [],
        spice_level: input.spice_level ?? 0,
        allergens: input.allergens ?? [],
        diet_tags: input.diet_tags ?? [],
        portion_description: input.portion_description ?? "",
      }),
    );
    return id;
  }

  async updateItem(
    menuItemId: string,
    input: UpdateMenuItemInput,
    folder: CategoryAssignment | null,
  ): Promise<boolean> {
    const row = this.items.find((entry) => entry.id === menuItemId);
    if (!row || this.deleted.has(menuItemId)) return false;

    if (input.name !== undefined) row.name = input.name;
    if (input.price !== undefined) row.price = input.price;
    if (input.description !== undefined) row.description = input.description;
    if (input.vegetarian !== undefined) row.vegetarian = input.vegetarian;
    if (input.is_available !== undefined) row.is_available = input.is_available;
    if (input.ingredients !== undefined) row.ingredients = input.ingredients;
    if (input.spice_level !== undefined) row.spice_level = input.spice_level;
    if (input.allergens !== undefined) row.allergens = input.allergens;
    if (input.diet_tags !== undefined) row.diet_tags = input.diet_tags;
    if (input.portion_description !== undefined) row.portion_description = input.portion_description;
    if (folder) {
      row.category = folder.category;
      row.category_id = folder.category_id;
    }
    return true;
  }

  async archiveItem(menuItemId: string): Promise<{ id: string; name: string } | null> {
    const row = this.items.find((entry) => entry.id === menuItemId);
    if (!row || this.deleted.has(menuItemId)) return null;
    this.deleted.add(menuItemId);
    row.is_available = false;
    return { id: row.id, name: row.name };
  }

  async setAvailability(
    menuItemId: string,
    isAvailable: boolean,
  ): Promise<{ id: string; name: string; is_available: boolean } | null> {
    const row = this.items.find((entry) => entry.id === menuItemId);
    if (!row || this.deleted.has(menuItemId)) return null;
    row.is_available = isAvailable;
    return { id: row.id, name: row.name, is_available: row.is_available };
  }

  async listCategories(): Promise<CategoryRow[]> {
    return this.categories
      .filter((entry) => !this.archivedCategories.has(entry.id))
      .map((entry) => ({
        ...entry,
        item_count: this.items.filter(
          (dish) => !this.deleted.has(dish.id) && dish.category_id === entry.id,
        ).length,
      }));
  }

  async listPublicCategories(): Promise<PublicCategoryRow[]> {
    return (await this.listCategories()).map((entry) => ({
      id: entry.id,
      name: entry.name,
      parent_id: entry.parent_id,
      sort_order: entry.sort_order,
    }));
  }

  async findCategory(categoryId: string) {
    if (this.archivedCategories.has(categoryId)) return null;
    const row = this.categories.find((entry) => entry.id === categoryId);
    return row ? { id: row.id, name: row.name, parent_id: row.parent_id } : null;
  }

  async insertCategory(name: string, parentId: string | null): Promise<string> {
    const duplicate = this.categories.some(
      (entry) =>
        !this.archivedCategories.has(entry.id) &&
        entry.parent_id === parentId &&
        entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) throw Object.assign(new Error("duplicate"), { code: "23505" });

    const id = `cat-${++this.sequence + 10}`;
    this.categories.push(category({ id, name, parent_id: parentId, item_count: 0 }));
    return id;
  }

  async updateCategory(categoryId: string, patch: CategoryPatch): Promise<void> {
    const row = this.categories.find((entry) => entry.id === categoryId);
    if (!row) return;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.parent_id !== undefined) row.parent_id = patch.parent_id;
    if (patch.sort_order !== undefined) row.sort_order = patch.sort_order;
    if (patch.thumbnail_menu_item_id !== undefined) {
      row.thumbnail_menu_item_id = patch.thumbnail_menu_item_id;
    }
  }

  async syncItemLabels(categoryId: string, name: string): Promise<void> {
    for (const dish of this.items) if (dish.category_id === categoryId) dish.category = name;
  }

  async categoryUsage(categoryId: string): Promise<CategoryUsage> {
    return {
      children: this.categories.filter((entry) => entry.parent_id === categoryId).length,
      items: this.items.filter(
        (dish) => !this.deleted.has(dish.id) && dish.category_id === categoryId,
      ).length,
    };
  }

  async archiveCategory(categoryId: string): Promise<void> {
    this.archivedCategories.add(categoryId);
  }

  async categoryWouldCycle(categoryId: string, candidateParent: string): Promise<boolean> {
    let current: string | null = candidateParent;
    while (current) {
      if (current === categoryId) return true;
      current = this.categories.find((entry) => entry.id === current)?.parent_id ?? null;
    }
    return false;
  }

  async thumbnailBelongsToCategory(menuItemId: string, categoryId: string): Promise<boolean> {
    const dish = this.items.find((entry) => entry.id === menuItemId);
    if (!dish || !dish.category_id) return false;
    let current: string | null = dish.category_id;
    while (current) {
      if (current === categoryId) return true;
      current = this.categories.find((entry) => entry.id === current)?.parent_id ?? null;
    }
    return false;
  }

  async resolveCategoryForWrite(input: {
    category_id?: string | null;
    category?: string;
  }): Promise<CategoryAssignment> {
    if (input.category_id) {
      const found = this.categories.find(
        (entry) => entry.id === input.category_id && !this.archivedCategories.has(entry.id),
      );
      if (!found) throw new AppError(404, "CATEGORY_NOT_FOUND", "Unknown folder.");
      return { category_id: found.id, category: found.name };
    }

    const label = (input.category ?? "").trim();
    if (!label) return { category_id: null, category: "Main Course" };

    const existing = this.categories.find(
      (entry) =>
        entry.parent_id === null &&
        !this.archivedCategories.has(entry.id) &&
        entry.name.toLowerCase() === label.toLowerCase(),
    );
    if (existing) return { category_id: existing.id, category: existing.name };

    const id = await this.insertCategory(label, null);
    return { category_id: id, category: label };
  }

  async schemaObjects(): Promise<SchemaPresence> {
    return {
      present: ["menu_items", "menu_categories", "menu_item_images"],
      missing: [],
    };
  }
}

interface OperatorCalls {
  readonly tokens: string[];
  readonly denied: Array<{ id: string; name: string }>;
}

function harness() {
  const repository = new FakeMenuRepository();
  const operator: OperatorCalls = { tokens: [], denied: [] };
  const images: MenuImagePort = {
    toDto: (row) => ({
      image_url: `/api/v1/menu/items/${row.menu_item_id}/image/original`,
      image_small_url: `/api/v1/menu/items/${row.menu_item_id}/image/small`,
      blur_data_url: row.blur_data_url,
    }),
  };

  const service = new MenuService({
    repository,
    tables: {
      requireTable: async (token) => {
        operator.tokens.push(token);
        if (token === "unknown") {
          throw new AppError(404, "TABLE_NOT_FOUND", "Unknown table.");
        }
        return { id: "table-1", code: token, name: "Window", status: "active" };
      },
    },
    orders: {
      denyPendingOrdersForItem: async (id, name) => {
        operator.denied.push({ id, name });
        return 2;
      },
    },
    images,
  });

  return { service, repository, operator };
}

function isAppError(code: string) {
  return (err: unknown) => err instanceof AppError && err.code === code;
}

describe("MenuService — retrieval (E3)", () => {
  it("checks table scope and returns paginated dishes with numeric prices", async () => {
    const { service, operator } = harness();

    const page = await service.listMenu({
      table_token: "k7x2p",
      page: 1,
      limit: 20,
    });

    assert.deepEqual(operator.tokens, ["k7x2p"]);
    assert.equal(page.data.length, 1);
    assert.equal(page.data[0]?.price, 260);
    assert.equal(typeof page.data[0]?.price, "number");
    assert.deepEqual(page.meta, { page: 1, limit: 20, total: 1, total_pages: 1 });
  });

  it("keeps 86'd dishes in the catalogue and forwards filters", async () => {
    const { service, repository } = harness();
    repository.items = [
      item({ id: "a", name: "Paneer Tikka" }),
      item({ id: "b", name: "Chicken Tikka", is_available: false }),
      item({ id: "c", name: "Dal Makhani", category: "Mains" }),
    ];

    const result = await service.listMenu({
      table_token: "k7x2p",
      page: 1,
      limit: 20,
      category: "Starters",
      q: "tikka",
    });

    assert.deepEqual(
      result.data.map((dish) => dish.name),
      ["Paneer Tikka", "Chicken Tikka"],
    );
    assert.equal(result.data[1]?.is_available, false);
    assert.equal(result.meta.total, 2);
  });

  it("propagates an unknown table instead of leaking a menu", async () => {
    const { service } = harness();
    await assert.rejects(
      () => service.listMenu({ table_token: "unknown", page: 1, limit: 20 }),
      isAppError("TABLE_NOT_FOUND"),
    );
  });

  it("lists the diner-facing folder tree without photos", async () => {
    const { service, repository } = harness();
    repository.categories.push(category({ id: "cat-2", name: "Mains", sort_order: 1 }));

    const categories = await service.listPublicCategories();
    assert.deepEqual(
      categories.map((entry) => entry.name),
      ["Starters", "Mains"],
    );
    assert.equal("thumbnail" in categories[0]!, false);
  });
});

describe("MenuService — writes and pricing", () => {
  it("creates a dish with description, price and resolved folder", async () => {
    const { service } = harness();

    const created = await service.createItem({
      name: "  Gobi Manchurian ",
      price: 199.5,
      category: "Starters",
      description: "  Crisp cauliflower. ",
      vegetarian: true,
      is_available: true,
      ingredients: ["cauliflower"],
      spice_level: 2,
    });

    assert.equal(created.name, "Gobi Manchurian");
    assert.equal(created.price, 199.5);
    assert.equal(created.description, "Crisp cauliflower.");
    assert.equal(created.category, "Starters");
    assert.equal(created.spice_level, 2);
  });

  it("refuses negative, non-finite and absurd prices before writing", async () => {
    const { service, repository } = harness();
    const before = repository.items.length;

    for (const price of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001]) {
      await assert.rejects(
        () =>
          service.createItem({
            name: "Bad price",
            price,
            description: "",
            vegetarian: true,
            is_available: true,
          }),
        isAppError("VALIDATION_ERROR"),
      );
    }

    assert.equal(repository.items.length, before);
  });

  it("patches only the supplied fields and keeps the rest", async () => {
    const { service } = harness();

    const updated = await service.updateItem("item-1", {
      price: 249.5,
      description: "New description",
    });

    assert.equal(updated.price, 249.5);
    assert.equal(updated.description, "New description");
    assert.equal(updated.name, "Paneer Tikka");
    assert.equal(updated.vegetarian, true);
  });

  it("404s an unknown dish", async () => {
    const { service } = harness();
    await assert.rejects(
      () => service.updateItem("missing", { price: 10 }),
      isAppError("MENU_ITEM_NOT_FOUND"),
    );
    await assert.rejects(() => service.archiveItem("missing"), isAppError("MENU_ITEM_NOT_FOUND"));
  });
});

describe("MenuService — availability (E14)", () => {
  it("86ing denies pending rounds with the dish name", async () => {
    const { service, operator } = harness();

    const result = await service.setAvailability("item-1", false);

    assert.deepEqual(result, {
      menu_item_id: "item-1",
      is_available: false,
      denied_orders: 2,
    });
    assert.deepEqual(operator.denied, [{ id: "item-1", name: "Paneer Tikka" }]);
  });

  it("re-stocking never touches open rounds", async () => {
    const { service, operator } = harness();

    const result = await service.setAvailability("item-1", true);

    assert.equal(result.is_available, true);
    assert.equal(result.denied_orders, 0);
    assert.deepEqual(operator.denied, []);
  });

  it("the admin patch's 86 switch behaves exactly like E14", async () => {
    const { service, operator } = harness();

    const updated = await service.updateItem("item-1", { is_available: false });

    assert.equal(updated.is_available, false);
    assert.deepEqual(operator.denied, [{ id: "item-1", name: "Paneer Tikka" }]);
  });

  it("archiving a dish also denies its pending rounds", async () => {
    const { service, operator, repository } = harness();

    const archived = await service.archiveItem("item-1");

    assert.deepEqual(archived, { menu_item_id: "item-1" });
    assert.deepEqual(operator.denied, [{ id: "item-1", name: "Paneer Tikka" }]);
    assert.equal(repository.deleted.has("item-1"), true);
  });
});

describe("MenuService — catalog folders", () => {
  it("creates nested folders and keeps sibling names unique", async () => {
    const { service } = harness();

    const child = await service.createCategory({
      name: "Tandoor",
      parent_id: "cat-1",
    });
    assert.equal(child.parent_id, "cat-1");

    await assert.rejects(
      () => service.createCategory({ name: "tandoor", parent_id: "cat-1" }),
      isAppError("CATEGORY_EXISTS"),
    );
  });

  it("renames a folder and keeps the legacy dish label in step", async () => {
    const { service, repository } = harness();

    const renamed = await service.updateCategory("cat-1", { name: "Small Plates" });

    assert.equal(renamed.name, "Small Plates");
    assert.equal(repository.items[0]?.category, "Small Plates");
  });

  it("refuses a folder move that would create a cycle", async () => {
    const { service, repository } = harness();
    repository.categories.push(category({ id: "cat-2", name: "Child", parent_id: "cat-1" }));

    await assert.rejects(
      () => service.updateCategory("cat-1", { parent_id: "cat-2" }),
      isAppError("CATEGORY_CYCLE"),
    );
    await assert.rejects(
      () => service.updateCategory("cat-1", { parent_id: "cat-1" }),
      isAppError("CATEGORY_CYCLE"),
    );
  });

  it("only accepts a cover dish from the folder or its subtree", async () => {
    const { service, repository } = harness();
    repository.categories.push(category({ id: "cat-2", name: "Other" }));
    repository.items.push(item({ id: "item-2", category_id: "cat-2", category: "Other" }));

    await assert.rejects(
      () => service.updateCategory("cat-1", { thumbnail_menu_item_id: "item-2" }),
      isAppError("CATEGORY_THUMBNAIL_INVALID"),
    );
  });

  it("archives only an empty folder", async () => {
    const { service, repository } = harness();

    await assert.rejects(
      () => service.deleteCategory("cat-1"),
      isAppError("CATEGORY_NOT_EMPTY"),
    );

    const empty = await service.createCategory({ name: "Empty" });
    assert.deepEqual(await service.deleteCategory(empty.category_id), {
      category_id: empty.category_id,
    });
    assert.equal(repository.archivedCategories.has(empty.category_id), true);
  });

  it("404s unknown folders", async () => {
    const { service } = harness();
    await assert.rejects(
      () => service.updateCategory("missing", { name: "Nope" }),
      isAppError("CATEGORY_NOT_FOUND"),
    );
    await assert.rejects(
      () => service.deleteCategory("missing"),
      isAppError("CATEGORY_NOT_FOUND"),
    );
  });

  it("resolves a legacy label to a real root folder, creating it when new", async () => {
    const { service } = harness();

    const existing = await service.resolveCategoryForWrite({ category: "starters" });
    assert.equal(existing.category_id, "cat-1");

    const created = await service.resolveCategoryForWrite({ category: "Desserts" });
    assert.equal(created.category, "Desserts");
    assert.ok(created.category_id);

    const fallback = await service.resolveCategoryForWrite({});
    assert.deepEqual(fallback, { category_id: null, category: "Main Course" });
  });
});
