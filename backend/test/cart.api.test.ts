import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

/* Cart HTTP behaviour through the real app factory: paths, methods, status
   codes and the success envelope are pinned to the legacy contract. */

import { createApp } from "../src/app.js";
import { buildMeta } from "../src/lib/util.js";
import type {
  CartAddInput,
  CartLineWithTotal,
  CartListParams,
  CartRemovalResult,
  CartServicePort,
  CartUpdateInput,
} from "../src/modules/cart/cart.types.js";

const CART_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";

class FakeCartService implements CartServicePort {
  listParams: CartListParams | null = null;
  added: CartAddInput | null = null;
  updated: { id: string; input: CartUpdateInput } | null = null;
  removed: { token: string; id: string } | null = null;

  async listCart(params: CartListParams) {
    this.listParams = params;
    return {
      data: [
        {
          id: CART_ID,
          table_id: "table-1",
          menu_item_id: ITEM_ID,
          quantity: 2,
          request_note: "less spicy",
          allergy_note: "",
          added_by: "Asha",
        },
      ],
      meta: buildMeta(params.page, params.limit, 1),
    };
  }

  async addItem(input: CartAddInput): Promise<CartLineWithTotal> {
    this.added = input;
    return {
      id: CART_ID,
      table_id: "table-1",
      menu_item_id: input.menu_item_id,
      quantity: input.quantity,
      request_note: input.request_note ?? "",
      allergy_note: input.allergy_note ?? "",
      added_by: input.added_by,
      total_table_quantity: input.quantity,
    };
  }

  async updateItem(id: string, input: CartUpdateInput): Promise<CartLineWithTotal> {
    this.updated = { id, input };
    return {
      id,
      table_id: "table-1",
      menu_item_id: ITEM_ID,
      quantity: 4,
      request_note: input.request_note ?? "",
      allergy_note: input.allergy_note ?? "",
      added_by: "Asha",
      total_table_quantity: 4,
    };
  }

  async removeItem(token: string, id: string): Promise<CartRemovalResult> {
    this.removed = { token, id };
    return { id, message: "Line item purged from table cart." };
  }

  async clearCart() {
    return { removed: 0 };
  }
}

let server: Server;
let baseUrl: string;
const service = new FakeCartService();

before(async () => {
  const app = createApp({ cartService: service });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function call(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: response.status, json: (await response.json()) as any };
}

describe("Cart API", () => {
  it("returns the shared cart with pagination metadata", async () => {
    const result = await call("/api/v1/cart/items?table_token=k7x2p&page=2&limit=5");

    assert.equal(result.status, 200);
    assert.equal(result.json.success, true);
    assert.equal(result.json.data.length, 1);
    assert.deepEqual(service.listParams, { table_token: "k7x2p", page: 2, limit: 5 });
  });

  it("adds a line and preserves the request fields", async () => {
    const result = await call("/api/v1/cart/items", {
      method: "POST",
      body: JSON.stringify({
        table_token: "k7x2p",
        menu_item_id: ITEM_ID,
        quantity: 2,
        request_note: "less spicy",
        added_by: "Asha",
      }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.data.quantity, 2);
    assert.equal(result.json.data.total_table_quantity, 2);
    assert.equal(service.added?.added_by, "Asha");
  });

  it("applies absolute and delta updates through the same path", async () => {
    const result = await call(`/api/v1/cart/items/${CART_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ table_token: "k7x2p", quantity_delta: 2 }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.data.quantity, 4);
    assert.deepEqual(service.updated, {
      id: CART_ID,
      input: { table_token: "k7x2p", quantity_delta: 2 },
    });
  });

  it("removes a line", async () => {
    const result = await call("/api/v1/cart/items", {
      method: "DELETE",
      body: JSON.stringify({ table_token: "k7x2p", cart_item_id: CART_ID }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.data.id, CART_ID);
    assert.deepEqual(service.removed, { token: "k7x2p", id: CART_ID });
  });

  it("returns the validation envelope for bad quantities and missing owners", async () => {
    const badQuantity = await call("/api/v1/cart/items", {
      method: "POST",
      body: JSON.stringify({
        table_token: "k7x2p",
        menu_item_id: ITEM_ID,
        quantity: 0,
        added_by: "Asha",
      }),
    });
    assert.equal(badQuantity.status, 400);
    assert.equal(badQuantity.json.error.code, "VALIDATION_ERROR");

    const noOwner = await call("/api/v1/cart/items", {
      method: "POST",
      body: JSON.stringify({
        table_token: "k7x2p",
        menu_item_id: ITEM_ID,
      }),
    });
    assert.equal(noOwner.status, 400);
    assert.equal(noOwner.json.error.code, "VALIDATION_ERROR");
  });

  it("rejects malformed cart-line ids before the service", async () => {
    const result = await call("/api/v1/cart/items/not-a-uuid", {
      method: "PATCH",
      body: JSON.stringify({ table_token: "k7x2p", quantity_delta: 1 }),
    });

    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, "VALIDATION_ERROR");
  });
});
