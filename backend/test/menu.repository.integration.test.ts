import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

/* REAL-POSTGRES checks for the Menu module's repository and service.

   Gate: TEST_DATABASE_URL must point at a database with the project schema
   applied (npm run db:setup). Each test creates uniquely named folders/dishes
   and removes them afterwards. */

import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { MenuRepository } from "../src/modules/menu/menu.repository.js";
import { MenuService } from "../src/modules/menu/menu.service.js";
import type { MenuItemRow } from "../src/modules/menu/menu.types.js";
import { AppError } from "../src/errors/app-error.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres menu checks skipped";

function uniqueName(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

interface Harness {
  manager: DatabaseManager;
  service: MenuService;
  repository: MenuRepository;
  categoryIds: string[];
  itemIds: string[];
  denyCalls: Array<{ id: string; name: string }>;
}

async function withHarness<T>(fn: (harness: Harness) => Promise<T>): Promise<T> {
  const manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));

  const repository = new MenuRepository(manager);
  const denyCalls: Array<{ id: string; name: string }> = [];
  const service = new MenuService({
    repository,
    tables: {
      requireTable: async (code) => ({ id: "table-1", code, name: "Window", status: "active" }),
    },
    orders: {
      denyPendingOrdersForItem: async (id, name) => {
        denyCalls.push({ id, name });
        return 0;
      },
    },
    images: {
      toDto: (row) => ({
        image_url: `/img/${row.menu_item_id}`,
        image_small_url: `/img/${row.menu_item_id}/small`,
        blur_data_url: row.blur_data_url,
      }),
    },
  });

  const harness: Harness = {
    manager,
    service,
    repository,
    categoryIds: [],
    itemIds: [],
    denyCalls,
  };

  try {
    return await fn(harness);
  } finally {
    if (harness.itemIds.length > 0) {
      await manager.query("DELETE FROM menu_items WHERE id = ANY($1::uuid[])", [harness.itemIds]);
    }
    if (harness.categoryIds.length > 0) {
      await manager.query("DELETE FROM menu_categories WHERE id = ANY($1::uuid[])", [
        harness.categoryIds,
      ]);
    }
    await manager.shutdown();
  }
}

async function makeCategory(harness: Harness, name: string, parentId: string | null = null) {
  const created = await harness.service.createCategory({ name, parent_id: parentId });
  harness.categoryIds.push(created.category_id);
  return created;
}

async function makeItem(
  harness: Harness,
  categoryId: string,
  overrides: Partial<{ name: string; price: number; description: string }> = {},
) {
  const created = await harness.service.createItem({
    name: overrides.name ?? uniqueName("Dish"),
    price: overrides.price ?? 249.5,
    category_id: categoryId,
    description: overrides.description ?? "Integration description",
    vegetarian: true,
    is_available: true,
    ingredients: ["paneer"],
    spice_level: 1,
    allergens: ["dairy"],
    diet_tags: [],
    portion_description: "serves 1",
  });
  harness.itemIds.push(created.menu_item_id);
  return created;
}

describe("MenuRepository — real Postgres", { skip: skipReason }, () => {
  it("reports the catalogue schema objects as present", async () => {
    await withHarness(async ({ repository }) => {
      const schema = await repository.schemaObjects();
      assert.deepEqual(schema.missing, []);
      assert.deepEqual(schema.present, [
        "menu_items",
        "menu_categories",
        "menu_item_images",
      ]);
    });
  });

  it("persists a folder and a dish with exact description and price", async () => {
    await withHarness(async (harness) => {
      const folder = await makeCategory(harness, uniqueName("Starters"));
      const dish = await makeItem(harness, folder.category_id, {
        price: 249.5,
        description: "  Charred paneer with mint.  ",
      });

      assert.equal(dish.price, 249.5);
      assert.equal(dish.description, "Charred paneer with mint.");
      assert.equal(dish.category, folder.name);
      assert.equal(dish.category_id, folder.category_id);

      const stored = await harness.manager.query<MenuItemRow>(
        "SELECT price::float8 AS price, description FROM menu_items WHERE id = $1",
        [dish.menu_item_id],
      );
      assert.equal(stored.rows[0]?.price, 249.5);

      const page = await harness.service.listMenu({
        table_token: "k7x2p",
        page: 1,
        limit: 100,
        category: folder.name,
      });
      assert.equal(page.meta.total, 1);
      assert.equal(page.data[0]?.menu_item_id, dish.menu_item_id);
    });
  });

  it("86ing and re-stocking change only availability", async () => {
    await withHarness(async (harness) => {
      const folder = await makeCategory(harness, uniqueName("Mains"));
      const dish = await makeItem(harness, folder.category_id);

      const off = await harness.service.setAvailability(dish.menu_item_id, false);
      assert.equal(off.is_available, false);
      assert.deepEqual(harness.denyCalls, [{ id: dish.menu_item_id, name: dish.name }]);

      const on = await harness.service.setAvailability(dish.menu_item_id, true);
      assert.equal(on.is_available, true);
      assert.equal(on.denied_orders, 0);
      assert.equal(harness.denyCalls.length, 1);
    });
  });

  it("archiving hides the dish from both reads but keeps the row", async () => {
    await withHarness(async (harness) => {
      const folder = await makeCategory(harness, uniqueName("Specials"));
      const dish = await makeItem(harness, folder.category_id);

      await harness.service.archiveItem(dish.menu_item_id);

      const admin = await harness.service.listAdminItems();
      assert.equal(admin.some((item) => item.menu_item_id === dish.menu_item_id), false);

      const publicMenu = await harness.service.listMenu({
        table_token: "k7x2p",
        page: 1,
        limit: 100,
        category: folder.name,
      });
      assert.equal(publicMenu.meta.total, 0);

      const row = await harness.manager.query<{ deleted_at: Date | null; is_available: boolean }>(
        "SELECT deleted_at, is_available FROM menu_items WHERE id = $1",
        [dish.menu_item_id],
      );
      assert.ok(row.rows[0]?.deleted_at);
      assert.equal(row.rows[0]?.is_available, false);
    });
  });

  it("refuses duplicate folders, non-empty deletes and folder cycles", async () => {
    await withHarness(async (harness) => {
      const name = uniqueName("Desserts");
      const root = await makeCategory(harness, name);
      const child = await makeCategory(harness, uniqueName("Ice Cream"), root.category_id);
      await makeItem(harness, root.category_id);

      await assert.rejects(
        () => harness.service.createCategory({ name: name.toUpperCase(), parent_id: root.parent_id }),
        (err: unknown) => err instanceof AppError && err.code === "CATEGORY_EXISTS",
      );

      await assert.rejects(
        () => harness.service.deleteCategory(root.category_id),
        (err: unknown) => err instanceof AppError && err.code === "CATEGORY_NOT_EMPTY",
      );

      await assert.rejects(
        () => harness.service.updateCategory(root.category_id, { parent_id: child.category_id }),
        (err: unknown) => err instanceof AppError && err.code === "CATEGORY_CYCLE",
      );
    });
  });
});
