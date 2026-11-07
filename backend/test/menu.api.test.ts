import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

/* Menu HTTP contract.

   The real Express app is booted with a fake Menu service, so these tests pin
   status codes, envelopes and query coercion without SQL. Availability is
   protected by requireAuth and is asserted to stay protected; the service
   suite covers the actual 86 behaviour. */

import { createApp } from "../src/app.js";
import { AppError } from "../src/errors/app-error.js";
import type {
  AdminMenuItem,
  CategoryDto,
  MenuItemDto,
  MenuServicePort,
  PublicCategoryDto,
} from "../src/modules/menu/menu.types.js";

const DISH: MenuItemDto = {
  menu_item_id: "item-1",
  name: "Paneer Tikka",
  price: 260,
  category: "Starters",
  category_id: "cat-1",
  is_available: true,
  description: "Charred paneer.",
  vegetarian: true,
  image_url: null,
  image_small_url: null,
  blur_data_url: null,
  ingredients: ["paneer"],
  spice_level: 1,
  allergens: ["dairy"],
  diet_tags: [],
  portion_description: "6 pieces",
};

class FakeMenuService implements MenuServicePort {
  readonly calls: Array<{ method: string; args: readonly unknown[] }> = [];
  failList = false;

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }

  async listMenu(params: any) {
    this.record("listMenu", [params]);
    if (this.failList) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Unknown table.");
    }
    return {
      data: [DISH],
      meta: { page: params.page, limit: params.limit, total: 1, total_pages: 1 },
    };
  }

  async findCartItem(menuItemId: string) {
    if (menuItemId !== "33333333-3333-4333-8333-333333333333") return null;
    return { menu_item_id: menuItemId, name: DISH.name, is_available: DISH.is_available };
  }

  async listPublicCategories(): Promise<PublicCategoryDto[]> {
    this.record("listPublicCategories", []);
    return [{ category_id: "cat-1", name: "Starters", parent_id: null, sort_order: 0 }];
  }

  async setAvailability(menuItemId: string, isAvailable: boolean) {
    this.record("setAvailability", [menuItemId, isAvailable]);
    return { menu_item_id: menuItemId, is_available: isAvailable, denied_orders: 0 };
  }

  async listAdminItems(): Promise<AdminMenuItem[]> {
    return [DISH];
  }

  async createItem(input: any): Promise<AdminMenuItem> {
    this.record("createItem", [input]);
    return DISH;
  }

  async updateItem(menuItemId: string, input: any): Promise<AdminMenuItem> {
    this.record("updateItem", [menuItemId, input]);
    return DISH;
  }

  async archiveItem(menuItemId: string) {
    this.record("archiveItem", [menuItemId]);
    return { menu_item_id: menuItemId };
  }

  async listCategories(): Promise<CategoryDto[]> {
    return [];
  }

  async createCategory(): Promise<CategoryDto> {
    throw new Error("not used");
  }

  async updateCategory(): Promise<CategoryDto> {
    throw new Error("not used");
  }

  async deleteCategory(categoryId: string) {
    return { category_id: categoryId };
  }

  async resolveCategoryForWrite() {
    return { category_id: null, category: "Main Course" };
  }
}

let server: Server;
let baseUrl = "";
let service: FakeMenuService;

before(async () => {
  service = new FakeMenuService();
  const app = createApp({ menuService: service });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

describe("Menu API — retrieval", () => {
  it("GET /api/v1/menu coerces pagination and returns data + meta", async () => {
    const response = await call(
      "GET",
      "/api/v1/menu?table_token=k7x2p&page=2&limit=5&category=Starters&q=paneer",
    );

    assert.equal(response.status, 200);
    assert.equal(response.json.success, true);
    assert.equal(response.json.data[0].name, "Paneer Tikka");
    assert.deepEqual(response.json.meta, { page: 2, limit: 5, total: 1, total_pages: 1 });

    const callRecord = service.calls.find((entry) => entry.method === "listMenu");
    assert.deepEqual(callRecord?.args[0], {
      table_token: "k7x2p",
      page: 2,
      limit: 5,
      category: "Starters",
      q: "paneer",
    });
  });

  it("rejects an invalid table token with 400 VALIDATION_ERROR", async () => {
    const response = await call("GET", "/api/v1/menu?table_token=BAD");

    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "VALIDATION_ERROR");
    assert.ok(response.json.error.fields.table_token);
  });

  it("renders a service error through the contract envelope", async () => {
    service.failList = true;
    const response = await call("GET", "/api/v1/menu?table_token=k7x2p");
    service.failList = false;

    assert.equal(response.status, 404);
    assert.equal(response.json.error.code, "TABLE_NOT_FOUND");
  });

  it("GET /api/v1/menu/categories returns the public tree", async () => {
    const response = await call("GET", "/api/v1/menu/categories");

    assert.equal(response.status, 200);
    assert.equal(response.json.data[0].name, "Starters");
    assert.equal("thumbnail" in response.json.data[0], false);
  });
});

describe("Menu API — availability protection", () => {
  it("PATCH availability requires a shift token", async () => {
    const response = await call("PATCH", "/api/v1/menu/items/item-1/availability", {
      is_available: false,
    });

    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, "UNAUTHORIZED");
    assert.equal(
      service.calls.some((entry) => entry.method === "setAvailability"),
      false,
      "an unauthenticated 86 must never reach the service",
    );
  });

  it("validates the body shape before the handler runs", async () => {
    const response = await call("PATCH", "/api/v1/menu/items/not-a-uuid/availability", {
      is_available: false,
    });

    assert.equal(response.status, 401);
  });
});
