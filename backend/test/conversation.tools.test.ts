import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Tool executors are the AI's only path into the application. These tests pin
   that they call the existing service ports with the caller's table capability
   and never accept a table token from the model. */

import { AppError } from "../src/errors/app-error.js";
import { ConversationToolset } from "../src/modules/conversation/conversation.tools.js";
import type {
  ConversationBusinessPorts,
  ConversationToolContext,
} from "../src/modules/conversation/conversation.types.js";
import { buildMeta } from "../src/lib/util.js";
import {
  CART_ITEM_ID,
  MENU_ITEM_ID,
  TABLE_CODE,
} from "./helpers/conversation-fakes.js";

type Call = { method: string; args: unknown[] };

function business() {
  const calls: Call[] = [];
  const ports = {
    menu: {
      async listMenu(params: unknown) {
        calls.push({ method: "listMenu", args: [params] });
        return {
          data: [
            {
              menu_item_id: MENU_ITEM_ID,
              name: "Masala Dosa",
              price: 180,
              category: "Main Course",
              category_id: null,
              is_available: true,
              description: "",
              vegetarian: true,
              image_url: null,
              image_small_url: null,
              blur_data_url: null,
              ingredients: ["rice"],
              spice_level: 1,
              allergens: [],
              diet_tags: [],
              portion_description: "2 pieces",
            },
          ],
          meta: buildMeta(1, 30, 1),
        };
      },
    },
    cart: {
      async listCart(params: unknown) {
        calls.push({ method: "listCart", args: [params] });
        return {
          data: [
            {
              id: CART_ITEM_ID,
              table_id: "table",
              menu_item_id: MENU_ITEM_ID,
              quantity: 1,
              request_note: "",
              allergy_note: "",
              added_by: "Asha",
            },
          ],
          meta: buildMeta(1, 100, 1),
        };
      },
      async addItem(input: unknown) {
        calls.push({ method: "addItem", args: [input] });
        return {
          id: CART_ITEM_ID,
          table_id: "table",
          menu_item_id: MENU_ITEM_ID,
          quantity: 2,
          request_note: "",
          allergy_note: "",
          added_by: "Asha",
          total_table_quantity: 2,
        };
      },
      async updateItem(id: string, patch: unknown) {
        calls.push({ method: "updateItem", args: [id, patch] });
        return {
          id,
          table_id: "table",
          menu_item_id: MENU_ITEM_ID,
          quantity: 3,
          request_note: "",
          allergy_note: "",
          added_by: "Asha",
          total_table_quantity: 3,
        };
      },
      async removeItem(token: string, id: string) {
        calls.push({ method: "removeItem", args: [token, id] });
        return { id, message: "removed" };
      },
    },
    orders: {
      async fireOrder(token: string) {
        calls.push({ method: "fireOrder", args: [token] });
        return {
          order_id: "order-1",
          table_id: "table",
          status: "pending",
          created_at: "2026-01-01T10:00:00Z",
          message: "routed",
        };
      },
      async listOrders(params: unknown) {
        calls.push({ method: "listOrders", args: [params] });
        return { data: [], meta: buildMeta(1, 10, 0) };
      },
    },
    tables: {
      async requestTableBill(token: string) {
        calls.push({ method: "requestTableBill", args: [token] });
        return {
          table_id: "table",
          bill_status: "requested",
          bill_requested_at: "2026-01-01T10:00:00Z",
        };
      },
    },
  } as unknown as ConversationBusinessPorts;

  return { ports, calls };
}

const context: ConversationToolContext = {
  tableToken: TABLE_CODE,
  participantName: "Asha",
};

describe("conversation tools", () => {
  it("reads the menu with the bound table token", async () => {
    const { ports, calls } = business();
    const tools = new ConversationToolset(ports);

    const result = await tools.execute("get_menu", { query: "dosa" }, context);
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0]?.args[0], {
      table_token: TABLE_CODE,
      page: 1,
      limit: 30,
      q: "dosa",
    });
    assert.equal((result.data as { count: number }).count, 1);
  });

  it("adds a dish with server-bound attribution and table scope", async () => {
    const { ports, calls } = business();
    const tools = new ConversationToolset(ports);

    const result = await tools.execute(
      "add_to_cart",
      { menu_item_id: MENU_ITEM_ID, quantity: 2 },
      context,
    );
    assert.equal(result.ok, true);
    assert.equal(result.mutated, true);
    assert.deepEqual(calls[0]?.args[0], {
      table_token: TABLE_CODE,
      menu_item_id: MENU_ITEM_ID,
      quantity: 2,
      added_by: "Asha",
    });
    assert.deepEqual(result.actions, [
      { kind: "cart", label: "Added 2 item(s) to the table cart", ok: true },
    ]);
  });

  it("updates and removes only through the cart service", async () => {
    const { ports, calls } = business();
    const tools = new ConversationToolset(ports);

    await tools.execute(
      "update_cart_item",
      { cart_item_id: CART_ITEM_ID, quantity: 3 },
      context,
    );
    await tools.execute("remove_cart_item", { cart_item_id: CART_ITEM_ID }, context);

    assert.deepEqual(calls.map((call) => call.method), ["updateItem", "removeItem"]);
    assert.deepEqual(calls[0]?.args, [
      CART_ITEM_ID,
      { table_token: TABLE_CODE, quantity: 3 },
    ]);
    assert.deepEqual(calls[1]?.args, [TABLE_CODE, CART_ITEM_ID]);
  });

  it("fires, reads and bills only through the bound service", async () => {
    const { ports, calls } = business();
    const tools = new ConversationToolset(ports);

    await tools.execute("fire_order", {}, context);
    await tools.execute("get_orders", {}, context);
    const bill = await tools.execute("request_bill", {}, context);

    assert.deepEqual(calls.map((call) => call.method), [
      "fireOrder",
      "listOrders",
      "requestTableBill",
    ]);
    assert.equal(calls[0]?.args[0], TABLE_CODE);
    assert.equal(bill.ok, true);
    assert.deepEqual(bill.actions, [
      { kind: "bill", label: "Asked the floor for the bill", ok: true },
    ]);
  });

  it("turns a business refusal into a tool error and never throws", async () => {
    const { ports } = business();
    ports.cart.addItem = async () => {
      throw new AppError(409, "ITEM_UNAVAILABLE", "That dish just ran out.");
    };
    const tools = new ConversationToolset(ports);

    const result = await tools.execute(
      "add_to_cart",
      { menu_item_id: MENU_ITEM_ID },
      context,
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.data, {
      error: { code: "ITEM_UNAVAILABLE", message: "That dish just ran out." },
    });
  });

  it("rejects unknown tools and invalid arguments", async () => {
    const { ports, calls } = business();
    const tools = new ConversationToolset(ports);

    const unknown = await tools.execute("drop_tables", {}, context);
    assert.equal(unknown.ok, false);
    assert.deepEqual(unknown.data, {
      error: { code: "UNKNOWN_TOOL", message: "Unknown tool: drop_tables" },
    });

    const invalid = await tools.execute("add_to_cart", {}, context);
    assert.equal(invalid.ok, false);
    assert.equal(calls.length, 0);
  });
});
